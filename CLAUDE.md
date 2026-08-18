# Working in this repo

ARCHITECTURE.md is the handover document. Decisions recorded there are
deliberate — verify against it before treating behaviour as a bug.

## Invariants that protect money and live listings

- Live listings are updated with `revise` (in place). eBay keeps the item ID,
  watchers and sale history that way; ending and relisting throws them away.
- A publish runs exactly once. Retrying a publish mints a duplicate listing
  with a second fee — recover by inspecting remote state, never by re-running.
- Selling needs either a licence that provably permits it or an explicit
  rights assertion from the seller. An unknown or unparseable licence blocks
  the publish; drafting stays allowed. (The web create form pre-selects the
  assertion checkbox — a deliberate, documented decision; see ARCHITECTURE.md
  Nachtrag 2026-08-18 (4). It stays a per-creation choice, never stored
  config.)
- Etsy own-design is default-deny with exactly one way through: the recorded
  per-listing risk acceptance (`etsyDesignRiskAccepted`, stored with time and
  source URL). It unlocks only that gate — never the licence rules or media
  reuse — and is never a default or a global setting.
- Etsy uploads only the seller's own photos. Source-platform downloads never
  reach Etsy and there is no override for this; eBay's image handling is
  separate and unchanged.
- In the eBay sandbox, pass `--category-id` explicitly: the category
  suggestion endpoint responds with HTTP 200 and garbage there.

## Facts that look wrong but are right

- Etsy auth uses two shapes of the same credential: `x-api-key` is
  `keystring:shared_secret`, while OAuth's `client_id` is the bare keystring.
- Tests run entirely offline. A test that needs the network is a bug in the
  test.
