---
name: licence-gate
description: MakerWorld licence handling and the sale gate. Use when a publish is refused for licence reasons, when changing anything in src/makerworld/license.ts or the rights toggles (licenseOverridden, sourceImagesLicensed), or when a licence string fails to parse or parses unexpectedly.
---

The decision table is `MAKERWORLD_LICENSES` in
[src/makerworld/license.ts](../../../src/makerworld/license.ts); rationale and
history in ARCHITECTURE.md ("Wo das Lizenz-Gate sitzt") and
docs/research/makerworld.md. The load-bearing rules:

- **MakerWorld licence values are bare** (`BY-NC`, not `CC BY-NC`). Exact
  matching runs before any CC-anchored regex, which would miss all of them.
- **Sale permission:** CC0, BY, BY-SA, BY-ND → yes. Every NC variant, all
  SDFL variants (including Community Use and Platform Print Only) and the
  MakerWorld Exclusive License → no.
- **Default deny.** Unknown or unparseable → `commercialUse: 'unknown'` →
  confirmation required, never a silent pass. The text fallback that reads a
  licence out of page text is deliberately conservative: an invented
  permissive licence would bypass this gate (see the 2026-08-17 hardening).
- **The gate sits at publish, not at create.** Drafting is free and local;
  `requireSaleRights` blocks `commercialUse: 'no'` in BOTH publish paths,
  including with `--skip-preflight`. Overrides go through the create flag or
  the rights toggle on the listing — both reversible.
- **Two separate assertions.** `licenseOverridden` claims sale rights for the
  model only. `sourceImagesLicensed` is a second, independent claim for the
  designer's photos and only takes effect together with the first (images
  cannot be licensed for a sale that is not). Text reuse is never unlocked:
  MakerWorld licenses "Model Collateral" to the platform, not to subscribers.
- **After an override, the copy must not name the page licence** — preflight
  flags "Listing text names a licence", because the page licence is then not
  the licence the sale runs under.
