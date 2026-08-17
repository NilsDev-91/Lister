---
name: ebay-aspects
description: eBay item specifics (aspects) rules for this repo. Use when a publish or preflight rejection cites a missing or invalid item specific, when selecting aspect names/values for a category, when planning colour variations, or when interpreting taxonomy metadata such as aspectRequired, aspectMode, itemToAspectCardinality or aspectMaxLength.
---

The engine is `planAspects` in [src/marketplaces/ebay/aspects.ts](../../../src/marketplaces/ebay/aspects.ts);
metadata parsing sits in `aspect-spec.ts`. Deep dives: ARCHITECTURE.md
("eBay-Artikelmerkmale") and docs/research/ebay-inventory.md. The rules below
are the ones that decide accept-vs-reject:

- **Only `aspectRequired` decides whether an aspect is required.** The API
  reports de-facto required aspects with `aspectUsage: "RECOMMENDED"`; reading
  `usage` builds listings eBay rejects. `usage` is carried only to report the
  contradiction.
- **`aspectMode: SELECTION_ONLY` values must come verbatim from
  `aspectValues`.** `FREE_TEXT` allows own strings. Facet data supplies the
  spelling and tie-breaks, but never overrides a seller's stated fact (PETG
  stays PETG at 9,999 PLA market hits).
- **Respect `aspectMaxLength` by dropping, never truncating.** A truncated
  value is untrue *and* matches no filter.
- **`itemToAspectCardinality`**: `SINGLE` takes one value, `MULTI` up to 30.
- **A missing required aspect is exclusion, not a ranking penalty** — the
  listing vanishes from filtered results. Target ≥10 aspects, floor 7.
- **Names differ per category** (`Ursprungsland` vs `Herstellungsland und
  -region`; `Herstellernummer` as MPN). Custom seller aspects the category
  does not define are kept — eBay accepts them.
- **Variations:** shared aspects belong on the inventory item GROUP's
  `aspects` field; the per-colour items contribute only the varying aspect.
  `aspectEnabledForVariations` is tri-state — an explicit `false` (e.g.
  category 59890 for Farbe) means the category cannot do colour variations.
- **Reach data** comes from the Browse API `ASPECT_REFINEMENTS` field: item
  counts per aspect value from eBay's own index. Response shape per docs, not
  yet verified live.
