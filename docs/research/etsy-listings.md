# Etsy Open API v3 — Creating a Physical, Made-to-Order Listing

**Researched:** 2026-08-10
**Primary source:** Etsy's machine-readable OpenAPI spec, `https://www.etsy.com/openapi/generated/oas/3.0.0.json` (spec version `3.0.0`, 901 KB). Every path, enum, content type and required-field list below was read directly out of that file unless explicitly flagged otherwise.
**Secondary sources:** the official listings tutorial, processing-profiles migration tutorial, rate-limits and authentication essentials pages, and `etsy/open-api` GitHub discussions.

Base URL for all endpoints: `https://openapi.etsy.com`

---

## 0. TL;DR for an auto-publishing tool

1. **`createDraftListing` is `application/x-www-form-urlencoded`, NOT JSON.** This is the single most common integration failure. Only `updateListingInventory` takes JSON.
2. **Creating a draft is free.** The $0.20 listing fee is charged on **activation/publish**, not on `createDraftListing`. Your tool's "publish" button is the billable moment.
3. There is no `listing_type` parameter. The field is called **`type`** with enum `physical | download | both`.
4. For made-to-order you want a **processing profile** (`readiness_state=made_to_order`) referenced by `readiness_state_id`. The legacy `processing_min`/`processing_max` listing fields still exist in the schema but processing profiles are the migration target.
5. Arrays in a form-urlencoded body are sent as **repeated keys** (`tags=a&tags=b`), not JSON arrays.

---

## 1. Authentication

| Item | Value |
|---|---|
| Authorization URL | `https://www.etsy.com/oauth/connect` |
| Token URL (per OAS `securitySchemes`) | `https://openapi.etsy.com/v3/public/oauth/token` |
| Token URL (per authentication essentials page) | `https://api.etsy.com/v3/public/oauth/token` |
| Grant type | `authorization_code` |
| PKCE | **Mandatory**, `code_challenge_method=S256`; verifier 43–128 chars from `[A-Za-z0-9._~-]` |
| Access token lifetime | 3600 s (1 hour) |
| Refresh token lifetime | 90 days |
| Access token format | `<user_id>.<token>` — e.g. `12345678.O1zLuwveeKj...` — the numeric prefix is the user ID |

> **Discrepancy to verify at integration time:** the OAS spec and the prose docs give different hosts for the token endpoint (`openapi.etsy.com` vs `api.etsy.com`). Historically both resolve; prefer `https://api.etsy.com/v3/public/oauth/token` since that is what the human-facing auth page specifies, and fall back to the other on failure.

Every request must carry the `x-api-key` header. The OAS `securitySchemes` description and the auth page both state the value is `keystring:shared_secret` (colon-separated). Note that many community clients send the keystring alone and it works for OAuth-authenticated calls — treat the colon form as documented-correct.

```
x-api-key: <keystring>:<shared_secret>
Authorization: Bearer <access_token>
```

Refresh:

```http
POST /v3/public/oauth/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&client_id=<keystring>&refresh_token=<refresh_token>
```

### Scopes required (read from each operation's `security` block)

| Operation | Scope |
|---|---|
| `createDraftListing` | `listings_w` |
| `uploadListingImage` | `listings_w` |
| `updateListing` | `listings_w` |
| `updateListingInventory` | `listings_w` |
| `getShopShippingProfiles` | `shops_r` |
| `createShopShippingProfile` | `shops_w` |
| `getSellerTaxonomyNodes` | *(no `security` block — API key only, no OAuth needed)* |

Add `listings_r` for reads and `listings_d` for deletes.

---

## 2. createDraftListing

```
POST /v3/application/shops/{shop_id}/listings
Content-Type: application/x-www-form-urlencoded
```

**The request body content type is `application/x-www-form-urlencoded` and that is the ONLY content type the spec declares for this operation.** Sending JSON returns a 400. Arrays (`tags`, `materials`, `image_ids`, `styles`, `production_partner_ids`) are encoded as repeated keys.

### Required fields (exact `required` array from the spec)

```json
["quantity", "title", "description", "price", "who_made", "when_made", "taxonomy_id"]
```

That is the complete hard-required set at **draft** creation. Everything else — including `shipping_profile_id` and `return_policy_id` — is optional *for the draft* but becomes required to **activate** a physical listing.

### Full parameter table

| Param | Type | Notes |
|---|---|---|
| `quantity` | integer | Positive non-zero. Sum of offering quantities. **Required** |
| `title` | string | **Required.** See constraints §3 |
| `description` | string | **Required** |
| `price` | number | **Required.** Positive non-zero. This is the *minimum* price; exact per-offering prices come from inventory |
| `who_made` | string enum | **Required.** See enum below |
| `when_made` | string enum | **Required.** See enum below |
| `taxonomy_id` | integer (min 1) | **Required.** From `getSellerTaxonomyNodes` |
| `shipping_profile_id` | integer (min 1) | Required when `type=physical` **at activation** |
| `return_policy_id` | integer (min 1) | Required for active physical listings; *does not apply to EU-based shops* |
| `readiness_state_id` | integer (min 1) | Processing profile ID — the made-to-order lever |
| `processing_min` | integer | Legacy min days to process |
| `processing_max` | integer | Legacy max days to process |
| `materials` | array of string | Regex `/[^\p{L}\p{Nd}\p{Zs}]/u` — letters, digits, whitespace only |
| `tags` | array of string | Regex `/[^\p{L}\p{Nd}\p{Zs}\-'™©®]/u` |
| `styles` | array of string | **Max 2**, each ≤ **45 chars**, letters/digits/whitespace only |
| `shop_section_id` | integer (min 1) | |
| `item_weight` | number | > 0 if set |
| `item_length` / `item_width` / `item_height` | number | > 0 if set |
| `item_weight_unit` | string enum | `oz`, `lb`, `g`, `kg` |
| `item_dimensions_unit` | string enum | `in`, `ft`, `mm`, `cm`, `m`, `yd`, `inches` |
| `is_supply` | boolean | `true` = supply, `false` = finished product |
| `type` | string enum | `physical`, `download`, `both`. **Not `listing_type`** |
| `is_customizable` | boolean | |
| `is_taxable` | boolean | |
| `should_auto_renew` | boolean | Renews for four months on expiry |
| `image_ids` | array of integer | "can include up to 20 images" |
| `production_partner_ids` | array of integer | |
| `is_personalizable` | boolean | **DEPRECATED — removed 2026-04-09** |
| `personalization_is_required` | boolean | **DEPRECATED — removed 2026-04-09** |
| `personalization_char_count_max` | integer | **DEPRECATED — removed 2026-04-09** |
| `personalization_instructions` | string | **DEPRECATED — removed 2026-04-09** |

> The four `personalization_*` fields are marked deprecated in the live spec with a removal date of **April 9, 2026** — which has already passed as of this research date. Do not build against them; use the personalization migration path instead.

### Exact enum values

`who_made` — exactly three values:
```
i_did
someone_else
collective
```
For a 3D-printed product you print yourself: **`i_did`**.

`when_made` — exactly nineteen values:
```
made_to_order
2020_2026
2010_2019
2007_2009
before_2007
2000_2006
1990s
1980s
1970s
1960s
1950s
1940s
1930s
1920s
1910s
1900s
1800s
1700s
before_1700
```
For made-to-order 3D printing: **`made_to_order`**.

`is_supply` for a finished printed object: **`false`**.

Note the spec's own wording: `who_made`, `when_made` and `is_supply` are mutually dependent — each one's description says it "Requires" the other two. Always send all three together.

### Real request body — made-to-order 3D print

```http
POST /v3/application/shops/12345678/listings HTTP/1.1
Host: openapi.etsy.com
Authorization: Bearer 12345678.abcdef...
x-api-key: <keystring>:<shared_secret>
Content-Type: application/x-www-form-urlencoded

quantity=999
&title=Articulated%20Dragon%20Fidget%20Toy%20%7C%203D%20Printed%20Flexi%20Desk%20Decor
&description=Printed%20to%20order%20in%20PLA.%20Choose%20your%20color%20at%20checkout.
&price=24.99
&who_made=i_did
&when_made=made_to_order
&taxonomy_id=1181
&type=physical
&is_supply=false
&shipping_profile_id=6722757781
&return_policy_id=1234567890
&readiness_state_id=18201076875
&materials=PLA&materials=Biodegradable%20Plastic
&tags=3d%20printed&tags=articulated%20dragon&tags=flexi%20toy&tags=desk%20decor&tags=fidget%20toy
&item_weight=120&item_weight_unit=g
&item_length=22&item_width=6&item_height=3&item_dimensions_unit=cm
&is_taxable=true
&should_auto_renew=true
```

Equivalent curl:

```bash
curl -X POST "https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-api-key: ${KEYSTRING}:${SHARED_SECRET}" \
  --data-urlencode "quantity=999" \
  --data-urlencode "title=Articulated Dragon Fidget Toy | 3D Printed Flexi Desk Decor" \
  --data-urlencode "description=Printed to order in PLA." \
  --data-urlencode "price=24.99" \
  --data-urlencode "who_made=i_did" \
  --data-urlencode "when_made=made_to_order" \
  --data-urlencode "taxonomy_id=1181" \
  --data-urlencode "type=physical" \
  --data-urlencode "is_supply=false" \
  --data-urlencode "shipping_profile_id=${SHIPPING_PROFILE_ID}" \
  --data-urlencode "return_policy_id=${RETURN_POLICY_ID}" \
  --data-urlencode "readiness_state_id=${READINESS_STATE_ID}" \
  --data-urlencode "materials=PLA" \
  --data-urlencode "tags=3d printed" \
  --data-urlencode "tags=flexi toy" \
  --data-urlencode "item_weight=120" \
  --data-urlencode "item_weight_unit=g"
```

Response: a `ShopListing` object whose `listing_id` you carry into the image upload and inventory steps. `state` will be `draft`.

---

## 3. Title, tag and material constraints

### Character-set rules (verbatim from the spec — these ARE primary-source)

- **Title:** "valid title strings contain only letters, numbers, punctuation marks, mathematical symbols, whitespace characters, ™, © and ®" — regex `/[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u`. **You can only use the `%`, `:`, `&` and `+` characters once each.** That last rule is a real-world trap: a title like `Red & Blue & Green` is rejected.
- **Tags:** only letters, numbers, whitespace, `-`, `'`, ™, ©, ® — regex `/[^\p{L}\p{Nd}\p{Zs}\-'™©®]/u`. No commas inside a tag (comma is the separator).
- **Materials:** only letters, numbers and whitespace — regex `/[^\p{L}\p{Nd}\p{Zs}]/u`. No hyphens, no punctuation. `PLA-Plus` is invalid; `PLA Plus` is valid.
- **Styles:** letters/digits/whitespace only, **max 2 styles, 45 chars each** (spec-stated).

### Numeric limits

| Limit | Value | Confidence |
|---|---|---|
| Max title length | **140 characters** | Not in the OAS spec — no `maxLength` is declared on `title`. Widely and consistently documented as 140 by Etsy seller docs and third-party tooling. Treat as reliable, validate client-side. |
| Max tags | **13** | Not in the OAS spec (no `maxItems` anywhere in the file). Long-standing, consistently documented Etsy platform limit. |
| Max chars per tag | **20** | Same — not spec-encoded, consistently documented. |
| Max materials | **13** | **Unconfirmed.** This was the documented Etsy v2 limit and is repeated by third-party tools, but I could not confirm it from any current primary Etsy source. |
| Max chars per material | **45** | **Unconfirmed** — inferred from the v2 limit and the analogous `styles` limit. |
| Max styles | 2, 45 chars each | Spec-stated ✅ |

> **Important methodological note:** I grepped the entire 901 KB OpenAPI file for `maxItems`, `140`, `13 tag` and `20 char`. There are **zero `maxItems` declarations in the whole spec**, and no numeric title length. Etsy does **not** encode the 140/13/20 limits in its machine-readable schema — they are enforced server-side and will surface as 400s. Your tool must validate these itself; do not expect schema validation to catch them.

---

## 4. uploadListingImage

```
POST /v3/application/shops/{shop_id}/listings/{listing_id}/images
Content-Type: multipart/form-data
```

### Multipart field names (exact, from the spec)

| Field | Type | Default | Notes |
|---|---|---|---|
| `image` | string/binary | — | The file part. Field name is literally `image` |
| `listing_image_id` | integer (min 1) | — | Reuse an existing uploaded image |
| `rank` | integer (min 0) | `1` | Display position; **rank 1 is the left-most / primary image** |
| `overwrite` | boolean | `false` | Replace the existing image at that rank |
| `is_watermarked` | boolean | `false` | |
| `alt_text` | string | `""` | **Max 500 characters** per current spec |

> The generated `gordonturner/etsy-open-api-client` docs list camelCase names (`listingImageId`, `isWatermarked`, `altText`) — those are **Java client method names, not wire field names**. The wire format is snake_case as above. That client also states `alt_text` max is 250 chars; the current live spec says **500**. Trust the live spec.

One image per request — upload N images with N calls, incrementing `rank`.

```bash
curl -X POST "https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${LISTING_ID}/images" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-api-key: ${KEYSTRING}:${SHARED_SECRET}" \
  -F "image=@/path/to/dragon_render_01.jpg" \
  -F "rank=1" \
  -F "alt_text=Articulated 3D printed dragon in teal PLA on a wooden desk"
```

### Image constraints

**None of the size/format constraints are in the OpenAPI spec.** The spec declares only `type: string, format: binary`. The following comes from Etsy's seller help centre and is **secondary/unconfirmed against a primary API source** (the help page returned HTTP 403 to automated fetch):

| Constraint | Value | Confidence |
|---|---|---|
| Formats | JPG, PNG, GIF | Secondary |
| Max file size | **10 MB** (some sources say 20 MB / 50 MB) | **Conflicting** — build for 10 MB to be safe |
| Animated GIF / transparent PNG | **Not supported** | Secondary |
| Recommended dimensions | 2000×2000 px minimum, 3000×3000 px preferred, 1:1 | Secondary |
| Max images per listing | **10** per seller help; but the OAS `image_ids` description says "**up to 20 images**" | **Conflicting — flagged.** The spec text says 20; Etsy's seller-facing docs say 10. Cap at 10 in your tool and treat 11–20 as untested. |

---

## 5. Activating the listing (state → active)

```
PATCH /v3/application/shops/{shop_id}/listings/{listing_id}
Content-Type: application/x-www-form-urlencoded
```

Method is **PATCH**, not PUT. Body is form-urlencoded, same as create.

`state` enum on update is exactly `["active", "inactive"]` — you cannot PATCH a listing back to `draft`.

```bash
curl -X PATCH "https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/listings/${LISTING_ID}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-api-key: ${KEYSTRING}:${SHARED_SECRET}" \
  --data-urlencode "state=active"
```

From the spec's own description of `state`: *"Setting a `draft` listing to `active` will also publish the listing on etsy.com and requires that the listing have an image set. Setting a `sold_out` listing to active will update the quantity to 1 and renew the listing."*

**Preconditions for a successful activation of a physical listing:**
- at least one image uploaded
- `shipping_profile_id` set
- `return_policy_id` set (except for EU-based shops)
- `readiness_state_id` set (processing profile — see §7)

`updateListing` accepts essentially the whole createDraftListing field set plus `state` and `featured_rank`, so you can set missing required fields and flip to active in **one** PATCH call.

---

## 6. updateListingInventory — variations and SKUs

```
PUT /v3/application/listings/{listing_id}/inventory
Content-Type: application/json
```

Note: **this is the one JSON endpoint in the flow**, it is **PUT**, and the path is **listing-scoped, not shop-scoped** (no `{shop_id}`). Optional query param: `max_variations_supported`.

Top-level required: `["products"]`.

### Structure

- `products` (array, required) — every product, even if there's only one
  - `sku` (string, nullable)
  - `property_values` (array)
    - required per entry: `property_id`, `value_ids`, `values`
    - `property_id` (int64, min 1)
    - `value_ids` (array of int64, min 1)
    - `values` (array of string)
    - `scale_id` (int64, nullable) — e.g. shoe-size scale; `US/Canada` is `19`
    - `property_name` (string)
    - **Parenthesis characters `(` and `)` are not allowed in property values**
  - `offerings` (array, **required** on each product)
    - required per entry: `price`, `quantity`, `is_enabled`, `readiness_state_id`
    - `price` (float), `quantity` (int64), `is_enabled` (bool), `readiness_state_id` (int64, nullable)
- `price_on_property` (array of int64) — property IDs whose value changes price
- `quantity_on_property` (array of int64)
- `sku_on_property` (array of int64)
- `readiness_state_on_property` (array of int64) — property IDs that change the processing profile

> `readiness_state_id` is in the **required** list for each offering, though it is nullable. Send it explicitly (as a value or `null`) rather than omitting it.

### Real body — two colour variations with per-variant SKUs

```json
{
  "products": [
    {
      "sku": "DRAGON-FLEXI-TEAL",
      "property_values": [
        {
          "property_id": 200,
          "property_name": "Primary color",
          "scale_id": null,
          "value_ids": [1213],
          "values": ["Teal"]
        }
      ],
      "offerings": [
        {
          "price": 24.99,
          "quantity": 999,
          "is_enabled": true,
          "readiness_state_id": 18201076875
        }
      ]
    },
    {
      "sku": "DRAGON-FLEXI-BLACK",
      "property_values": [
        {
          "property_id": 200,
          "property_name": "Primary color",
          "scale_id": null,
          "value_ids": [1213432],
          "values": ["Black"]
        }
      ],
      "offerings": [
        {
          "price": 24.99,
          "quantity": 999,
          "is_enabled": true,
          "readiness_state_id": 18201076875
        }
      ]
    }
  ],
  "price_on_property": [],
  "quantity_on_property": [],
  "sku_on_property": [200],
  "readiness_state_on_property": []
}
```

For a **custom** (non-Etsy-catalogue) variation, use a custom property (`513`/`514` are the "Custom Property 1/2" IDs in Etsy's taxonomy) and pass free-text `values` with `value_ids` omitted or matched to what `getListingInventory` returns after the first write. Read back with `GET /v3/application/listings/{listing_id}/inventory` to learn the IDs Etsy assigned.

### Variation product-count caps (from the listings tutorial)

| Variations | Max products |
|---|---|
| 1 | 70 |
| 2 | 4,900 |
| 3 | 2,500 |

> The 2-vs-3 numbers look inverted but that is what the tutorial states verbatim. Verify empirically before relying on the 3-variation case.

Only properties where `supports_variations: true` (from `getPropertiesByTaxonomyId`) can be used for variations.

---

## 7. Prerequisites: taxonomy, shipping, processing, return policy

### taxonomy_id

```
GET /v3/application/seller-taxonomy/nodes
```
No OAuth required — API key only. Returns the full seller taxonomy tree; walk it and match your category. Cache this aggressively, it changes rarely and it's a large response.

Property metadata for a chosen node (needed to build variations):
```
GET /v3/application/seller-taxonomy/nodes/{taxonomy_id}/properties
```

### shipping_profile_id

```
GET  /v3/application/shops/{shop_id}/shipping-profiles      (scope shops_r)
POST /v3/application/shops/{shop_id}/shipping-profiles      (scope shops_w)
Content-Type: application/x-www-form-urlencoded
```

`createShopShippingProfile` required: `["title", "origin_country_iso", "primary_cost", "secondary_cost"]`

Other params: `min_processing_time`, `max_processing_time`, `processing_time_unit` (enum `business_days` | `weeks` — **note this differs from the processing-profile enum**), `destination_country_iso`, `destination_region` (enum `eu` | `non_eu` | `none`), `origin_postal_code` (required where the origin country uses postal codes), `shipping_carrier_id` + `mail_class` (must be sent together), `min_delivery_days` + `max_delivery_days` (must be sent together).

You must supply `destination_country_iso` **or** `destination_region`.

```bash
curl -X POST "https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/shipping-profiles" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-api-key: ${KEYSTRING}:${SHARED_SECRET}" \
  --data-urlencode "title=DE Standard - 3D Prints" \
  --data-urlencode "origin_country_iso=DE" \
  --data-urlencode "origin_postal_code=10115" \
  --data-urlencode "primary_cost=4.50" \
  --data-urlencode "secondary_cost=1.50" \
  --data-urlencode "destination_region=eu" \
  --data-urlencode "min_processing_time=3" \
  --data-urlencode "max_processing_time=7" \
  --data-urlencode "processing_time_unit=business_days"
```

### readiness_state_id — the made-to-order profile

```
POST /v3/application/shops/{shop_id}/readiness-state-definitions
GET  /v3/application/shops/{shop_id}/readiness-state-definitions
GET/PUT/DELETE .../readiness-state-definitions/{readiness_state_definition_id}
Content-Type: application/x-www-form-urlencoded
```

Required: `["readiness_state", "min_processing_time", "max_processing_time"]`

- `readiness_state` enum: **`ready_to_ship` | `made_to_order`** ← use `made_to_order`
- `processing_time_unit` enum: **`days` | `weeks`**, default `days` (note: *not* `business_days`, unlike shipping profiles)

```bash
curl -X POST "https://openapi.etsy.com/v3/application/shops/${SHOP_ID}/readiness-state-definitions" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "x-api-key: ${KEYSTRING}:${SHARED_SECRET}" \
  --data-urlencode "readiness_state=made_to_order" \
  --data-urlencode "min_processing_time=3" \
  --data-urlencode "max_processing_time=7" \
  --data-urlencode "processing_time_unit=days"
```

Processing profiles are migrating away from shipping-profile-level processing times. Per the migration tutorial: *"Every listing requires at least one processing profile to be linked to it"* (physical listings; digital exempt). Set `readiness_state_id` on the listing, or per-offering in inventory, or vary it by property via `readiness_state_on_property`.

### return_policy_id

```
GET /v3/application/shops/{shop_id}/policies/return
```
Required for **active** physical listings, except for EU-based shops. There is no create endpoint exposed for return policies — the seller must define them in Shop Manager, so your tool should fetch and let the user pick.

---

## 8. Rate limits

| Limit | Value |
|---|---|
| Queries per second (QPS), default | **10** |
| Queries per day (QPD), default | **10,000** |

Applied **per API key** (for both public and private auth). Visible in the Developer Portal under Your Apps. Increases via email to `developer@etsy.com` with an app description and estimated QPD/QPS.

### Response headers reporting quota (exact names)

```
x-limit-per-second        your app's QPS limit
x-remaining-this-second   calls left in the current second
x-limit-per-day           your app's QPD limit
x-remaining-today         calls left in the rolling 24h window
```

On breach: HTTP **429** with a **`retry-after`** header giving seconds to wait.

The daily quota uses a **progressive sliding-window** algorithm over a rolling 24 h — not a midnight reset. Quota from expiring buckets is freed continuously. Etsy explicitly recommends caching plus exponential backoff on 429.

**Budget implication:** a full publish is roughly 4–8 calls (create + N images + inventory + activate). At 10,000 QPD that's ~1,200–2,500 listings/day ceiling, and the 10 QPS cap means you should serialise image uploads with a small delay rather than firing them in parallel.

---

## 9. Listing fees — critical for auto-publishing

**`createDraftListing` does NOT charge the $0.20 listing fee. The fee is incurred when the listing is activated/published.**

A draft listing is not buyer-visible, is not searchable, and is not billed. The charge lands on the seller's payment account at the moment the listing goes `active` — i.e. on your `PATCH state=active` call, or if you create and activate in one flow.

Practical consequences for a tool that publishes automatically:
- Every successful activation is a real €/$0.20 charge to the user. Gate it behind explicit user confirmation; never auto-activate in a retry loop.
- A failed activation that Etsy partially processed can still bill. Make activation idempotent — check listing `state` before retrying rather than blindly re-PATCHing.
- Listings auto-renew every four months if `should_auto_renew=true`, and **each renewal is another $0.20**. Default this to `false` unless the user opts in.
- Expired listings are explicitly *not* charged (per the listings tutorial lifecycle description).
- Drafts are a free staging area — build and validate the entire listing as a draft, then charge once.

> Confidence: the draft-is-free / activation-is-billed distinction is consistently stated across Etsy's own draft-listing documentation and seller help, but I did not find it asserted inside the API reference itself. It is Etsy billing policy rather than an API contract, so the *amount* ($0.20) can change by region and over time — do not hard-code the figure in user-facing copy.

---

## 10. Recommended call sequence

```
1.  GET  /v3/application/seller-taxonomy/nodes                        → taxonomy_id      [cache]
2.  GET  /v3/application/shops/{shop_id}/shipping-profiles            → shipping_profile_id
    (or POST to create one)
3.  GET  /v3/application/shops/{shop_id}/readiness-state-definitions  → readiness_state_id
    (or POST with readiness_state=made_to_order)
4.  GET  /v3/application/shops/{shop_id}/policies/return              → return_policy_id
5.  POST /v3/application/shops/{shop_id}/listings                     → listing_id   [FREE, form-urlencoded]
6.  POST .../listings/{listing_id}/images   × N, rank=1..N                          [multipart]
7.  PUT  /v3/application/listings/{listing_id}/inventory                             [JSON]
8.  PATCH .../listings/{listing_id}  state=active                     ← $0.20 CHARGED HERE
```

Steps 1–4 are cacheable per shop and should not run per listing.

---

## 11. Open questions / unconfirmed items

1. **Max materials count and per-material length** (assumed 13 / 45) — not confirmable from any current primary Etsy source.
2. **Max images per listing** — spec text says 20, seller docs say 10. Conflict unresolved.
3. **Max image file size** — sources give 10 MB, 20 MB and 50 MB. Unresolved.
4. **Token endpoint host** — OAS says `openapi.etsy.com`, auth docs say `api.etsy.com`.
5. **`x-api-key` value format** — docs say `keystring:shared_secret`; much community code sends the keystring alone and reports success.
6. **Title 140 / tags 13 / tag 20 chars** — universally documented but *not* encoded in the OpenAPI schema; enforced server-side only.
7. **Variation product caps** — the tutorial's 2-variation (4,900) vs 3-variation (2,500) figures appear inverted.
8. **Processing-profile rollout status** — the migration tutorial mentions early access from July 16 with a 60-day transition and instructs third-party developers to use test shops. Whether processing profiles are now fully GA for production shops needs verification against the current changelog before launch.
9. **Personalization fields** — spec still lists them with a removal date of 2026-04-09, already past. Whether they still function is unverified.

---

## Sources

- `https://www.etsy.com/openapi/generated/oas/3.0.0.json` — official machine-readable OpenAPI spec (primary source for all paths, enums, content types, required fields)
- `https://developers.etsy.com/documentation/tutorials/listings` — listings tutorial
- `https://developer.etsy.com/documentation/tutorials/migration/` — processing profiles migration
- `https://developers.etsy.com/documentation/essentials/rate-limits` — rate limits and headers
- `https://developers.etsy.com/documentation/essentials/authentication/` — OAuth 2.0 / PKCE
- `https://github.com/etsy/open-api/discussions/1524` — "Updated Requirements for Listing Drafts"
- `https://github.com/gordonturner/etsy-open-api-client/blob/main/docs/ShopListingImageApi.md` — generated client docs (used only for cross-checking; camelCase names there are client-side)
- `https://help.etsy.com/hc/en-us/articles/115015663347` — image requirements (403 to automated fetch; content via search summaries)
