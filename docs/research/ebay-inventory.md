# eBay Sell Inventory API — Single-SKU Fixed-Price Listing on ebay.de

**Goal:** publish one 3D-printed product as a fixed-price (`GTC`) listing on `EBAY_DE`.

## Provenance of this document (read this first)

`developer.ebay.com` was **not reachable** during this research: `WebFetch` timed out repeatedly
(retried as instructed) and direct HTTP requests returned **HTTP 403** for every page. The eBay doc
site appears to block automated clients.

Everything marked **[SPEC]** below is taken from eBay's own **OpenAPI 3 contracts**, which eBay
generates from the same source as the HTML docs. These are the authoritative artifacts available:

| Spec | Version | Source |
|---|---|---|
| Sell Inventory | `1.18.5` | `raw.githubusercontent.com/hendt/ebay-api/master/specs/sell_inventory_v1_oas3.json` |
| Sell Account | `v1.9.3` | `.../specs/sell_account_v1_oas3.json` |
| Commerce Taxonomy | `v1.1.1` | `.../specs/commerce_taxonomy_v1_oas3.json` |
| Developer Analytics | `v1_beta` | `.../specs/developer_analytics_v1_beta_oas3.json` |

The field-level descriptions quoted below are eBay's own text carried inside those specs. Anything
**not** in a spec is marked **[UNCONFIRMED]** and should be verified against the live docs or by a
sandbox call before you rely on it.

---

## 0. Base URLs, scopes, and the "required to publish" model

**[SPEC]** Base URLs (`servers` block is `https://api.ebay.com{basePath}`):

| API | basePath | Sandbox host |
|---|---|---|
| Inventory | `/sell/inventory/v1` | `https://api.sandbox.ebay.com` |
| Account | `/sell/account/v1` | `https://api.sandbox.ebay.com` |
| Taxonomy | `/commerce/taxonomy/v1` | `https://api.sandbox.ebay.com` |
| Developer Analytics | `/developer/analytics/v1_beta` | `https://api.sandbox.ebay.com` |

**[SPEC]** OAuth scopes, from each spec's `securitySchemes`:

| API | Flow | Scope |
|---|---|---|
| Inventory | authorization code (**user token**) | `https://api.ebay.com/oauth/api_scope/sell.inventory` |
| Account | authorization code (**user token**) | `https://api.ebay.com/oauth/api_scope/sell.account` |
| Taxonomy | **client credentials** (app token) | `https://api.ebay.com/oauth/api_scope` |

Taxonomy is the only one of the three that works with a plain application token — you do not need
the seller's consent to look up categories and aspects.

### The critical mental model

**[SPEC]** Virtually **nothing** is required at create time. The Inventory API's `required` arrays
are empty for `InventoryItem`, `EbayOfferDetailsWithKeys`, and `InventoryLocationFull`. Requirements
are enforced **at `publishOffer` time**, and eBay flags them in the field descriptions with the
phrase *"Publish offer note: This field is required before an offer can be published."*

So: `createOrReplaceInventoryItem` and `createOffer` will happily return 200/201 on a payload that
can never be published. **Do not treat a successful create as validation.**

A second trap, **[SPEC]**, quoted from `createOrReplaceInventoryItem`:

> "the `createOrReplaceInventoryItem` call will do a complete replacement of the existing inventory
> item record, so all fields that are currently defined for the inventory item record are required
> in that update action, regardless of whether their values changed."

It is a **PUT/replace, not a merge**. Omitting `availability` on an update wipes your stock. Always
send the full document.

### Call sequence

```
1. Account   GET  /program/get_opted_in_programs          -> confirm SELLING_POLICY_MANAGEMENT
2. Account   POST /program/opt_in                          (only if not opted in)
3. Account   POST /fulfillment_policy/  |  /payment_policy  |  /return_policy
             GET  /fulfillment_policy?marketplace_id=EBAY_DE  (etc.) -> policy IDs
4. Taxonomy  GET  /get_default_category_tree_id?marketplace_id=EBAY_DE  -> "77"
5. Taxonomy  GET  /category_tree/77/get_category_suggestions?q=...      -> categoryId
6. Taxonomy  GET  /category_tree/77/get_item_aspects_for_category?category_id=...
7. Inventory POST /location/{merchantLocationKey}          (once, reused forever)
8. Inventory PUT  /inventory_item/{sku}
9. Inventory POST /offer                                   -> offerId
10.Inventory POST /offer/{offerId}/publish                 -> listingId
```

Steps 1–3 and 7 are **one-time account setup**. Steps 8–10 are the per-product loop.

---

## 1. HTTP headers — exactly which, exactly where

**[SPEC]** Declared header parameters, read directly from each operation's `parameters` block:

| Call | `Content-Type` | `Content-Language` | `X-EBAY-C-MARKETPLACE-ID` | `Accept-Language` |
|---|---|---|---|---|
| `createOrReplaceInventoryItem` (PUT `/inventory_item/{sku}`) | **required** | **required** | not declared | not declared |
| `createOffer` (POST `/offer`) | **required** | **required** | not declared | not declared |
| `publishOffer` (POST `/offer/{offerId}/publish`) | — | — | not declared | not declared |
| `createInventoryLocation` (POST `/location/{key}`) | **required** | — | not declared | not declared |

Three precise findings that contradict a lot of blog advice:

1. **`X-EBAY-C-MARKETPLACE-ID` is not used by the Inventory API at all.** The string appears
   **exactly zero times** in the Inventory spec. Across all three specs it is a declared parameter on
   exactly one operation: Account API `getAdvertisingEligibility`. The marketplace for a listing is
   selected by the **`marketplaceId` field in the `createOffer` body**, not by a header. Sending the
   header anyway is harmless but does nothing.

2. **`Content-Language` is the header that matters for DE**, and it is required on
   `createOrReplaceInventoryItem` and `createOffer`. **[SPEC]** it "sets the natural language that
   will be used in the field values of the request payload." For ebay.de send **`Content-Language: de-DE`**.
   This is what tells eBay your `title`, `description`, and aspect values are German. Getting this
   wrong (e.g. leaving `en-US`) is a common cause of aspect-validation failures on DE.

3. **`Accept-Language` is not a declared parameter anywhere**, but it is **honored by Taxonomy**.
   **[SPEC]**, from the `getCategorySuggestions` description: the localized category name is returned
   *"based on the **Accept-Language** header specified for the call"*. Send `Accept-Language: de-DE`
   on Taxonomy calls so `localizedAspectName` comes back as the German aspect names you must
   literally echo back in `product.aspects`.

Canonical header set for the two body-bearing Inventory calls:

```http
Authorization: Bearer v^1.1#i^1#...        (user access token, scope sell.inventory)
Content-Type: application/json
Content-Language: de-DE
Accept: application/json
```

`publishOffer` needs only `Authorization` (and `Accept`); it has **no request body**.

---

## 2. Business Policies prerequisite (Account API)

**[SPEC]** From the `ListingPolicies` description:

> "It is required that the seller be opted into Business Policies before being able to create live
> eBay listings through the Inventory API."

### 2.1 Check opt-in status

```http
GET https://api.ebay.com/sell/account/v1/program/get_opted_in_programs
Authorization: Bearer <user token, scope sell.account>
```

**[SPEC]** Response is `Programs` → `programs[]`, each an object with a single `programType` string.
An **empty array means opted into nothing**.

```json
{ "programs": [ { "programType": "SELLING_POLICY_MANAGEMENT" }, { "programType": "OUT_OF_STOCK_CONTROL" } ] }
```

**[UNCONFIRMED]** The exact enum literal `SELLING_POLICY_MANAGEMENT` is the value for Business
Policies. The spec defines `programType` as a bare `string` with the note "For implementation help,
refer to eBay API documentation" and does **not** enumerate the values. Verify against
`ProgramTypeEnum` in the live docs. The opt-in call itself is confirmed:

```http
POST https://api.ebay.com/sell/account/v1/program/opt_in
Content-Type: application/json
```
```json
{ "programType": "SELLING_POLICY_MANAGEMENT" }
```

### 2.2 Create the three policies

**[SPEC]** Note the **inconsistent trailing slashes** — this is a real, easy-to-miss detail:

| Operation | Method + path |
|---|---|
| `createFulfillmentPolicy` | `POST /fulfillment_policy/` ← **trailing slash** |
| `getFulfillmentPolicies` | `GET /fulfillment_policy?marketplace_id=EBAY_DE` ← **no slash** |
| `createPaymentPolicy` | `POST /payment_policy` |
| `getPaymentPolicies` | `GET /payment_policy?marketplace_id=EBAY_DE` |
| `createReturnPolicy` | `POST /return_policy` |
| `getReturnPolicies` | `GET /return_policy?marketplace_id=EBAY_DE` |

All three `get*Policies` calls take **`marketplace_id` as a required query parameter** and accept an
optional `Content-Language` header. There are also `get_by_policy_name` variants
(`GET /fulfillment_policy/get_by_policy_name?marketplace_id=EBAY_DE&name=...`), which are the
cleanest way to make policy setup idempotent.

Create responses return `SetFulfillmentPolicyResponse` / `SetPaymentPolicyResponse` /
`SetReturnPolicyResponse` with `fulfillmentPolicyId` / `paymentPolicyId` / `returnPolicyId` plus a
`warnings[]` array — **check `warnings`, a 201 does not mean clean**.

#### Fulfillment policy — DE, flat rate, DHL

```json
{
  "name": "DE Standard Versand DHL Paket",
  "description": "Flat rate DHL, 2 Werktage Bearbeitungszeit",
  "marketplaceId": "EBAY_DE",
  "categoryTypes": [ { "name": "ALL_EXCLUDING_MOTORS_VEHICLES" } ],
  "handlingTime": { "unit": "DAY", "value": 2 },
  "localPickup": false,
  "freightShipping": false,
  "shippingOptions": [
    {
      "optionType": "DOMESTIC",
      "costType": "FLAT_RATE",
      "shippingServices": [
        {
          "sortOrder": 1,
          "shippingCarrierCode": "DHL",
          "shippingServiceCode": "DE_DHLPaket",
          "shippingCost": { "currency": "EUR", "value": "4.99" },
          "additionalShippingCost": { "currency": "EUR", "value": "1.50" },
          "freeShipping": false,
          "shipToLocations": { "regionIncluded": [ { "regionName": "DE" } ] }
        }
      ]
    }
  ],
  "shipToLocations": {
    "regionIncluded": [ { "regionName": "DE" } ],
    "regionExcluded": []
  }
}
```

**[UNCONFIRMED]** `shippingServiceCode: "DE_DHLPaket"` and `shippingCarrierCode: "DHL"`. **[SPEC]**
is explicit that these are enum strings you must not guess: *"For a full list of shipping service
option enum values for a specified eBay marketplace, the `GeteBayDetails` call of the Trading API can
be used, and the `DetailName` field's value should be set to `ShippingServiceDetails`."* You must also
check the `ValidForSellingFlow` boolean is `true` for the service. **Resolve these codes for
`EBAY_DE` before hardcoding them** — this is a classic source of publish error 25007 ("add at least
one valid postage service option").

**[SPEC]** `handlingTime` is *"conditionally required when the seller is offering one or more domestic
or international shipping options"* — so effectively required for you.

#### Payment policy

**[SPEC]** eBay now manages electronic payment options; `paymentMethods` *"applies only when the
seller needs to specify one or more offline payment methods."* For a managed-payments DE seller,
omit it entirely.

```json
{
  "name": "DE Zahlung Standard",
  "description": "Verwaltete Zahlungen",
  "marketplaceId": "EBAY_DE",
  "categoryTypes": [ { "name": "ALL_EXCLUDING_MOTORS_VEHICLES" } ],
  "immediatePay": true
}
```

#### Return policy — note the EU 14-day rule

```json
{
  "name": "DE Ruecknahme 30 Tage",
  "description": "30 Tage Rueckgaberecht, Kaeufer zahlt Rueckversand",
  "marketplaceId": "EBAY_DE",
  "categoryTypes": [ { "name": "ALL_EXCLUDING_MOTORS_VEHICLES" } ],
  "returnsAccepted": true,
  "returnPeriod": { "unit": "DAY", "value": 30 },
  "returnShippingCostPayer": "BUYER",
  "refundMethod": "MONEY_BACK"
}
```

**[SPEC]** constraints worth knowing:
- `categoryTypes.name` **must** be `ALL_EXCLUDING_MOTORS_VEHICLES` for return policies —
  `MOTORS_VEHICLES` is invalid here.
- `returnPeriod` and `returnShippingCostPayer` are **conditionally required when `returnsAccepted` is
  `true`**.
- `refundMethod` defaults to `MONEY_BACK` if omitted.
- **DSA / EU:** *"as of April 3, 2023, buyers in the EU must be allowed to return an item within 14
  days or more."* 30 days satisfies this.
- `restockingFeePercentage` and `extendedHolidayReturnsOffered` are **deprecated and ignored**.
- `returnInstructions` max length is **8000 for DE** (5000 elsewhere), but is no longer supported on
  many marketplaces — check Metadata API `getReturnPolicies` → `policyDescriptionEnabled`.

---

## 3. Taxonomy — categoryId and required aspects

### 3.1 Category tree ID for EBAY_DE

```http
GET https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_DE
Authorization: Bearer <application token>
```

```json
{ "categoryTreeId": "77", "categoryTreeVersion": "..." }
```

**`EBAY_DE` → category tree ID `77`.** **[UNCONFIRMED but strongly corroborated]** — I could not read
eBay's own table, but `77` appears as the hardcoded DE tree ID in numerous independent public
implementations (`adbertram/cli-tools`, `kkacsh321/gs-inv-mgmt`, `brianeckblad/rivit`,
`Syedirtiza768/realtrackapp`, `rbrooks-developer/EbayListingCreator`, `dawca1122/ebay-ai-listing-assistant`).
It also matches the legacy Trading API site ID for Germany. **Still call `getDefaultCategoryTreeId`
once at startup and cache it** rather than hardcoding — it is one cheap call and it removes the only
unverified constant in your pipeline.

**[SPEC]** Also cache `categoryTreeVersion`: *"It's a good idea to cache this value for comparison so
you can determine if this category tree has been modified in subsequent calls."*

### 3.2 Category suggestions

```http
GET https://api.ebay.com/commerce/taxonomy/v1/category_tree/77/get_category_suggestions?q=3D%20gedruckter%20Kabelhalter
Authorization: Bearer <application token>
Accept-Language: de-DE
```

**[SPEC]** `q` is a **required** query parameter. Response is `CategorySuggestionResponse`:

```json
{
  "categorySuggestions": [
    {
      "category": { "categoryId": "179697", "categoryName": "Kabelhalter" },
      "categoryTreeNodeAncestors": [
        { "categoryId": "3187", "categoryName": "Kabel & Adapter", "categoryTreeNodeLevel": 3,
          "categorySubtreeNodeHref": "https://api.ebay.com/commerce/taxonomy/v1/category_tree/77/get_category_subtree?category_id=3187" }
      ],
      "categoryTreeNodeLevel": 4,
      "relevancy": ""
    }
  ],
  "categoryTreeId": "77",
  "categoryTreeVersion": "..."
}
```

**[SPEC]** The array *"is sorted in order of eBay's confidence of the relevance of each category (the
first category is the most relevant)"* — so `categorySuggestions[0].category.categoryId` is your pick.
`relevancy` is **reserved for internal use** and will be empty; do not parse it.

> **[SPEC] Major gotcha:** *"This call is **not supported in the Sandbox environment**. It will return
> a response payload in which the `categoryName` fields contain random or boilerplate text regardless
> of the query submitted."* You cannot develop category selection against sandbox. Either call
> production Taxonomy with an app token (it is not seller-specific, so this is safe) or hardcode a
> category during sandbox work.

### 3.3 Required item aspects

```http
GET https://api.ebay.com/commerce/taxonomy/v1/category_tree/77/get_item_aspects_for_category?category_id=179697
Authorization: Bearer <application token>
Accept-Language: de-DE
```

**[SPEC]** Response is `AspectMetadata` → `aspects[]`:

```json
{
  "aspects": [
    {
      "localizedAspectName": "Marke",
      "aspectConstraint": {
        "aspectDataType": "STRING",
        "itemToAspectCardinality": "SINGLE",
        "aspectMode": "FREE_TEXT",
        "aspectRequired": true,
        "aspectUsage": "RECOMMENDED",
        "aspectEnabledForVariations": false,
        "aspectApplicableTo": [ "PRODUCT" ],
        "aspectMaxLength": 65
      },
      "aspectValues": [ { "localizedValue": "Markenlos" } ]
    },
    {
      "localizedAspectName": "Material",
      "aspectConstraint": {
        "aspectDataType": "STRING",
        "itemToAspectCardinality": "MULTI",
        "aspectMode": "SELECTION_ONLY",
        "aspectRequired": false,
        "aspectUsage": "RECOMMENDED"
      },
      "aspectValues": [ { "localizedValue": "Kunststoff" }, { "localizedValue": "PLA" } ]
    }
  ]
}
```

**[SPEC]** How to read this correctly — there are two traps:

1. **`aspectRequired: true` is the only signal that matters.** Do **not** filter on `aspectUsage`:
   *"This field is always returned, even for hard-mandated/required aspects (where
   `aspectRequired: true`). The value returned for required aspects will be `RECOMMENDED`, but they
   are actually required and a seller will be blocked from listing or revising an item without these
   aspects."* So `aspectUsage: "RECOMMENDED"` + `aspectRequired: true` = **mandatory**.

2. **`aspectMode: "SELECTION_ONLY"` means you must send a value from `aspectValues`** verbatim.
   `FREE_TEXT` lets you send your own string. Respect `aspectMaxLength`, and
   `itemToAspectCardinality` (`SINGLE` vs `MULTI`) — **[SPEC]** *"Up to 30 values can be supplied for
   aspects that accept multiple values."*

3. `localizedAspectName` is German because of the marketplace/`Accept-Language`. The key you put in
   `product.aspects` must be **exactly this localized string** (`"Marke"`, not `"Brand"`).

**[SPEC]** Product identifiers (`brand`, `mpn`, `upc`, `ean`, `isbn`) surface as aspects here too. For
a self-made 3D print you will typically have no EAN/MPN. eBay's documented escape hatch:

> "In some cases, a product identifier type may be required, but not known/applicable for a product.
> If this is the case, the seller must still include the corresponding field in the inventory item
> record, but pass in a default text string. This text string can vary by site... use the
> `GeteBayDetails` call of the Trading API... `ProductDetails.ProductIdentifierUnavailableText`."

**[UNCONFIRMED]** For DE that string is commonly `"Nicht zutreffend"`. Fetch it via `GeteBayDetails`
rather than hardcoding. In practice, setting `"Marke": ["Markenlos"]` and `"Herstellernummer":
["Nicht zutreffend"]` is the standard pattern for handmade/3D-printed goods on ebay.de.

There is also **`fetchItemAspects`** (`GET /category_tree/77/fetch_item_aspects`), which returns a
gzipped bulk dump of aspects for the **whole** tree — better than per-category calls if you list
across many categories.

---

## 4. `createOrReplaceInventoryLocation`

### Is a `merchantLocationKey` required before offers?

**Yes — required to publish, not to create.** **[SPEC]**, from `EbayOfferDetailsWithKeys.merchantLocationKey`:

> "This field is not initially required upon first creating an offer, but will become required before
> an offer can be published. **Publish offer note: This field is required before an offer can be
> published to create an active listing.** Max length: 36"

This is the single most common cause of publish error **25002** — see §8.

### Which fields are mandatory?

**[SPEC]** `InventoryLocationFull.required` is empty, but the descriptions are explicit:

- `location` — *"This **required** container"* → `location.address` — *"This **required** container"*
- For a **`WAREHOUSE`** location (the default, and what you want), the address needs **either**:
  - `postalCode` + `country`, **or**
  - `city` + `stateOrProvince` + `country`

  *"A warehouse location only requires the postal code and country OR city, province/state, and
  country, and does not require a full street address."*
- `name` — *"A name is **not required for warehouse locations**."* Required only for STORE locations
  (before publishing an In-Store Pickup / Click&Collect offer).
- `locationTypes` — optional; **[SPEC]** *"If this container is omitted, the location type of the
  inventory location will default to `WAREHOUSE`."*
- `merchantLocationStatus` — optional; *"If this field is omitted, a successful
  `createInventoryLocation` call will automatically enable the location."* Default `ENABLED`.
- `geoCoordinates` — only required for In-Store Pickup inventory.

**[SPEC]** The `merchantLocationKey` is a **path parameter**, not a body field, and is capped at 36 chars.

### Request

```http
POST https://api.ebay.com/sell/inventory/v1/location/3dprint-lager-01
Authorization: Bearer <user token, scope sell.inventory>
Content-Type: application/json
```

Minimal, spec-valid warehouse location for Germany:

```json
{
  "location": {
    "address": {
      "postalCode": "10115",
      "country": "DE"
    }
  },
  "locationTypes": [ "WAREHOUSE" ],
  "merchantLocationStatus": "ENABLED",
  "name": "3D-Druck Lager Berlin"
}
```

Fuller version (recommended — a complete address avoids calculated-shipping surprises):

```json
{
  "location": {
    "address": {
      "addressLine1": "Musterstrasse 12",
      "city": "Berlin",
      "stateOrProvince": "Berlin",
      "postalCode": "10115",
      "country": "DE"
    }
  },
  "locationTypes": [ "WAREHOUSE" ],
  "merchantLocationStatus": "ENABLED",
  "name": "3D-Druck Lager Berlin",
  "phone": "+49 30 12345678",
  "timeZoneId": "Europe/Berlin"
}
```

**[SPEC] Response: `204 No Content`.** There is **no response body and no ID returned** — the
`merchantLocationKey` you chose in the URL *is* the identifier. A repeat POST with the same key
returns **`409 Conflict`**, so treat 409 as "already exists" and continue.

**[SPEC]** `country` is ISO 3166 two-letter: *"`DE` represents Germany."* `timeZoneId` is Olson format.

---

## 5. `createOrReplaceInventoryItem`

```http
PUT https://api.ebay.com/sell/inventory/v1/inventory_item/3DP-KABELHALTER-BLK-001
Authorization: Bearer <user token, scope sell.inventory>
Content-Type: application/json
Content-Language: de-DE
Accept: application/json
```

### Full body

```json
{
  "availability": {
    "shipToLocationAvailability": {
      "quantity": 25
    }
  },
  "condition": "NEW",
  "packageWeightAndSize": {
    "packageType": "PACKAGE_THICK_ENVELOPE",
    "weight": {
      "value": 120,
      "unit": "GRAM"
    },
    "dimensions": {
      "length": 15.0,
      "width": 10.0,
      "height": 4.0,
      "unit": "CENTIMETER"
    }
  },
  "product": {
    "title": "Kabelhalter 3D-gedruckt PLA Schreibtisch Kabelmanagement 5er Set schwarz",
    "description": "<p>Hochwertiger <b>3D-gedruckter Kabelhalter</b> aus PLA.</p><ul><li>Set mit 5 Haltern</li><li>Selbstklebende Basis</li><li>Made in Germany</li></ul>",
    "aspects": {
      "Marke": [ "Markenlos" ],
      "Herstellernummer": [ "Nicht zutreffend" ],
      "Material": [ "Kunststoff", "PLA" ],
      "Farbe": [ "Schwarz" ],
      "Herstellungsland und -region": [ "Deutschland" ]
    },
    "imageUrls": [
      "https://cdn.example.com/3dp/kabelhalter-001-main.jpg",
      "https://cdn.example.com/3dp/kabelhalter-001-detail.jpg",
      "https://cdn.example.com/3dp/kabelhalter-001-scale.jpg"
    ],
    "brand": "Markenlos",
    "mpn": "Nicht zutreffend"
  }
}
```

### Which fields are mandatory *in order to later publish*

**[SPEC]** Fields whose description carries the literal *"Publish offer note: This field is required
before an offer can be published to create an active listing"*:

| Field | Publish-required | Notes |
|---|---|---|
| `sku` (path) | **yes** | max length **50** |
| `condition` | **yes** | *"required for most eBay categories"* |
| `availability.shipToLocationAvailability.quantity` | **yes** | *"'ship-to-home' quantity must be set before an offer of the inventory item can be published"* |
| `product` | **yes** | container itself |
| `product.title` | **yes** | max **80** |
| `product.description` | **yes*** | max **4000** — see below |
| `product.aspects` | **yes** | name max **40**, value max **50** |
| `product.imageUrls` | **yes** | *"at least one image URL must be specified"* |
| `packageWeightAndSize` | **no** | required only for calculated shipping / weight surcharge |
| `product.brand` / `mpn` | conditional | *"conditionally required if the eBay category requires a Manufacturer Part Number"* |

**\*** **[SPEC]** subtle interaction on description: *"If a `listingDescription` field is omitted when
creating and publishing a single-variation offer, the text in this field will be used instead. **If
neither the `product.description` field for the inventory item nor the `listingDescription` field for
the offer exist, the `publishOffer` call will fail.**"* You need at least one of the two. Sending both
is fine — `listingDescription` wins.

### `condition` enum values

**[UNCONFIRMED — source is SDKs, not eBay]** The Inventory spec types `condition` as a bare `string`
and does **not** enumerate values. This list is cross-checked between
`plentymarkets/ebay-sdk` (`ConditionEnum.php`) and `hendt/ebay-api` (`restfulEnums.ts`), which agree exactly:

```
NEW                       LIKE_NEW              USED_EXCELLENT
NEW_OTHER                 USED_VERY_GOOD        USED_GOOD
NEW_WITH_DEFECTS          USED_ACCEPTABLE       FOR_PARTS_OR_NOT_WORKING
MANUFACTURER_REFURBISHED  SELLER_REFURBISHED
```

Newer values exist that these SDKs predate — eBay's release notes mention `PRE_OWNED_EXCELLENT`
(condition ID 2990) and `PRE_OWNED_FAIR` (3010) for apparel, plus the refurbished tiers
(`CERTIFIED_REFURBISHED`, `EXCELLENT_REFURBISHED`, `VERY_GOOD_REFURBISHED`, `GOOD_REFURBISHED`).

**For a 3D-printed product you make yourself, use `"NEW"` (condition ID 1000).**

**[SPEC]** Condition support **varies by category**: *"Supported item condition values will vary by
eBay site and category. To see which item condition values that a particular eBay category supports,
use the `getItemConditionPolicies` method of the Metadata API."*

### `packageWeightAndSize` — units and DE support

**[SPEC]** *"Package weight and dimensions are **only supported for the following marketplaces: AU,
CA, DE, IT, UK, US, and Motors**. If this information is provided on other marketplaces, it will be
ignored."* DE is supported.

**[SPEC]** Units — use the **metric** set for DE:
- `weight.unit`: `KILOGRAM` or `GRAM` (metric) / `POUND` or `OUNCE` (imperial)
- `dimensions.unit`: `METER` or `CENTIMETER` (metric) / `FEET` or `INCH` (imperial)
- *"Both the `unit` and `value` fields are required if the `weight` container is used."*
- *"All fields of the `dimensions` container are required if package dimensions are specified."*

**[UNCONFIRMED]** `packageType: "PACKAGE_THICK_ENVELOPE"` — **[SPEC]** says values come from
`PackageTypeEnum` and *"You can use the `GeteBayDetails` Trading API call to retrieve a list of
supported package types for a specific marketplace."* `packageType` is **optional**; omit it if unsure.

**[SPEC] Response: `200` or `201` with a `BaseResponse`** — body contains only `warnings[]`. **Always
inspect `warnings`**, since a 200 with warnings can still describe a payload that will fail to publish.

---

## 6. `createOffer`

```http
POST https://api.ebay.com/sell/inventory/v1/offer
Authorization: Bearer <user token, scope sell.inventory>
Content-Type: application/json
Content-Language: de-DE
Accept: application/json
```

### Full body

```json
{
  "sku": "3DP-KABELHALTER-BLK-001",
  "marketplaceId": "EBAY_DE",
  "format": "FIXED_PRICE",
  "listingDuration": "GTC",
  "categoryId": "179697",
  "merchantLocationKey": "3dprint-lager-01",
  "availableQuantity": 25,
  "listingDescription": "<p>Hochwertiger <b>3D-gedruckter Kabelhalter</b> aus PLA.</p><ul><li>Set mit 5 Haltern</li><li>Selbstklebende Basis</li><li>Made in Germany</li></ul><p>Versand aus Deutschland, Rechnung mit ausgewiesener MwSt.</p>",
  "pricingSummary": {
    "price": {
      "currency": "EUR",
      "value": "12.99"
    }
  },
  "listingPolicies": {
    "fulfillmentPolicyId": "6209513000",
    "paymentPolicyId": "6209514000",
    "returnPolicyId": "6209515000"
  },
  "tax": {
    "applyTax": false,
    "vatPercentage": 19.0
  },
  "includeCatalogProductDetails": false,
  "quantityLimitPerBuyer": 10,
  "storeCategoryNames": [ "/3D-Druck/Kabelmanagement" ]
}
```

### Required vs optional

**[SPEC]** `EbayOfferDetailsWithKeys.required` is empty. From the descriptions:

| Field | Status |
|---|---|
| `sku` | *"This field is **required**."* — at create time. Max **50** |
| `marketplaceId` | *"This field is **required**."* — at create time. `EBAY_DE` |
| `format` | `FIXED_PRICE` or `AUCTION` |
| `listingDuration` | **publish-required**; *"For fixed-price listings, this value must be set to **`GTC`**"* |
| `categoryId` | **publish-required** |
| `listingDescription` | **publish-required** unless `product.description` is set. Max **500000** |
| `pricingSummary.price` | **publish-required**; *"This container and its two child fields (`currency` and `value`)"* |
| `listingPolicies.fulfillmentPolicyId` | **publish-required** |
| `listingPolicies.paymentPolicyId` | **publish-required** |
| `listingPolicies.returnPolicyId` | **publish-required** |
| `merchantLocationKey` | **publish-required**. Max **36** |
| `availableQuantity` | *"not necessarily required, even for published offers, if the general quantity of the inventory item has already been set"* |
| `includeCatalogProductDetails` | optional, **defaults to `true`** |

**[SPEC]** Two quantity subtleties:
- *"The `availableQuantity` field if set here **overrides** the `quantity` field set in the inventory item."*
- *"the quantity specified on a listing will be the **minimum** value between this field and the
  `availableQuantity` field"* — i.e. `min(inventoryItem.quantity, offer.availableQuantity)`. Keeping
  them equal avoids confusion.

**[SPEC]** *"Only one offer (in unpublished or published state) may exist for each
`sku`/`marketplaceId`/`format` combination."* Re-running `createOffer` for an existing SKU fails —
use `getOffers?sku=...&marketplace_id=EBAY_DE` then `updateOffer` for idempotency.

**[SPEC]** For `AUCTION`, *"this field should not be provided"* (`availableQuantity`). Not your case.

### Tax / VAT for Germany — read carefully

This is the field most often gotten wrong.

**[SPEC]** `tax.applyTax`: *"When set to `true`, the seller's account-level **sales-tax table** will be
used... **Note: Sales-tax tables are available only for the US and Canada marketplaces.**"*

→ **`applyTax` is irrelevant on `EBAY_DE`.** It controls US/CA sales-tax tables only. Set `false` or omit.

**[SPEC]** `tax.vatPercentage` is the German-relevant field:

> "This value is the Value Add Tax (VAT) rate for the item, if any. When a VAT percentage is
> specified, the item's VAT information appears on the listing's View Item page. In addition, the
> seller can choose to print an invoice that includes the item's net price, VAT percent, VAT amount,
> and total price. Since VAT rates vary depending on the item and on the user's country of residence,
> **a seller is responsible for entering the correct VAT rate; it is not calculated by eBay**. To use
> VAT, a seller **must be a business seller with a VAT-ID registered with eBay**, and must be listing
> the item on a VAT-enabled site. Max applicable length is 6 characters, including the decimal (e.g.,
> `12.345`). The scale is 3 decimal places."

Practical consequences for a German seller:
- Standard German VAT is **19%** → `"vatPercentage": 19.0`.
- The `pricingSummary.price` is the **gross, VAT-inclusive** price shown to buyers. `vatPercentage`
  only declares the rate for display/invoicing; it does **not** add tax on top.
- **If you are a Kleinunternehmer (§19 UStG) or not VAT-registered with eBay, omit the `tax`
  container entirely.** Sending `vatPercentage` without a registered VAT-ID is a likely publish error.
- `thirdPartyTaxCategory` is for tax-calculation-vendor partners only; **[SPEC]** *"If this field is
  used, the `applyTax` field must also be used and set to `true`."* Not applicable to you.

### Regulatory — GPSR, mandatory for ebay.de since Dec 2024

**This is easy to miss and it will block publishing.** **[SPEC]**, from `Regulatory.manufacturer`,
`.responsiblePersons`, `.productSafety`, and `.documents`:

> "As a part of **General Product Safety Regulation (GPSR)** requirements effective on **December 13th,
> 2024**, sellers operating in, or shipping to, **EU-based countries** or Northern Ireland are
> **conditionally required** to provide regulatory manufacturer / Responsible Persons / product safety
> information in their eBay listings."

You are selling a self-manufactured product into Germany, so **you are the manufacturer** and very
likely also the EU Responsible Person. Add to the `createOffer` body:

```json
{
  "regulatory": {
    "manufacturer": {
      "companyName": "Mustermann 3D-Druck",
      "addressLine1": "Musterstrasse 12",
      "city": "Berlin",
      "stateOrProvince": "Berlin",
      "postalCode": "10115",
      "country": "DE",
      "email": "kontakt@example.com",
      "phone": "+49 30 12345678",
      "contactUrl": "https://example.com/kontakt"
    },
    "responsiblePersons": [
      {
        "companyName": "Mustermann 3D-Druck",
        "addressLine1": "Musterstrasse 12",
        "city": "Berlin",
        "stateOrProvince": "Berlin",
        "postalCode": "10115",
        "country": "DE",
        "email": "kontakt@example.com",
        "phone": "+49 30 12345678",
        "contactUrl": "https://example.com/kontakt",
        "types": [ "EUResponsiblePerson" ]
      }
    ],
    "productSafety": {
      "statements": [ "<statement-id-from-Metadata-API>" ]
    }
  }
}
```

**[SPEC]** notes:
- `responsiblePersons` — **max 5**; `types` — *"the only supported value is `EUResponsiblePerson`"*.
- `productSafety` — *"One of the following elements is required to complete the Product Safety
  section: `pictograms` **or** `statements`"*; `component` is optional and **errors if sent without
  one of the other two**. Max **8** statements, max **2** pictograms.
- Statement/pictogram values are **IDs**, not free text — *"use the `getProductSafetyLabels` method of
  the Metadata API to find supported values for a specific marketplace/site."*
- Field lengths: `companyName` 100, `addressLine1/2` 180, `email` 180, `city` 64, `postalCode` **9**,
  `contactUrl` 250, `phone` 64.
- **Whether GPSR fields are required depends on the category** — *"use the `getRegulatoryPolicies`
  method of the Metadata API to return metadata on the eBay categories that recommend or require"*
  each block. **Call this for your category before publishing.**
- `documents[].documentId` comes from the **Media API `createDocument`** method, not from `imageUrls`.

`extendedProducerResponsibility` (eco-participation fee) is a **France** concern; **[SPEC]** all its ID
fields (`producerProductId`, `productPackageId`, etc.) are **deprecated and no longer supported** —
those are now set per-category in My eBay account settings.

### Response

**[SPEC] `201 Created`**, body is `OfferResponse`:

```json
{ "offerId": "9007199254740991", "warnings": [] }
```

**[SPEC]** *"The `offerId` value is only returned with a successful `createOffer` call. This field
will not be returned in the `updateOffer` response."*

---

## 7. `publishOffer`

```http
POST https://api.ebay.com/sell/inventory/v1/offer/9007199254740991/publish
Authorization: Bearer <user token, scope sell.inventory>
Accept: application/json
```

**[SPEC]** `offerId` is the only parameter (path). **No request body. No `Content-Language`.
No `Content-Type`.**

### `PublishResponse` shape

**[SPEC]** `200 OK`:

```json
{
  "listingId": "110586279507",
  "warnings": []
}
```

**[SPEC]** `listingId` is *"The unique identifier of the newly created eBay listing"* — this is the
classic eBay item number, and the value you persist against your product. `warnings[]` is an array of
`Error` objects: *"This container will contain an array of errors **and/or warnings**"* — **a 200 can
carry warnings, so always inspect it.**

**[SPEC]** `Error` object shape (identical for failures):

```json
{
  "errors": [
    {
      "errorId": 25002,
      "domain": "API_INVENTORY",
      "subdomain": "Selling",
      "category": "REQUEST",
      "message": "A user error has occurred.",
      "longMessage": "...",
      "inputRefIds": [],
      "outputRefIds": [],
      "parameters": [ { "name": "...", "value": "..." } ]
    }
  ]
}
```

**[SPEC]** `category` is one of *"request errors, application errors, and system errors"*.
**[SPEC]** `parameters` *"contain contextual information about the error... often the field or value
that triggered the error"* — **this is where the actionable detail lives; log it.**

### Most common publish errors

**[UNCONFIRMED — sourced from eBay Community threads, not from eBay's error reference], since the docs
site was unreachable.** Treat the code→meaning mapping as indicative.

| errorId | Reported meaning | Usual real cause |
|---|---|---|
| **25002** | "A user error has occurred" — vague, many causes | **Missing `merchantLocationKey`** on the offer is the most-reported cause. Also: no image (`imageUrls` empty), missing item country, missing required aspect. Community consensus: *"the error messages for 25002 are often vague and could apply to many things"* |
| **25007** | "invalid data in the associated Fulfillment policy... add at least one valid postage service option" | `shippingServiceCode` invalid for `EBAY_DE`, or `ValidForSellingFlow` is false for that service |
| **25001** | "A system error has occurred / Internal Server Error" | Often a genuinely malformed offer rather than an eBay outage; reported around auction/quantity mismatches |
| **25019** | — | Could not confirm meaning from any accessible source |

**Debugging heuristic that follows directly from [SPEC]:** because nothing is validated at create
time, a publish failure means one of the publish-required fields in §5/§6 is missing. Walk that list
first — `merchantLocationKey`, the three policy IDs, `categoryId`, `price`, `quantity`, `condition`,
`title`, `description`, `aspects`, `imageUrls`, `listingDuration: "GTC"` — before suspecting anything
exotic. `getOffer` + `getInventoryItem` will show you exactly what eBay stored.

---

## 8. Image hosting — this determines your entire image pipeline

**Answer: eBay does NOT require you to upload images to eBay. The Inventory API accepts external,
self-hosted HTTPS URLs directly.**

**[SPEC]**, verbatim from `Product.imageUrls`:

> "An array of one or more links to images for the product. **URLs must use the "HTTPS" protocol.
> Images can be self-hosted by the seller**, or sellers can use the `UploadSiteHostedPictures` call of
> the Trading API to upload images to an eBay Picture Server. If successful, the response of the
> `UploadSiteHostedPictures` call will contain a full URL to the image on an eBay Picture Server. This
> is the URL that will be passed in through the `imageUrls` array. **Before an offer can be published,
> at least one image must exist for the inventory item.** In almost any category at no cost, sellers
> can include up to **24 pictures** in one listing. For inventory items that are a part of an
> inventory item group/multiple-variation listings, a maximum of **12 pictures** may be used per
> inventory item."

So the two options are equivalent and `UploadSiteHostedPictures` (the legacy XML Trading API call) is
**optional**:

| | Self-hosted | `UploadSiteHostedPictures` |
|---|---|---|
| Required? | **No** — fully supported | No — alternative |
| Protocol | **HTTPS mandatory** (HTTP will be rejected) | eBay returns an EPS HTTPS URL |
| Effort | Just host the files | Legacy XML API, separate auth path |

**Practical caveats for the self-hosted path:**
- **HTTPS is non-negotiable.** A valid, publicly-trusted certificate; no self-signed.
- URLs must be **publicly reachable by eBay's crawler** — no auth, no signed URLs that expire, no
  hotlink protection, no IP allowlisting, no `robots.txt` block.
- eBay **fetches and copies** the image at publish time. Keep the URL alive at least until the listing
  is live; changing the file later does not update the listing.
- **[UNCONFIRMED]** eBay's image requirements (min ~500px on the longest side, max ~12MB, JPEG/PNG/GIF/BMP/TIFF,
  no added text/borders/watermarks) — these are eBay policy rather than API contract and I could not
  read the current page. Verify before building the resize step.

**Recommendation for this project:** self-host on any static HTTPS bucket (S3/R2/Cloudflare Pages)
and pass the URLs straight to `product.imageUrls`. Skip the legacy Trading API entirely. Order matters —
`imageUrls[0]` becomes the gallery/primary image.

---

## 9. Rate limits

**[SPEC]** The mechanism for *checking* limits is confirmed — **Developer Analytics API**, basePath
`/developer/analytics/v1_beta`:

```http
GET https://api.ebay.com/developer/analytics/v1_beta/rate_limit/?api_context=sell&api_name=inventory
GET https://api.ebay.com/developer/analytics/v1_beta/user_rate_limit/?api_context=sell&api_name=inventory
```

**[SPEC]** Both take optional `api_context` and `api_name` query parameters.
`getRateLimits` = **application**-level quota; `getUserRateLimits` = **per-user** quota.
Returned data includes call quota, calls used, calls remaining, reset time, and the time window.

**[UNCONFIRMED] — quota numbers and breach behaviour.** I could not reach eBay's rate-limit page.
From community sources and general REST convention:

- The default application quota for most eBay APIs is commonly cited as **5,000 calls/day per API per
  application**, applied at the application level (shared across all users of your app), with higher
  ceilings available after eBay's **Application Growth Check**.
- **On breach, eBay returns HTTP `429 Too Many Requests`.** Quota resets on a daily window; the
  `getRateLimits` response tells you the exact reset timestamp.
- Community reports note 429s occasionally firing while quota appears to remain — treat 429 as
  authoritative regardless of your own counter.

**Design implications for a single-SKU lister** (this is the actionable part regardless of the exact
number): your publish path costs roughly **3 Inventory calls per product** (item + offer + publish),
plus Taxonomy lookups. At 5,000/day that is ~1,600 products/day, so limits are a non-issue at small
scale — but:

- **Cache aggressively**: `categoryTreeId` (forever), aspects per category (days), policy IDs
  (forever), location key (forever). These are the calls you would otherwise repeat needlessly.
- **Implement exponential backoff with `Retry-After` respect** on 429, and never retry tight-loop.
- **Poll `getRateLimits` on a schedule**, not per request — it consumes quota itself.
- Prefer the **bulk** variants when listing many SKUs: `bulkCreateOrReplaceInventoryItem`,
  `bulkCreateOffer`, `bulkPublishOffer` (**[SPEC]** all exist, **25 records per call**
  **[UNCONFIRMED]** on the exact cap). This cuts call count ~25x.

---

## 10. Consolidated gotcha checklist

1. `Content-Language: de-DE` on `createOrReplaceInventoryItem` and `createOffer` — **required**, and
   wrong values break German aspect validation.
2. `X-EBAY-C-MARKETPLACE-ID` does **nothing** on the Inventory API; use body `marketplaceId`.
3. `createOrReplaceInventoryItem` is a **full replace** — resend every field on update or lose data.
4. Nothing is validated at create time; **all** requirement errors surface at `publishOffer`.
5. `merchantLocationKey` must be set on the offer before publish → the #1 cause of error 25002.
6. Location create returns **204 with no body**; duplicate key returns **409** (treat as success).
7. `listingDuration` must be **`GTC`** for `FIXED_PRICE`.
8. Business Policies opt-in is a **hard prerequisite**; all three policy IDs required to publish.
9. `aspectRequired: true` is the mandatory flag — **not** `aspectUsage`, which says `RECOMMENDED` even
   for mandatory aspects.
10. `aspectMode: SELECTION_ONLY` values must come verbatim from `aspectValues`.
11. Aspect **keys must be the German `localizedAspectName`** ("Marke", not "Brand").
12. `getCategorySuggestions` **does not work in Sandbox** — returns boilerplate.
13. `applyTax` is US/Canada-only; for DE VAT use `vatPercentage`, and only if VAT-registered with eBay.
14. **GPSR `regulatory` block is likely mandatory for ebay.de** — check `getRegulatoryPolicies`.
15. `imageUrls` must be **HTTPS** and publicly crawlable; at least one required to publish.
16. One offer per `sku`/`marketplaceId`/`format` — use `getOffers` + `updateOffer` for idempotency.
17. Effective listing quantity is `min(inventoryItem.quantity, offer.availableQuantity)`.
18. Either `product.description` or `listingDescription` must exist, or publish fails.
19. Resolve `shippingServiceCode` for DE via `GeteBayDetails`; guessing causes error 25007.
20. Title max **80**, description max **4000** (item) / **500000** (offer), SKU max **50**,
    `merchantLocationKey` max **36**, aspect name **40** / value **50**.

## Open items to verify against live docs

- `ProgramTypeEnum` literal for Business Policies (`SELLING_POLICY_MANAGEMENT`).
- Full current `ConditionEnum` list including the newer refurbished / pre-owned tiers.
- `EBAY_DE` category tree ID `77` — corroborated widely; confirm via `getDefaultCategoryTreeId`.
- Valid `shippingServiceCode` / `shippingCarrierCode` / `packageType` values for `EBAY_DE`.
- German `ProductIdentifierUnavailableText` (likely "Nicht zutreffend").
- Exact rate-limit quotas, 429 semantics, and bulk-call record caps.
- Meaning of publish error 25019; authoritative 25xxx error table.
- eBay image dimension/size/format policy limits.
