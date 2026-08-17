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
  the publish; drafting stays allowed.
- In the eBay sandbox, pass `--category-id` explicitly: the category
  suggestion endpoint responds with HTTP 200 and garbage there.

## Facts that look wrong but are right

- Etsy auth uses two shapes of the same credential: `x-api-key` is
  `keystring:shared_secret`, while OAuth's `client_id` is the bare keystring.
- Tests run entirely offline. A test that needs the network is a bug in the
  test.
