# EU GPSR fields in the eBay Sell APIs (for a German seller of self-made 3D-printed goods on ebay.de)

Research date: 2026-08-11
Scope: Sell Inventory API v1, Sell Metadata API v1, Sell Account API v1, Commerce Media API, Trading API.

> **Sourcing note.** `developer.ebay.com` timed out on nearly every request during this
> research (2 retries per URL). The field-level facts below therefore come from
> **eBay's own OpenAPI contract as materialised in generated SDKs** (auto-generated from
> eBay's `sell_inventory_v1_oas3.json` / `sell_metadata_v1_oas3.json`, descriptions
> verbatim from eBay), from eBay's Trading API SDK sources, and from eBay's own
> JSON response schemas mirrored in third-party repos. Every claim I could not tie to a
> primary source is flagged in the "Unconfirmed" section — including all error codes.

---

## 0. The single most important correction

**There is no `product.manufacturer` and no `product.regulatory` on the Inventory Item.**

The GPSR data lives on the **Offer**, at the *root* of the offer body, not on the
inventory item and not nested under `product`.

`InventoryItem` has exactly these top-level fields (eBay OAS, `InventoryItem` model):
`availability`, `condition`, `conditionDescription`, `conditionDescriptors`,
`packageWeightAndSize`, `product`. No `regulatory`. No `manufacturer`.

`EbayOfferDetailsWithKeys` (the `createOffer` / `bulkCreateOffer` request body) has
`regulatory` as a top-level property, typed `Regulatory`.

So the correct paths are:

| What | Path | Carried on |
|---|---|---|
| Manufacturer | `regulatory.manufacturer` | Offer |
| EU responsible persons | `regulatory.responsiblePersons[]` | Offer |
| Regulatory documents | `regulatory.documents[]` | Offer |
| Product safety labels | `regulatory.productSafety` | Offer |
| Hazmat labels | `regulatory.hazmat` | Offer |
| Energy label | `regulatory.energyEfficiencyLabel` | Offer |
| Repair index | `regulatory.repairScore` | Offer |

Methods that accept/return `regulatory`: `createOffer`, `updateOffer`,
`bulkCreateOffer`, `getOffer`, `getOffers`.

Practical consequence for a lister app: GPSR data must be re-sent **per offer, per
marketplace**. One SKU listed on `EBAY_DE` and `EBAY_AT` = two offers = two copies of
the same `regulatory` block.

### Do not confuse this with the "Hersteller" item aspect

`product.aspects["Hersteller"]` (and `product.mpn`, `product.brand`) on the **inventory
item** is an eBay *category aspect* on ebay.de and is a completely separate requirement
from `regulatory.manufacturer`. Publish failures reading
*"Das Artikelmerkmal Hersteller fehlt" / "The item characteristic Manufacturer is missing"*
are about the **aspect**, not about GPSR. Both may be required at once.

---

## 1. `regulatory.manufacturer` — exact shape

Type `Manufacturer`. All sub-fields are declared `[optional]` in the schema; eBay
enforces completeness at publish time per category (see §5).

| Field | Type | Max length | Notes |
|---|---|---|---|
| `companyName` | string | 100 | "The company name of the product manufacturer." |
| `addressLine1` | string | 180 | |
| `addressLine2` | string | 180 | Suite/Apt |
| `city` | string | 64 | |
| `stateOrProvince` | string | 64 | |
| `postalCode` | string | **9** | Tight — fine for `12345`, watch non-DE formats |
| `country` | string (`CountryCodeEnum`) | 2 | ISO 3166-1 alpha-2, e.g. `DE` |
| `email` | string | 180 | |
| `phone` | string | 64 | |
| `contactUrl` | string | 250 | Added later as a GPSR contact option |

eBay's own wording (Metadata/Browse docs): *"some leaf categories will start requiring
sellers operating in the EU or Northern Ireland to provide the full mailing address for
the manufacturer and at least one of the following: email address, phone, or contact URL."*

### Real body — `POST /sell/inventory/v1/offer` (createOffer), self-made goods, ebay.de

```json
{
  "sku": "3DP-VASE-001",
  "marketplaceId": "EBAY_DE",
  "format": "FIXED_PRICE",
  "availableQuantity": 5,
  "categoryId": "20518",
  "listingDescription": "Handgefertigte 3D-gedruckte Vase aus PLA.",
  "listingDuration": "GTC",
  "merchantLocationKey": "werkstatt-01",
  "pricingSummary": {
    "price": { "currency": "EUR", "value": "24.90" }
  },
  "listingPolicies": {
    "fulfillmentPolicyId": "6196932000",
    "paymentPolicyId": "6196931000",
    "returnPolicyId": "6196930000"
  },
  "regulatory": {
    "manufacturer": {
      "companyName": "Nils Gäfgen 3D-Werkstatt",
      "addressLine1": "Musterstraße 12",
      "addressLine2": "Hinterhaus",
      "city": "Hamburg",
      "stateOrProvince": "Hamburg",
      "postalCode": "20095",
      "country": "DE",
      "email": "kontakt@example.de",
      "phone": "+49 40 1234567",
      "contactUrl": "https://example.de/kontakt"
    },
    "productSafety": {
      "statements": ["SAFETY_STATEMENT_ID_FROM_METADATA_API"]
    }
  }
}
```

Because the manufacturer here is established in Germany, `responsiblePersons` is
**omitted entirely** (see §7).

---

## 2. `regulatory.responsiblePersons[]` — exact shape

Type `ResponsiblePerson[]`. **Maximum 5 entries.**

Identical address/contact fields to `Manufacturer` — `companyName` (max 100),
`addressLine1`/`addressLine2` (180), `city` (64), `stateOrProvince` (64),
`postalCode` (9), `country` (`CountryCodeEnum`), `email` (180), `phone` (64),
`contactUrl` (250) — **plus**:

| Field | Type | Notes |
|---|---|---|
| `types` | `string[]` (`ResponsiblePersonTypeEnum`) | eBay: *"The type(s) associated with the Responsible Person or entity. **Note:** Currently, the only supported value is `EUResponsiblePerson`."* |

### The enum value is `EUResponsiblePerson`, not `EU_RESPONSIBLE_PERSON`

This is the single easiest thing to get wrong. It is **PascalCase, on the wire**, in both
the REST and SOAP APIs:

- REST (Inventory/Browse): `"types": ["EUResponsiblePerson"]`
- Trading API XML: `<Types><Type>EUResponsiblePerson</Type></Types>`
- eBay's own Java SDK: `@XmlEnumValue("EUResponsiblePerson") EU_RESPONSIBLE_PERSON("EUResponsiblePerson")`
  — the *Java constant* is `EU_RESPONSIBLE_PERSON`, the *serialised value* is `EUResponsiblePerson`.
  Do not ship the constant name.
- The other Trading-API enum member is `CustomCode` (the standard eBay "value not in your
  WSDL version" placeholder — never send it).

### Real body — offer for a product whose manufacturer is outside the EU

```json
{
  "sku": "RESELL-LAMP-042",
  "marketplaceId": "EBAY_DE",
  "format": "FIXED_PRICE",
  "availableQuantity": 3,
  "categoryId": "20697",
  "regulatory": {
    "manufacturer": {
      "companyName": "Shenzhen Example Lighting Co., Ltd.",
      "addressLine1": "88 Example Road, Bao'an District",
      "city": "Shenzhen",
      "stateOrProvince": "Guangdong",
      "postalCode": "518101",
      "country": "CN",
      "email": "support@example.cn",
      "contactUrl": "https://example.cn/contact"
    },
    "responsiblePersons": [
      {
        "companyName": "EU Compliance Partner GmbH",
        "addressLine1": "Beispielallee 3",
        "city": "München",
        "stateOrProvince": "Bayern",
        "postalCode": "80331",
        "country": "DE",
        "email": "rp@eu-compliance-partner.de",
        "phone": "+49 89 9876543",
        "types": ["EUResponsiblePerson"]
      }
    ]
  }
}
```

---

## 3. Everything else under `regulatory`

Full `Regulatory` type (eBay OAS): `documents`, `energyEfficiencyLabel`, `hazmat`,
`manufacturer`, `productSafety`, `repairScore`, `responsiblePersons`.

Note: there is **no `regulatory.statements[]`**. Statements are nested under
`productSafety` and `hazmat`.

### 3.1 `regulatory.documents[]`

```json
"documents": [ { "documentId": "8xtaWG9tOHR..." } ]
```

`documentId` comes from **Commerce Media API** `createDocument`
(`POST /commerce/media/v1_beta/document`), then the bytes go up via `uploadDocument`.
The `createDocument` request carries `documentType` and `languages`. One confirmed
`documentType` value seen in the wild: `INSTRUCTIONS_FOR_USE`.
Removing documents from a live listing is done through `updateOffer`.

### 3.2 `regulatory.productSafety`

```json
"productSafety": {
  "component": "Kippgefahr",
  "pictograms": ["PICTOGRAM_ID_1", "PICTOGRAM_ID_2"],
  "statements": ["STATEMENT_ID_1", "STATEMENT_ID_2"]
}
```

- `component` — free text, **max 120 chars**. eBay: *"Component information can only be
  specified if used with the `pictograms` and/or `statements` field; if the component is
  provided without one or both of these fields, an error will occur."*
- `pictograms` — **max 2**. Values are *identifiers*, not free text. Fetch them from
  Metadata API `getProductSafetyLabels` for the marketplace.
- `statements` — **max 8**. Same: identifiers from `getProductSafetyLabels`.

### 3.3 `regulatory.hazmat`

```json
"hazmat": {
  "component": "Isopropanol",
  "pictograms": ["GHS02"],
  "signalWord": "DANGER",
  "statements": ["H225"]
}
```
(`component`, `pictograms[]`, `signalWord`, `statements[]` — from eBay's own
`getOffer` response schema. Note `hazmat` has `signalWord`; `productSafety` does not.)
Relevant if you ship resins/solvents; not for finished PLA prints.

### 3.4 `regulatory.energyEfficiencyLabel`

```json
"energyEfficiencyLabel": {
  "imageDescription": "On a scale of A to G the rating is E.",
  "imageURL": "https://example.de/labels/eel-123.png",
  "productInformationSheet": "https://example.de/labels/sheet-123.pdf"
}
```
Not applicable to 3D prints.

### 3.5 `regulatory.repairScore`

```json
"repairScore": 7.9
```
Floating point 0.0–10.0, **exactly one decimal place** (`7.9` and `0.0` valid;
`5.645` and `2.10` invalid). eBay warns: *"`0` should not be used as a default value, as
it implies the product is not repairable."* Applicability per category via Metadata API
`getExtendedProducerResponsibilityPolicies`. This is the French repair-index (EPR)
field, not GPSR.

---

## 4. Trading API equivalents (if you ever fall back off the Inventory API)

- `Item.Regulatory.Manufacturer`
- `Item.Regulatory.ResponsiblePersons.ResponsiblePerson` (with `Types/Type` =
  `EUResponsiblePerson`)
- `Item.Regulatory.Documents`, `.ProductSafety`, `.Hazmat`, `.EnergyEfficiencyLabel`
- To wipe responsible persons on Revise/Relist: put `Item.Regulatory.ResponsiblePersons`
  in `DeletedField` **and** omit `ResponsiblePersons` from the request.

Buyer-side (for verifying what actually rendered): Browse API `getItem` returns
`item.manufacturer` and `item.responsiblePersons[]` at the item root.

---

## 5. Mandatory for publishing on EBAY_DE? — Conditional, and it is queryable

eBay's own wording, repeated across the Inventory, Trading and Metadata docs:

> *"As a part of General Product Safety Regulation (GPSR) requirements effective on
> December 13th, 2024, sellers operating in, or shipping to, EU-based countries or
> Northern Ireland are **conditionally required** to provide product manufacturer
> information in their eBay listings. **Manufacturer information is not required for all
> categories.** Use the `getRegulatoryPolicies` method of the Metadata API to return
> metadata on the eBay categories that recommend or require manufacturer-related fields."*

So: **not a blanket requirement on EBAY_DE — it is per leaf category.**

### How to determine it programmatically (do this, don't guess)

`GET /sell/metadata/v1/marketplace/EBAY_DE/get_regulatory_policies?filter=categoryIds:{20518}`

Response shape (`RegulatoryPolicy`):

```json
{
  "regulatoryPolicies": [
    {
      "categoryId": "20518",
      "categoryTreeId": "77",
      "supportedAttributes": [
        { "name": "<RegulatoryAttributeEnum value>", "usage": "REQUIRED" },
        { "name": "<RegulatoryAttributeEnum value>", "usage": "RECOMMENDED" }
      ]
    }
  ]
}
```

- `supportedAttributes[].name` → `RegulatoryAttributeEnum`
- `supportedAttributes[].usage` → `GenericUsageEnum`; eBay: *"indicates whether the
  corresponding attribute is recommended or required for the corresponding leaf category"*
  (i.e. `REQUIRED` / `RECOMMENDED`).

Companion methods: `getProductSafetyLabels` (pictogram + statement IDs),
`getExtendedProducerResponsibilityPolicies` (repair score, eco-fee, take-back).

**Recommended implementation:** cache `getRegulatoryPolicies` per (marketplace, leafCategory)
and gate publish locally, rather than discovering it from a `publishOffer` failure.

### Enforcement reality (secondary sources — see flags)

- Germany's adapted national product-safety law (ProdSG) is reported to have taken full
  effect 19 Feb 2026, and marketplaces including eBay are reported to be blocking
  non-compliant listings.
- Händlerbund reports eBay may deactivate listings and, on repeated violations, act
  against the account.
- A search-result summary attributes to eBay: *"There shouldn't be GPSR-related action at
  an account level, unless a relevant amount of listings will be identified as
  non-compliant or a seller repeatedly violates requirements after suitable warnings."*

---

## 6. Is there an Account API endpoint for a default manufacturer / responsible person?

**No.** Sell Account API v1 exposes only: fulfillment / payment / return policies,
custom policies, rate tables, sales tax, KYC, privileges, programs, subscriptions,
advertising eligibility, onboarding. There is **no** manufacturer or responsible-person
resource in the contract. (Verified against the complete generated model list for
`sell/account/v1`.)

Consequences:

1. **Every offer must carry its own `regulatory` block.** Build it once in your app
   config and inject it into every `createOffer` / `updateOffer` / `bulkCreateOffer`.
2. The closest account-level API construct is **Custom Policies**
   (`POST /sell/account/v1/custom_policy/`, `policyType: PRODUCT_COMPLIANCE`), attached to
   an offer via `listingPolicies.productCompliancePolicyIds` or
   `listingPolicies.regionalProductCompliancePolicies.countryPolicies[]`. But a custom
   policy is a **free-text `description` (max 15,000 chars) + `label`** — it is *not* the
   structured GPSR contact data and does not satisfy the `regulatory` fields.
3. eBay's **Seller Hub UI** does have an account-level store for these contacts:
   "Regulatory contacts and responsible parties"
   (`ebay.de|co.uk|com/help/account/regulatory/regulatory-contacts-responsible-parties?id=5480`),
   with individual and bulk application to listings. It is a UI feature; I found no API
   surface for it, and I could not confirm whether values saved there are auto-applied to
   offers created through the Inventory API. **Assume they are not.**

---

## 7. Does making the product yourself make you the manufacturer? (the key question here)

**Yes — and it removes the need for a separate EU responsible person.**

**GPSR Art. 3, definition of manufacturer** (Regulation (EU) 2023/988), verbatim:

> "any natural or legal person who manufactures a product or has a product designed or
> manufactured, and markets that product under that person's name or trademark"

A German seller who prints goods and sells them under their own name on ebay.de meets
this definition squarely. You are the manufacturer.

**GPSR Art. 16** requires an economic operator established in the Union to be responsible
for the Art. 4(3) tasks of Regulation (EU) 2019/1020. UK Government guidance on the same
Regulation (applied in NI) states the ordering plainly:

> "The responsible economic operator will be: The manufacturer, when it is established in
> the EU or NI. An authorised representative, when one is appointed by the manufacturer.
> The importer, when the manufacturer is not established in NI or the EU and there is no
> authorised representative. A fulfilment service provider, when there is no manufacturer,
> authorised representative or importer established in the EU or NI."

An EU-established manufacturer is therefore its own responsible person.

### What this changes in the API payload

| | Value |
|---|---|
| `regulatory.manufacturer` | **Fill it with your own business identity** — legal/company name, full German street address, `country: "DE"`, plus email and/or phone and/or contactUrl. |
| `regulatory.responsiblePersons` | **Omit the array entirely.** Do not self-populate it with your own details "to be safe" — the field models a *distinct* EU representative for a non-EU manufacturer. |

eBay's own field docs match this: responsible-person data is required *"if the manufacturer
provided through the manufacturer container is not based in an EU country or Northern
Ireland."*

### What being the manufacturer *adds* (outside the API)

Being the manufacturer is a heavier legal role than being a reseller. Beyond the listing
fields, GPSR Art. 9 imposes manufacturer duties — internal risk analysis, technical
documentation, and marking the product/packaging with your name, registered trade name or
trademark, postal and electronic address and a single contact point. Art. 19 (distance
sales) requires the *offer itself* to show manufacturer name + postal + electronic address,
product identifiers including a picture, and any warnings/safety information.

**This section is a reading of the regulation, not legal advice.** See §9 — the Art. 16
and Art. 19 verbatim text could not be retrieved from EUR-Lex in this session.

---

## 8. Recommended implementation for the lister

```
1. Store ONE manufacturer profile in app config (your own business details).
2. On each publish:
   a. leafCategoryId  ← Taxonomy API getCategorySuggestions
   b. policies        ← Metadata API getRegulatoryPolicies(EBAY_DE, filter=categoryIds:{leaf})
                        cache per (marketplace, category), TTL ~30 days
   c. if any supportedAttributes[].usage == "REQUIRED" for a manufacturer/safety
      attribute → assert local data present, else fail fast with your own message
   d. if productSafety statements/pictograms are required
      → resolve IDs via Metadata API getProductSafetyLabels(EBAY_DE)
   e. createOffer with regulatory.manufacturer (+ productSafety), NO responsiblePersons
   f. publishOffer
3. On updateOffer: resend the FULL regulatory block — this API replaces, it does not merge.
4. Independently: fill product.aspects["Hersteller"] / product.brand / product.mpn on the
   inventory item. Different requirement, same word.
```

---

## 9. Unconfirmed / flagged

These are stated explicitly so nothing here is mistaken for verified fact.

**Legal-adjacent, could not confirm from primary source:**

1. **Verbatim text of GPSR Art. 16(1) and 16(2)(a)–(d).** EUR-Lex responses truncated
   before Art. 16 on every attempt. The ordering above is from UK Government guidance
   (secondary, and written for NI) plus consistent secondary sources. Verify against the
   Official Journal before relying on it.
2. **Verbatim text of GPSR Art. 19** (distance-sales offer content). Only paraphrases
   obtained. The four-item list (manufacturer contact / RP where manufacturer is non-EU /
   product identification incl. picture / warnings) is consistently reported but not quoted
   from the OJ here.
3. **Verbatim GPSR Art. 9** manufacturer obligations — paraphrase from UK Government
   guidance only.
4. **"A German manufacturer needs no separate EU responsible person"** is a legal
   conclusion. It follows directly from Art. 3 + Art. 16 as described, and eBay's field
   documentation is consistent with it, but this is not legal advice. A 3D-printed product
   may also fall under sector-specific EU law (e.g. toys → EN 71 / Toy Safety Directive;
   anything electrical → LVD/EMC; anything food-contact → 1935/2004) with its *own*
   responsible-person and conformity rules that GPSR does not displace. Not researched here.
5. **Whether eBay itself blocks/deactivates non-compliant ebay.de listings, and on what
   timeline.** Reported by Händlerbund and German trade press; eBay's own policy pages
   (`ebay.de/verkaeuferportal/...`, `ebay.com/sellercenter/resources/general-product-safety-regulation`,
   help article id=5480) all timed out and could not be read directly.
6. **ProdSG (German national implementation) effective 19 Feb 2026** and the quoted fine
   ranges (up to €10,000 / €100,000) — single secondary source, unverified.

**Technical, unconfirmed:**

7. **Exact publishOffer error for missing GPSR data — NOT CONFIRMED.**
   - Error `25118` with text approximately *"Seller must provide at least one form of
     contact info for Manufacturer - either address, email"* appeared only in a search-engine
     summary. It does **not** appear in any eBay error reference I could open. Treat as a
     lead, not a fact.
   - Error `25002` (`domain: API_INVENTORY`, "A user error has occurred") is eBay's generic
     publish-validation error; the specific cause arrives in `errors[].parameters` /
     `longMessage`. The observed German instance *"Das Artikelmerkmal Hersteller fehlt"* is
     the **item aspect**, not `regulatory.manufacturer`.
   - **Action:** capture the real error body from a sandbox publish without `regulatory`
     and record it here.
8. **`RegulatoryAttributeEnum` exact member strings** (what appears in
   `supportedAttributes[].name`). Not present in any generated SDK — eBay ships it as a
   docs-only enum. Read them off a live `getRegulatoryPolicies` call.
9. **`GenericUsageEnum` members** — described by eBay as "recommended or required";
   `REQUIRED` / `RECOMMENDED` is the near-certain spelling but not read from the enum page.
10. **Full `documentType` enum for Media API `createDocument`.** Only `INSTRUCTIONS_FOR_USE`
    confirmed (from a community post). Also note an unresolved community report of
    `createDocument` returning HTTP 500.
11. **Whether Seller-Hub-saved regulatory contacts propagate to Inventory-API-created
    offers.** Unverified; assume no.
12. **Whether `EBAY_DE` requires `regulatory.manufacturer` for the specific 3D-print
    categories you will use.** Category-dependent by design — must be resolved with
    `getRegulatoryPolicies` per leaf category. Do not hardcode.

---

## 10. Sources

Primary (eBay contract / eBay-authored text):
- eBay `sell/inventory/v1` OpenAPI models `Regulatory`, `Manufacturer`, `ResponsiblePerson`,
  `ProductSafety`, `Document`, `EnergyEfficiencyLabel`, `InventoryItem`,
  `EbayOfferDetailsWithKeys` (generated SDK, descriptions verbatim from eBay):
  https://github.com/quarterdeck-io/eeeeee-bay/tree/main/src/generated/sellInventoryV1/docs
- eBay `getOffer` JSON response schema incl. full `regulatory` block with `hazmat`:
  https://github.com/CMS365-PTY-LTD/EbaySharp/blob/master/EbaySharp/Schemas/Develop/Selling%20Apps/Listing%20Management/Inventory/Offer/getOffer.json
- eBay official Trading API Java SDK, `ResponsiblePersonCodeType` (`EUResponsiblePerson`, `CustomCode`):
  https://github.com/eBay/trading-api-java-sdk/blob/main/source/core/src/com/ebay/soap/eBLBaseComponents/ResponsiblePersonCodeType.java
- eBay Trading API `RegulatoryType` docs text (GPSR note + `getRegulatoryPolicies` pointer),
  mirrored: https://github.com/Nogrod/ebay-sdk-php/blob/master/src/Trading/RegulatoryType.php
- eBay `sell/metadata/v1` models `RegulatoryPolicy`, `RegulatoryAttribute`:
  https://github.com/Nogrod/ebay-sell-metadata-php-sdk/blob/master/docs/Model/RegulatoryAttribute.md
- eBay `sell/account/v1` complete model list (proves absence of GPSR resources):
  https://github.com/quarterdeck-io/eeeeee-bay/tree/main/src/generated/sellAccountV1/docs
- eBay Listing Creation guide (Trading `Item.Regulatory.*` paths, `getRegulatoryPolicies` usage),
  mirrored: https://github.com/acdc-digital/elvato/blob/main/.docs/ebay/listing-creation.md
- eBay Inventory API reference pages (timed out, titles/snippets only):
  https://developer.ebay.com/api-docs/sell/inventory/types/slr:Regulatory ,
  https://developer.ebay.com/api-docs/sell/inventory/types/slr:ResponsiblePerson ,
  https://developer.ebay.com/api-docs/sell/inventory/static/release-notes.html
- eBay Media API document workflow:
  https://developer.ebay.com/api-docs/sell/static/inventory/managing-document-media.html (timed out)
- eBay help, account-level regulatory contacts:
  https://www.ebay.de/help/account/regulatory/regulatory-contacts-responsible-parties?id=5480 (timed out)

Legal:
- Regulation (EU) 2023/988, EUR-Lex (Art. 3 definition retrieved; Art. 16/19 truncated):
  https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R0988
- UK Government, "EU Regulation 2023/988 on general product safety: detailed guidance"
  (Art. 16 ordering, Art. 9 manufacturer duties):
  https://www.gov.uk/government/publications/general-product-safety-regulations-northern-ireland/eu-regulation-2023988-on-general-product-safety-detailed-guidance

Secondary / vendor:
- Händlerbund, "GPSR auf eBay umsetzen":
  https://www.haendlerbund.de/de/ratgeber/recht/gpsr-ebay-produktsicherheitsverordnung
- eBay community, error 25002 "Das Artikelmerkmal Hersteller fehlt":
  https://community.ebay.com/forum/account-inventory-catalog-and-compliance-57960/topic/stuck-on-publishing-ebay-offer-error-25002-missing-manufacturer-after-successful-creation-468323/
- eBay community, `createDocument` HTTP 500:
  https://community.ebay.com/t5/RESTful-Sell-APIs-Account/Attempts-to-create-a-document-for-GPSR-results-in-HTTP-Status/td-p/34892933
- M2E Cloud eBay GPSR guide: https://docs.m2ecloud.com/docs/ebay-gpsr-compliance-guide/
- WP-Lister for eBay (working `EUResponsiblePerson` Trading API implementation):
  https://github.com/WordPressBugBounty/plugins-wp-lister-for-ebay/blob/main/wp-lister-for-ebay/classes/listings/Listing.php
