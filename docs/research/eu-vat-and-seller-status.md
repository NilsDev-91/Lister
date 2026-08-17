# EU VAT & Seller Status — eBay Sell APIs and Etsy Open API v3

Research for a small German seller listing 3D-printed goods.
Date of research: 2026-08-11.

> **Not tax or legal advice.** This document reports (a) what the two APIs
> actually expose as fields, and (b) what the platforms document as required.
> Every claim that depends on German or EU law rather than on API surface is
> marked **[LEGAL — UNCONFIRMED]** and must be checked with a Steuerberater.

---

## 0. Method and source-access caveat

**Read this before trusting the eBay quotes below.**

`developer.ebay.com` could not be fetched directly during this research. Every
attempt returned either a 60s timeout (via the fetch tool) or **HTTP 403 with an
eBay error page** (via `curl`, with and without a browser User-Agent).
`web.archive.org` was also unavailable. So eBay's doc text was **not** read from
the primary source.

Instead, eBay's field descriptions were recovered from **six independently
generated SDKs** that are code-generated from eBay's official OpenAPI contract
(`sell_inventory_v1_oas3`). The description strings are **byte-identical across
all six repos**, including eBay's own HTML markup (`<strong>`, `<br><br>`,
`class="tablenote"`) and internal doc links (`/api-docs/sell/...`). That is
strong evidence the strings are verbatim eBay contract text, but they are
**mirrors, not the primary source**, and may lag the live contract.

SDK versions seen: Inventory API OpenAPI **1.18.4** (quarterdeck-io mirror) and
an older revision (sapientpro mirror). Confirm against the live docs before
shipping.

Etsy, by contrast, **was** read from the primary source: the official OpenAPI
spec at `https://www.etsy.com/openapi/generated/oas/3.0.0.json` (901 KB) was
downloaded and parsed programmatically. Etsy claims below are high-confidence.
`help.etsy.com` returned 403 and was covered via search summaries only.

---

## 1. The eBay Offer `tax` object

### 1.1 Where it lives

`tax` is a container on the **Offer**, not on the InventoryItem. It appears in
`EbayOfferDetailsWithKeys` (`createOffer`, `bulkCreateOffer`),
`EbayOfferDetailsWithId` (`updateOffer`) and `EbayOfferDetailsWithAll`
(`getOffer`). It is **optional** — `Tax` has no required members.

```
POST /sell/inventory/v1/offer
{
  "sku": "...",
  "marketplaceId": "EBAY_DE",
  "format": "FIXED_PRICE",
  "tax": {
    "applyTax": true,
    "thirdPartyTaxCategory": "WASTE_RECYCLING_FEE",
    "vatPercentage": 19.0
  }
}
```

### 1.2 Container description (verbatim)

> This container is only applicable and used if a sales tax table, a Value-Added
> Tax (VAT) rate, or a tax exception category code will be applied to the offer.
> **Only Business Sellers can apply VAT to their listings.** It is possible that
> the `applyTax` field will be included with a value of `true`, but a buyer's
> purchase will not involve sales tax. A sales tax rate must be set up in the
> seller's sales tax table for the buyer's state/tax jurisdiction in order for
> that buyer to be subject to sales tax. Sales tax rates for different
> jurisdictions can be added/modified in the Payment Preferences section of My
> eBay, or the seller can use the sales tax calls of the **Account API**.

(Emphasis added.)

### 1.3 The three fields

#### `applyTax` — boolean

**This is the US-style sales-tax-table switch. It is NOT a VAT switch.**

> This field will be included and set to `true` if the seller would like to
> reference their account-level Sales Tax Table to calculate sales tax for an
> order. A seller's Sales Tax Table can be created and managed manually in My
> eBay's Payment Preferences. This Sales Tax Table contains all tax
> jurisdictions for the seller's country (individual states and territories in
> US), and the seller can set the sales tax rate for these individual tax
> jurisdictions. […] Note that a seller can enable the use of a sales tax table,
> but if a sales tax rate is not specified for the buyer's state/tax
> jurisdiction, sales tax will not be applied to the order. If a
> `thirdPartyTaxCategory` value is used, the `applyTax` field must also be used
> and set to `true`.

Managed via Account API: `getSalesTaxTable`, `getSalesTaxTableEntry`,
`createSalesTaxTableEntry`, `deleteSalesTaxTableEntry`.

**Critical:** `applyTax` and `vatPercentage` are *orthogonal*. `applyTax: false`
does **not** mean "no VAT" — it means "do not consult my sales tax table."
There is no documented interaction between the two.

#### `thirdPartyTaxCategory` — string

> The tax exception category code. If this field is used, sales tax will also
> apply to a service/fee, and not just the item price. This is to be used only
> by sellers who have opted into sales tax being calculated by a sales tax
> calculation vendor. If you are interested in becoming a tax calculation vendor
> partner with eBay, contact developer-relations@ebay.com. One supported value
> for this field is `WASTE_RECYCLING_FEE`. If this field is used, the `applyTax`
> field must also be used and set to `true`.

**Irrelevant for a small German seller.** It is gated behind a partner program
for third-party tax-calculation vendors. Do not send it.

#### `vatPercentage` — number (decimal)

> This value is the Value Add Tax (VAT) rate for the item, if any. When a VAT
> percentage is specified, the item's VAT information appears on the listing's
> View Item page. In addition, the seller can choose to print an invoice that
> includes the item's net price, VAT percent, VAT amount, and total price. Since
> VAT rates vary depending on the item and on the user's country of residence, a
> seller is responsible for entering the correct VAT rate; **it is not calculated
> by eBay**. To use VAT, a seller must be a **business seller with a VAT-ID
> registered with eBay**, and must be listing the item on a **VAT-enabled site**.
> Max applicable length is 6 characters, including the decimal (e.g., 12.345).
> The scale is 3 decimal places. (If you pass in 12.3456, eBay may round up the
> value to 12.346).

Three hard preconditions for `vatPercentage` to be accepted:
1. account is a **business seller** (gewerblicher Verkäufer),
2. a **VAT-ID (USt-IdNr.) is registered with eBay** on the account,
3. the marketplace is **VAT-enabled** (`EBAY_DE` is).

### 1.4 When a German seller sets `vatPercentage: 19` vs omits `tax`

| Situation | `tax` object |
|---|---|
| Business seller, USt-pflichtig, USt-IdNr. filed with eBay, standard-rate goods | `{"vatPercentage": 19.0}` |
| Business seller, Kleinunternehmer §19 UStG (charges no VAT) | **Omit `tax` entirely** — see §2 |
| Private seller (Privatverkäufer) | **Omit `tax` entirely** — VAT is not available to the account at all |
| Any German seller who is not using a US sales tax table | Never send `applyTax` |
| Any seller not a registered tax-calculation vendor | Never send `thirdPartyTaxCategory` |

Note eBay does not calculate VAT. `vatPercentage` is **display + invoice
metadata**: it drives the VAT block on the View Item page and the net/VAT/gross
split on the invoice. The listing price you send in `pricingSummary.price` is
the **gross** price either way; setting `vatPercentage` does not add tax on top.

**[LEGAL — UNCONFIRMED]** Whether 19% (Regelsteuersatz) or 7% (ermäßigt) applies
to a specific 3D-printed good is a classification question. Plain 3D-printed
plastic articles are ordinarily standard-rated, but confirm per product.

---

## 2. Kleinunternehmerregelung (§19 UStG)

### What the API should send: omit the `tax` object entirely.

Reasoning from the API surface (not from tax law):

- `Tax` has **no field that expresses "this sale is VAT-exempt."** There is no
  `vatExempt`, no `smallBusiness` flag, no zero-rate enum.
- `applyTax: false` is **not** the right lever. It refers to the US sales tax
  table, and its default behaviour (absent) is already "do not use the tax
  table." Sending `applyTax: false` is semantically meaningless noise on
  `EBAY_DE` and does not communicate VAT exemption.
- The container doc says it is *"only applicable and used if a sales tax table, a
  VAT rate, or a tax exception category code **will be** applied to the offer."*
  For a Kleinunternehmer none of the three applies → the container is not
  applicable → omit it.
- `vatPercentage: 0` is **not documented** by eBay as a Kleinunternehmer
  representation, and the field is gated on having a VAT-ID registered with
  eBay, which a Kleinunternehmer typically does not have. Sending `0` risks
  either a validation error or a "0% VAT" display on the listing, which is a
  *different* statement than "no VAT shown because §19 UStG."

**Decision: send no `tax` object. Do not send `applyTax: false`. Do not send
`vatPercentage: 0`.**

### What appears on the listing

With `tax` omitted: **no VAT block at all** on the View Item page. eBay shows
the price without any "inkl. MwSt." / VAT-rate annotation. That is the desired
outcome for a Kleinunternehmer, who may not show a separate VAT amount.

**[LEGAL — UNCONFIRMED]** German practice (per Händlerbund / IT-Recht-Kanzlei
commentary, not per eBay documentation) is that a Kleinunternehmer should add a
note such as *"Gem. § 19 UStG wird keine Umsatzsteuer ausgewiesen"* to the
listing. If so, that text goes in `listingDescription` (and/or the
Impressum/Verkäuferangaben in account settings) — **there is no structured API
field for it.** Third-party sources actively contradict each other on whether
the eBay UI's MwSt checkbox should be ticked at 0% or left off; eBay itself
publishes no API guidance on §19 UStG. **Confirm with a Steuerberater.**

---

## 3. eBay: Privatverkäufer vs gewerblicher Verkäufer

### The Sell (REST) APIs do not expose it. It is an account setting.

| API | Field | Direction | Notes |
|---|---|---|---|
| Sell Inventory v1 | *(none)* | — | No seller-type field anywhere in the Offer or InventoryItem model |
| Sell Account v1 `getPrivileges` | `sellerRegistrationCompleted` (bool), `sellingLimit` | **read** | Registration *completeness* only — not private-vs-business |
| Trading (XML) `GetUser` | `SellerInfo.SellerBusinessType` — `Commercial` \| `Private` \| `Undefined` | **read-only** | The only place the status is legible |
| Trading (XML) `GetItem` | `Item.SellerVATDetails` / `VATDetails` — `BusinessSeller`, `VATID`, `VATPercent`, `VATSite`, `RestrictedToBusiness` | **read** on Get | On `AddItem`/`ReviseItem` a business seller can set `VATDetails.VATPercent` and `RestrictedToBusiness` |

So: **status is set by the human in eBay account settings** (Konto →
Verkäuferkonto → gewerblich/privat, plus USt-IdNr. and Impressum). The API can
only *observe* it, and only via the legacy Trading API.

### Does it change which listing fields are required?

Yes, indirectly — three effects:

1. **`tax.vatPercentage` is business-only.** *"Only Business Sellers can apply
   VAT to their listings."* A private account sending `vatPercentage` should
   expect rejection.
2. **`regulatory` (GPSR) and EPR obligations attach to business sellers.** See
   §5 and §6.
3. **Business Policies opt-in is required for the Inventory API regardless of
   type:** *"It is required that the seller be opted into Business Policies
   before being able to create live eBay listings through the Inventory API."*
   (via `listingPolicies`; opt in through My eBay or Account API
   `optInToProgram`.)

Otherwise the Offer schema is identical. There is no branch in the request body.

### ⚠ Gotcha: `hideBuyerDetails` is NOT the private-seller flag

`EbayOfferDetailsWithKeys.hideBuyerDetails` reads:

> This field is included and set to `true` if the seller wishes to create a
> **private listing**. Sellers may want to use this option when they believe
> that a listing's potential bidders/buyers would not want their obfuscated user
> IDs (and feedback scores) exposed to other users.

That is **anonymised bidder display**, unrelated to Privatverkäufer status. Do
not map "private seller" onto this field.

---

## 4. Etsy: VAT and `is_taxable`

### 4.1 `is_taxable` is the only per-listing tax lever. There is no VAT field.

Verified by parsing the full official OpenAPI spec. Across all 78 endpoints,
the complete set of tax-ish property names is:

```
is_taxable      non_taxable     total_tax_cost     total_vat_cost
```
(plus `taxonomy_id` / `*TaxonomyNode*`, which are the product-category tree and
have nothing to do with tax.)

**Writable, per listing** — `createDraftListing` (`POST
/v3/application/shops/{shop_id}/listings`) and `updateListing` (`PATCH
/v3/application/shops/{shop_id}/listings/{listing_id}`):

- **`is_taxable`** (boolean) — verbatim: *"When true, applicable
  [shop](/documentation/reference#tag/Shop) tax rates apply to this listing at
  checkout."*

**Read-only, in responses** (`ShopListing`, `ShopListingWithAssociations`):

- **`non_taxable`** (boolean) — *"When true, applicable shop tax rates do not
  apply to this listing at checkout."* Inverse mirror of `is_taxable`; not
  settable.

**Read-only, on receipts** (`ShopReceipt`):

- **`total_tax_cost`** (Money), **`total_vat_cost`** (Money) — *"A number equal
  to the total value-added tax (VAT) of the receipt."*

**Read-only, buyer-facing price** (`ListingBuyerPrice`, only on
`/v3/application/listings/batch`, requires the `buyer_country` query param):

- `buyer_price.base_price` — *"The pre-discount listing price with VAT applied,
  excluding shipping."*
- `buyer_price.shipping_cost` — *"Includes VAT where applicable."*
- `buyer_country` param — *"The ISO 3166-1 alpha-2 country code (e.g., GB, DE).
  Used for buyer-facing price calculations (VAT, inclusive shipping)."*

### 4.2 The "shop tax rates" that `is_taxable` refers to are NOT settable via API

There is **no** `/shops/{shop_id}/tax*` endpoint. The full path list contains
nothing for tax rates, tax settings, or VAT registration. Shop tax rates are
configured **only in Shop Manager → Finances**, and the VAT ID **only** in Shop
Manager → Finances → VAT ID.

Also note: Etsy's shop tax-rate feature is primarily a **US sales-tax** feature.
There is no per-listing VAT-rate concept for a German seller — nothing
equivalent to eBay's `vatPercentage`.

**Practical consequence:** for a German seller, `is_taxable` is close to a no-op
and there is nothing to configure per listing. Prices sent to Etsy are gross.

### 4.3 Does Etsy collect EU VAT as a marketplace facilitator for a German seller?

**Short answer: for a German seller shipping physical goods from Germany to EU
buyers — generally no. The seller stays responsible.** [LEGAL — UNCONFIRMED]

What Etsy's own help pages document (retrieved via search; `help.etsy.com`
returned 403 to direct fetch):

- **Digital items, EU sellers** — Etsy **does** collect and remit. *"Etsy has
  decided to collect and remit VAT on behalf of Etsy sellers based in European
  Union countries who are providing digital goods."*
- **Physical items imported into the EU** — Etsy collects VAT at checkout when
  the order is a physical item **from outside the EU** with package value
  **≤ €150** (IOSS). UK equivalent: ≤ £135.
- **Physical items, EU seller → EU buyer** — **not** in Etsy's collection scope.
  The €150 rule is an *import* rule; a domestic German sale does not trigger it.
- **Seller fees** — separate matter. If you add your VAT ID, Etsy does not charge
  VAT on seller fees (reverse charge); you get a monthly no-VAT invoice.
- **VAT ID may become mandatory:** *"If you're located in the EU and your gross
  sales meet or exceed the local threshold in the calendar year, Etsy requires
  that you add your taxpayer name and VAT ID to your Etsy shop in order for you
  to continue selling."* German sellers may also be asked to upload a German VAT
  certificate.

**[LEGAL — UNCONFIRMED]** The deemed-supplier / Marktplatzhaftung rules (§3
Abs. 3a UStG, EU DAC7-era marketplace rules) apply mainly to non-EU-established
sellers and to imports ≤ €150. A German-established seller shipping from Germany
is normally outside them, meaning Etsy does **not** become the deemed supplier
and the seller remains liable for German VAT. **This is exactly the kind of
claim to verify with a Steuerberater — do not build billing logic on it.**

3D-printed goods are physical, so the digital-goods carve-out does not help you.

---

## 5. GPSR (General Product Safety Regulation)

### 5.1 Etsy: **no API support at all.** Shop Manager UI only.

Verified against the full OpenAPI spec. Keyword hit counts across the entire
901 KB document:

| keyword | occurrences |
|---|---|
| `gpsr` | **0** |
| `safety` | **0** |
| `compliance` | **0** |
| `responsible` | 1 — and it is `carrier_name`: *"the carrier/company **responsible** for delivering the shipment"* |
| `producer` | **0** |
| `manufactur*` | **0** |

**There is no endpoint and no field for GPSR responsible-person data in the Etsy
Open API v3.** Etsy's public roadmap/spec exposes nothing.

Etsy *does* require the data — just not through the API. Per Etsy Help and the
Seller Handbook, it is entered in the UI in two places (either is sufficient):

- **Shop level:** Shop Manager → Settings → *Partners you work with*
  (also described as a Legal & Compliance section). Use if one EU Responsible
  Person covers the whole shop.
- **Listing level:** the listing editor's **"EU product compliance"** section.
  Use if different products have different compliance partners.

**Implementation impact:** a listing created through the API cannot carry GPSR
data. If GPSR applies to your products, either set the **shop-level** Responsible
Person once in Shop Manager so it covers all API-created listings, or accept a
manual UI step per listing. The shop-level route is the only one compatible with
full automation.

**[LEGAL — UNCONFIRMED]** Whether a German seller manufacturing and shipping
from Germany needs a separate "EU Responsible Person" at all — a German
manufacturer established in the EU is typically its own responsible economic
operator — is a legal question. Etsy's own UI still asks for the data.

### 5.2 eBay: **fully supported via the API**, in `offer.regulatory`

eBay went the opposite way. The Offer carries a `regulatory` container:

```jsonc
"regulatory": {
  "responsiblePersons": [ { /* ResponsiblePerson */ } ],  // max 5
  "productSafety":        { /* ProductSafety */ },
  "manufacturer":         { /* Manufacturer */ },
  "documents":            [ { /* Document */ } ],
  "energyEfficiencyLabel":{ /* … */ },
  "hazmat":               { /* … */ },
  "repairScore":          7.9   // 0.0–10.0, one decimal place
}
```

`regulatory.responsiblePersons` (verbatim):

> This container provides information about the EU-based Responsible Persons or
> entities associated with the listing. A maximum of 5 EU Responsible Persons
> are supported. **Note:** As a part of General Product Safety Regulation (GPSR)
> requirements effective on **December 13th, 2024**, sellers operating in, or
> shipping to, EU-based countries or Northern Ireland are conditionally required
> to provide regulatory Responsible Persons information in their eBay listings.

`regulatory.documents` carries the same GPSR note.

**`ResponsiblePerson` fields** — *"This type provides information, such as name
and contact details, for an EU-based Responsible Person or entity, associated
with the product."* All strings, all optional at the schema level:

| field | max length |
|---|---|
| `companyName` | 100 |
| `addressLine1` | 180 |
| `addressLine2` | 180 |
| `city` | 64 |
| `stateOrProvince` | 64 |
| `postalCode` | 9 |
| `country` | ISO 3166-1 alpha-2 (`CountryCodeEnum`) |
| `email` | 180 |
| `phone` | 64 |
| `contactUrl` | 250 |
| `types` | array — *"Currently, the only supported value is `EUResponsiblePerson`."* |

Note the older SDK mirror still carries a stale container comment (*"will not be
available until March 1, 2023 … hazardous material related information and the
repair score"*). The 1.18.4 mirror's field-level docs are current.

`repairScore` is category-dependent — check
`getExtendedProducerResponsibilityPolicies` (Sell **Metadata** API) for
applicability. `0` is meaningful ("not repairable"), so do not default it.

---

## 6. Verpackungsgesetz / LUCID, and WEEE / ElektroG

### 6.1 LUCID: account setting on both platforms. Not an API field. ✅ answered

**eBay — and this is the important find.** The Offer *does* have an
`extendedProducerResponsibility` container, and it looks like the right place
for EPR IDs. **It is deprecated for this purpose.** Every ID field carries this
verbatim warning:

> **Note: DO NOT USE THIS FIELD.** Extended Producer Responsibility IDs will no
> longer be set at the listing level. Instead, sellers will provide these IDs at
> the account level when applicable/required. **There are no current plans to
> support these IDs at the account level through an API**, so sellers must
> provide and update these IDs through their eBay account.

That applies to `producerProductId`, `productPackageId`, `shipmentPackageId` and
`productDocumentationId`.

The one field in that container **not** deprecated is `ecoParticipationFee`
(an `Amount`, minimum 0.0) — *"the fee paid for new items to the
eco-organization (for example, 'eco-organisme' in France)."* That is a French
market feature, not German.

The container itself is also narrowly scoped: *"supported by a limited number of
sites and specific categories"* — check
`getExtendedProducerResponsibilityPolicies` (Metadata API) per marketplace.

→ **eBay: enter the LUCID number in eBay account settings** (Mein eBay → Konto →
*Angaben zum Unternehmen*). eBay has been legally obliged to enforce VerpackG
compliance since 1 July 2022 and gates listing on it. **Nothing to send in
`createOffer`.**

**Etsy — no LUCID/EPR field exists at all.** Spec keyword counts: `LUCID` 0,
`EPR` 0 (the 78 apparent hits were substring noise inside "prEPRocessing"-style
words like `personalization` and `TaxonomyNodeProperties`), `producer` 0,
`packaging` 0. Configure in Shop Manager only.

### 6.2 WEEE / ElektroG — confirmed not applicable to plain plastic prints

Correct as you suspected. ElektroG/WEEE covers *Elektro- und Elektronikgeräte*.
A plain 3D-printed plastic article has no electrical or electronic function and
falls outside its scope. **[LEGAL — UNCONFIRMED]** — this is a scope judgement,
not an API fact.

API surface either way:
- **Etsy:** no WEEE field. Spec hits for `weee`: **0**.
- **eBay:** no WEEE-specific listing field. Would fall under the same
  account-level EPR mechanism as LUCID, per the "DO NOT USE THIS FIELD" note.

⚠ **This changes the moment you add electronics.** An LED, a battery, a motor, a
USB port, or bundling a print with any powered component pulls the product into
ElektroG (and battery-law BattG), each with its own register and
account-level registration number. Re-check before shipping any lit or powered
variant.

---

## 7. Consolidated API field reference

| Marketplace | JSON path | Mandatory? | Value shape |
|---|---|---|---|
| eBay | `offer.tax` | no — omit unless VAT rate / US tax table / vendor code applies | object |
| eBay | `offer.tax.vatPercentage` | conditional — business seller + VAT-ID on file + VAT-enabled site | number, ≤6 chars incl. decimal, 3 dp — `19.0` |
| eBay | `offer.tax.applyTax` | no — US sales-tax-table switch, not VAT | boolean |
| eBay | `offer.tax.thirdPartyTaxCategory` | no — tax-vendor partners only | string, e.g. `"WASTE_RECYCLING_FEE"` |
| eBay | `offer.regulatory.responsiblePersons[]` | conditional since 2024-12-13 (GPSR) | array, max 5 |
| eBay | `offer.regulatory.responsiblePersons[].types` | with the above | `["EUResponsiblePerson"]` |
| eBay | `offer.regulatory.documents[]` | conditional (GPSR) | array of `Document` |
| eBay | `offer.extendedProducerResponsibility.*Id` | **never — deprecated**, account-level only | string |
| eBay | `offer.listingPolicies` | yes, before publish | Business Policies opt-in required |
| eBay | `offer.hideBuyerDetails` | no — ⚠ *not* the Privatverkäufer flag | boolean |
| eBay | *(seller type)* | n/a — account setting; read-only via Trading `GetUser.SellerInfo.SellerBusinessType` | `Commercial`\|`Private`\|`Undefined` |
| Etsy | `is_taxable` | no | boolean — refers to **shop** tax rates, US-oriented |
| Etsy | `non_taxable` | read-only | boolean |
| Etsy | `total_vat_cost` / `total_tax_cost` | read-only, on `ShopReceipt` | Money |
| Etsy | `buyer_price.*` + `?buyer_country=DE` | read-only, `/listings/batch` only | Money, VAT-inclusive |
| Etsy | *(VAT rate, GPSR, LUCID)* | **no API field exists** | Shop Manager UI only |

---

## 8. Gotchas

1. **`applyTax` is not a VAT switch.** It selects the US sales tax table.
   `applyTax: false` does not signal VAT exemption. Never send it from `EBAY_DE`.
2. **eBay does not compute VAT.** `vatPercentage` is display/invoice metadata.
   Your `pricingSummary.price` is gross regardless.
3. **`vatPercentage` is silently gated.** Business seller + VAT-ID registered with
   eBay + VAT-enabled site. A private or Kleinunternehmer account sending it
   should expect an error, not silent acceptance.
4. **Decimal-place mismatch between eBay APIs.** Inventory API `vatPercentage`
   allows **3 decimal places**; the legacy Trading API `VATDetails.VATPercent`
   documents only **one** digit after the decimal. Do not share a formatter.
5. **`hideBuyerDetails` ≠ Privatverkäufer.** It anonymises bidder IDs.
6. **eBay's `extendedProducerResponsibility` is a trap.** It exists in the schema
   and looks correct for LUCID. It is explicitly marked **DO NOT USE**.
7. **Etsy's `is_taxable` refers to shop tax rates that no API endpoint can set.**
   Near-no-op for a German seller.
8. **Etsy has zero GPSR API surface.** If GPSR applies, set the **shop-level**
   Responsible Person in Shop Manager — the only route compatible with automated
   listing creation.
9. **Etsy `non_taxable` is read-only.** Do not try to PATCH it; write
   `is_taxable`.
10. **Etsy may hard-block selling without a VAT ID** once EU gross sales cross the
    local threshold. Plan for the account to be interrupted, not just warned.
11. **Etsy digital-vs-physical VAT rules differ sharply.** Guidance found for
    digital goods does not transfer to 3D prints.
12. **`developer.ebay.com` blocks automated fetching** (403 / timeouts). Budget
    for manual verification; do not build a doc-scraping step into CI.
13. **Adding any electronics** to a print pulls in ElektroG/BattG with their own
    account-level registrations.

---

## 9. Open items — verify before relying on any of these

- **[LEGAL]** Whether a Kleinunternehmer must add a §19 UStG note to eBay/Etsy
  listing text, and its exact wording. No platform documents this; third-party
  German legal blogs **contradict each other** on whether the eBay MwSt option
  should be set to 0% or left off entirely.
- **[LEGAL]** Whether omitting eBay's `tax` object is *legally* sufficient for a
  Kleinunternehmer, as opposed to merely being the correct API encoding. This
  document establishes only the latter.
- **[LEGAL]** Whether Etsy acts as deemed supplier for a **German-established**
  seller shipping **physical** goods **within the EU**. Evidence points to *no*,
  but this was not confirmed from an Etsy page read directly (403).
- **[LEGAL]** Whether GPSR requires a separate EU Responsible Person for a German
  manufacturer selling its own goods from Germany.
- **[LEGAL]** VAT rate classification (19% vs 7%) for specific 3D-printed goods.
- **[LEGAL]** Whether a Kleinunternehmer is still subject to VerpackG/LUCID
  (VerpackG has no small-business exemption comparable to §19 UStG — verify).
- **[API]** Exact eBay error codes when a non-eligible account sends
  `vatPercentage`. Not documented in the recovered contract; test in sandbox.
- **[API]** Whether eBay validates `regulatory.responsiblePersons` as
  conditionally required at `publishOffer` for `EBAY_DE`, and in which
  categories. The word is *"conditionally"*; conditions are unstated.
- **[API]** Current live Inventory API contract version vs the **1.18.4** mirror
  used here. Re-verify §1 quotes against the live page from a browser.
- **[API]** Whether Etsy plans GPSR API fields. Nothing in the current spec.

---

## 10. Sources

**Primary (fetched and parsed directly):**
- Etsy Open API v3 OpenAPI spec — `https://www.etsy.com/openapi/generated/oas/3.0.0.json`
  (downloaded 2026-08-11, 901 KB; all Etsy field quotes and keyword counts come from here)
- Etsy API reference — `https://developers.etsy.com/documentation/reference/`

**eBay contract text, via generated-SDK mirrors (see §0 caveat) — byte-identical across all:**
- `quarterdeck-io/eeeeee-bay` — `src/generated/sellInventoryV1/src/model/{Regulatory,ResponsiblePerson}.js` (OpenAPI 1.18.4)
- `sapientpro/ebay-inventory-sdk-php` — `src/Models/{Tax,EbayOfferDetailsWithKeys,ExtendedProducerResponsibility}.php`
- `matecsaj/ebay_rest` — `src/ebay_rest/api/sell_inventory/models/tax.py`
- `brandon14/ebay-sdk-php`, `zVPS/ebay-sell-inventory-php-client`, `cdma-numiscorner/EbayInventoryApi` — `Tax.php`
- `ballerina-platform/openapi-connectors` — `openapi/ebay.inventory/types.bal`
- `APIs-guru/openapi-directory` — `APIs/ebay.com/sell-account/v1.9.0/openapi.yaml` (`SellingPrivileges`)
- `hendt/ebay-api` — `src/types/traditional/get-user-response.ts` (`SellerBusinessType`), `get-item-response.ts` (`VATDetails`)

**eBay pages referenced but NOT directly fetchable (403/timeout) — verify manually:**
- `https://developer.ebay.com/api-docs/sell/inventory/types/slr:Tax`
- `https://developer.ebay.com/api-docs/sell/inventory/types/slr:EbayOfferDetailsWithKeys`
- `https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/taxes-vat.html`
- `https://www.ebay.de/verkaeuferportal/gesetzliche-steuerliche-vorgaben/verpackungsgesetz`
- `https://www.ebay.de/help/selling/extended-producer-responsibility-business-sellers/...?id=5336`
- `https://www.ebay.com/sellercenter/resources/general-product-safety-regulation`

**Etsy help pages (403 to direct fetch; content via search summaries — verify manually):**
- `https://help.etsy.com/hc/en-us/articles/28211364687383` — What is the GPSR?
- `https://www.etsy.com/seller-handbook/article/1093438529659` — Selling Consumer Products to Europe Under the GPSR
- `https://help.etsy.com/hc/en-us/articles/360000337247` — Custom Fees and Physical VAT Collection
- `https://help.etsy.com/hc/en-us/articles/360040975813` — How to Add or Update Your VAT ID
- `https://help.etsy.com/hc/en-us/articles/360058652054` — Am I Required To Add a VAT ID to my Account?
- `https://help.etsy.com/hc/en-us/articles/360040584433` — How VAT Is Collected on Seller Fees
