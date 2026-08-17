---
name: etsy-api
description: Etsy Open API v3 write quirks. Use when a createDraftListing or updateListing call returns 400, when composing titles, tags or materials that must pass Etsy validation, when writing variations (property_values, price_on_property and friends), or when personalization fields come up.
---

Full endpoint research: docs/research/etsy-listings.md. Legal boundaries for
research calls: docs/research/etsy-api-terms.md. The traps:

- **`createDraftListing` is `application/x-www-form-urlencoded` — the only
  declared content type.** Arrays go as repeated keys (`tags=a&tags=b`).
  `updateListingInventory` is the one JSON PUT.
- **Character rules that exist in no schema** (the spec has no `maxItems`
  anywhere) and surface only as 400s — `types.ts` enforces them pre-wire:
  - Title ≤140 chars; each of `% : & +` at most **once** per title.
  - Tags ≤13, each ≤20 chars, no commas, no leading hyphen/apostrophe.
  - Materials: letters, digits, whitespace only (`/[^\p{L}\p{Nd}\p{Zs}]/u`) —
    `PLA-Plus` is invalid, `PLA Plus` is valid.
  - Parentheses `(` `)` are not allowed in variation property values.
- **Variation write flow:** PUT `/listings/{id}/inventory` with
  `products[].property_values` (`property_id`, `property_name`, `values`);
  `price_on_property` / `quantity_on_property` / `sku_on_property` must name
  the property the products differ by, else 400. Custom properties use ids
  513/514 with free-text values. Read back with `getListingInventory` to
  learn the `value_ids` Etsy assigned. `buildVariationInventory` in
  [src/marketplaces/etsy/client.ts](../../../src/marketplaces/etsy/client.ts)
  builds all of this consistently.
- **Personalization:** the four `personalization_*` listing fields are marked
  deprecated in the live spec with removal date 2026-04-09 (already past).
  Do not build against them.
- **Credentials:** `x-api-key` is `keystring:shared_secret`; OAuth
  `client_id` is the bare keystring. A 403 text does not distinguish wrong
  key from inactive key — check credentials independently; rate-limit
  headers present means the credentials were accepted.
