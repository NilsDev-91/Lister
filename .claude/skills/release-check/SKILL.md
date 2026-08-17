---
name: release-check
description: Manual pre-release checklist for the lister CLI and web UI. Invoke with /release-check before tagging, shipping, or switching EBAY_ENV to production.
disable-model-invocation: true
---

Work through every item and show real output for each — no box is ticked on
assertion alone:

1. `npm run typecheck` and `npm test` pass in full. If
   `db.concurrency.test.ts` fails, rerun it isolated before judging — it is a
   timing-sensitive negative test (see ARCHITECTURE.md).
2. `lister status` renders, shows the intended `EBAY_ENV`, and leaks no
   credential value.
3. Preflight on at least one real listing reports no unexplained blocker
   (`lister preflight <id> -M ebay --category-id <id>` and `-M etsy`).
4. The eBay revise path was used for any live-listing change in this release
   — no end+relist anywhere (`git log` since last tag).
5. ARCHITECTURE.md header and status table reflect this release; new
   invariants and API findings are recorded there.
6. `git status` clean, work pushed, and the release commit does not touch
   `.env` or anything under `~/.3d-print-lister`.
7. Before the first production publish: production keyset + RuName present,
   GPSR `SELLER_*` fields filled (settings page shows the status), and the
   Etsy app purpose covers what ships (docs/research/etsy-api-terms.md).
