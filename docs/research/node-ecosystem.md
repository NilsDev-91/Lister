# Node / TypeScript Ecosystem Survey — 3d-print-lister CLI

**Research date:** 2026-08-10
**Scope:** what exists and what is current. No application design here.
**Method:** npm registry API (`registry.npmjs.org`) for versions/dates/deps, GitHub API for repo health, live Etsy OpenAPI spec, vendor docs + community threads for the OAuth constraints.

All versions and publish dates below were read directly from the npm registry on 2026-08-10 unless noted.

---

## 0. TL;DR — recommendation per slot

| Slot | Pick | Version (2026-08-10) | Confidence |
|---|---|---|---|
| Runtime | Node 24 LTS (Active LTS) | 24.x | High |
| eBay Sell API client | `ebay-api` (hendt) | 10.0.0 | High |
| eBay OAuth | `ebay-api`'s built-in OAuth2, **not** `ebay-oauth-nodejs-client` | — | High |
| Etsy v3 client | `etsy-ts` for types; hand-rolled fetch for the ~6 calls actually needed | 7.3.1 | Medium |
| Etsy OAuth | Hand-rolled PKCE (~40 lines) — no library needed | — | High |
| CLI framework | `commander` | 15.0.0 | High |
| Validation | `zod` v4 | 4.4.3 | High |
| Local DB | `node:sqlite` (built-in) | Node 24/26 | Medium-High |
| Secret storage | `@napi-rs/keyring` + encrypted-file fallback | 1.3.0 | High |
| Image processing | `sharp` | 0.35.3 | High |
| Multipart upload | Native `fetch` + `FormData` + `Blob` (built-in) | — | High |
| Browser launch | `open` | 11.0.0 | High |
| Prompts | `@clack/prompts` or `@inquirer/prompts` | 1.7.0 / 8.5.2 | Medium |

**Two findings that constrain everything else** (details in §3 and §7):

1. **eBay does not permit an `http://localhost` redirect URI.** The classic loopback-with-ephemeral-port pattern does not work against eBay as-is. See §3.
2. **eBay's `UploadSiteHostedPictures` (Trading API) is decommissioned 2026-09-30** — seven weeks from now. Any image upload path must target the Media API's `createImageFromFile` / `createImageFromUrl` from day one. See §7.

---

## 1. Runtime baseline

| Release | Status as of Aug 2026 | Notes |
|---|---|---|
| Node 22 | Maintenance LTS | still gets `node:sqlite`, but at an older feature level |
| **Node 24** | **Active LTS** | supported to 2028-04-30. The safe target. |
| Node 26 | Current (released 2026-05-05) | enters LTS Oct 2026 |

Practical floor is pushed up by the tooling itself:

- `commander@15` declares `engines.node: ">=22.12.0"` and is **ESM-only** (`"type": "module"`, single `default: ./index.js` export — no CJS require path).
- `yargs@18` declares `^20.19.0 || ^22.12.0 || >=23`.
- `better-sqlite3@13` declares `>=22`.
- `undici@8` declares `>=22.19.0`.
- `open@11` is ESM-only, `>=20`.
- `sharp@0.35.3` declares `>=20.9.0`.

**Recommendation: target Node 24 LTS, ship as ESM.** Nothing in the candidate stack still ships dual CJS/ESM as a first-class path, and fighting that is wasted effort in 2026.

---

## 2. eBay packages

### 2.1 `ebay-api` (hendt) — RECOMMENDED

| | |
|---|---|
| npm name | `ebay-api` (**note the rename** — the old `@hendt/ebay-api` is stuck at 6.0.1, last published 2022, do not use) |
| Latest | **10.0.0**, published **2026-07-29** |
| Prior releases | 9.6.0 (2026-07-21), 9.5.2 (2026-05-11), 9.5.1 (2026-04-04) — 94 versions total |
| Repo | `github.com/hendt/ebay-api` — not archived, last push **2026-08-01**, 208 stars, **7 open issues** |
| License | MIT |
| TypeScript | **Native.** Written in TS, ships `lib/index.d.ts`. Types are generated from eBay's OpenAPI specs (`operations` types per API). |
| Runtime deps | `axios`, `debug`, `fast-xml-parser`, `qs` |
| Weekly downloads | ~14,400 |

**Coverage — confirmed from the repo README and source:**

- **Sell:** Account (v1 **and v2**), Analytics, Feed, Finance, Fulfillment, **Inventory (v1.18.5)**, Listing, Logistics, Marketing, Metadata, Negotiation, Recommendation, Stores
- **Commerce:** Catalog, Charity, Feedback, Identity, **Media (v1_beta.5.0)**, Message, Notification, **Taxonomy**, Translation
- **Buy:** Browse, Deal, Feed, Marketing, Offer, Order, Marketplace Insights
- **Traditional (XML):** Trading, Shopping, Merchandising, Client Alerts, Feedback
- **Developer:** Analytics, Key Management

So it covers **everything this CLI needs**: Inventory API (create inventory item, offers, publish), Taxonomy (category + item aspects), Account (policies), and Media (image upload).

**OAuth coverage — confirmed:**

- Authorization Code grant: builds the consent URL, exchanges the code, stores the token set
- Client Credentials grant: application tokens minted automatically for unrestricted GETs
- Auth'N'Auth (legacy) also supported
- **Automatic refresh on expiry**, with `refreshAuthToken` / `refreshClientToken` event emitters so you can persist the rotated token
- Scopes settable via constructor or `setScope()`
- Redirect configured as a `ruName` constructor parameter (correctly modelling eBay's RuName-not-URL design)

**Media API confirmed present** (`src/api/restful/commerce/media/index.ts`), including the methods that matter after the September decommission:

```
createImageFromFile(body)  -> POST /commerce/media/v1_beta/image/create_image_from_file   (multipart)
createImageFromUrl(body)   -> POST /commerce/media/v1_beta/image/create_image_from_url
getImage(imageId)          -> GET  /commerce/media/v1_beta/image/{imageId}
createVideo / uploadVideo / createDocument / uploadDocument
```

**Verdict vs raw fetch: use the library.** The value is not the HTTP plumbing — it is (a) the generated types for the Inventory API request/response shapes, which are large and fiddly, (b) automatic token refresh with an event hook, (c) correct base-path/subdomain routing across the ~30 eBay API families, and (d) the digital-signature (ED25519, Key Management API) support that EU/UK sellers need on Finances and some Fulfillment methods. Reimplementing (d) alone is a multi-day job.

**Caveats to plan around:**

- Built on **axios**, not native fetch. That is one more dependency tree and one more error-shape to normalize, but not a blocker.
- v10.0.0 is **five weeks old**. It is a breaking release (removed eBay-decommissioned Finding API and 29+ deprecated post-order methods). Public interface is documented as unchanged, but pin the exact version and read the changelog before bumping.
- `createImageFromFile(body?: any)` is **untyped** and sets `Content-Type: multipart/form-data` as a literal header with **no boundary parameter** (`src/request.ts`, `multipartHeader`). Manually setting Content-Type without a boundary normally defeats axios's automatic boundary injection. **Verify this call actually works before committing to it** — the fallback is to hand-roll that one POST with native `fetch` + `FormData` (which sets the boundary correctly) while using the library for everything else.

### 2.2 `ebay-oauth-nodejs-client` (official eBay) — DO NOT USE

| | |
|---|---|
| Latest | **1.2.2**, published **2022-09-13** — nearly four years stale |
| Versions | 5 total, ever |
| Repo | `github.com/eBay/ebay-oauth-nodejs-client` — not archived, but last push **2024-07-25**, 12 open issues |
| TypeScript | **None.** No `types` field, no bundled `.d.ts`, no `@types/ebay-oauth-nodejs-client` on npm |
| Deps | `querystring` — a userland shim for a Node builtin that has been legacy-status for years |
| Weekly downloads | ~18,700 (higher than `ebay-api`, but that is legacy inertia, not health) |

It is eBay-published, which is the only argument in its favor, and that argument is weak: it does OAuth only (no Inventory/Media/Taxonomy), has no types, and has not shipped a release in four years. `ebay-api` does the same job with types and active maintenance. **Skip it.**

### 2.3 eBay auth facts worth recording

- User access token: **7,200 s (2 hours)**
- Refresh token: **~47,304,000 s (18 months)**; when it expires the user must re-consent
- Application (client-credentials) token: 7,200 s
- Authorize: `https://auth.ebay.com/oauth2/authorize` (sandbox: `auth.sandbox.ebay.com`)
- Token: `https://api.ebay.com/identity/v1/oauth2/token` (sandbox: `api.sandbox.ebay.com`)
- Scopes needed for this CLI: `https://api.ebay.com/oauth/api_scope/sell.inventory`, `.../sell.account`, plus `.../sell.inventory.readonly` and `.../sell.account.readonly` if you want read-only modes. Mint with **all** scopes up front — adding a scope later forces full re-consent.

---

## 3. The OAuth loopback problem — READ THIS FIRST

The standard native-app pattern (RFC 8252): bind an `http` server to `127.0.0.1:0`, let the OS pick an **ephemeral port**, register `http://127.0.0.1:{port}/callback` as the redirect, open the system browser, capture the `code` from the callback.

**This pattern does not work against either marketplace as written.** Two separate obstacles.

### 3.1 eBay — no `http://localhost`, and RuName is not a URL

eBay's redirect is not a URL parameter at all. You register up to three URLs in the developer portal (auth-accepted, auth-declined, privacy policy) and eBay mints an opaque token called a **RuName** ("eBay Redirect URL name"). The `redirect_uri` query parameter in the authorize URL takes the **RuName string**, not a URL.

Documented and repeatedly-confirmed constraints on the Auth Accepted URL:

- **Must support SSL and use the HTTPS protocol.** Plain `http://` is rejected.
- **`localhost` is rejected.** Community threads (including ones with eBay staff participation) report the portal's Save button staying disabled when a localhost address is entered — one thread specifically for `https://localhost:7127/ebay/callback`.
- Because the URL is registered ahead of time and baked into a RuName, **the port is fixed**. An ephemeral port is structurally impossible regardless of the localhost question.

There is **no PKCE support and no device-code flow** on eBay — eBay OAuth for native apps supports only the plain `authorization_code` grant. So there is no standards-blessed escape hatch.

Documented workarounds, in rough order of ugliness:

1. **Manual code paste.** Register eBay's own default redirect page. User authorizes, lands on eBay's page, copies the URL (or just the `?code=` value) and pastes it into the CLI prompt. Zero infrastructure, works everywhere, mildly annoying once every 18 months. **This is the pragmatic default.**
2. **Hosts-file / DNS override.** Map a real-looking hostname to 127.0.0.1, register `https://that-host/callback` as the Auth Accepted URL, run a local HTTPS server with a self-signed cert, and tell the browser to trust it. Works, but requires admin rights to edit `hosts` on Windows and a cert the browser accepts — hostile for a distributed CLI.
3. **`https://localhost:PORT`.** At least one vendor's integration docs (CData) instruct desktop-app users to register `https://localhost:33333`, implying the portal accepts it. This directly contradicts the community reports above. **Unresolved — test it against the live portal before designing around it.** Even if it works, you still need a local TLS cert and a fixed port.
4. **Hosted redirect you control.** Register `https://yourdomain/ebay/callback` on a static host that immediately 302s to `http://127.0.0.1:{fixed-port}/callback` (or renders the code for copy-paste). Clean UX, but requires owning and operating a domain.

### 3.2 Etsy — `http://localhost` works, but the port must be fixed

Better news. **Etsy's own Quickstart tutorial registers and uses `http://localhost:3003/oauth/redirect`** verbatim — so plain-HTTP loopback is supported in practice, notwithstanding some doc prose that reads as HTTPS-only.

But Etsy matches the redirect URI **exactly and case-sensitively** against the URIs pre-registered at `etsy.com/developers/your-apps` — no trailing slashes, no extra query params, no wildcards. So again: **fixed port, not ephemeral.**

Etsy does everything else right for a native CLI:

- **PKCE is mandatory** on every authorization request (S256; verifier 43–128 chars from `[A-Za-z0-9._~-]`)
- Authorize: `GET https://www.etsy.com/oauth/connect`
- Token: `POST https://api.etsy.com/v3/public/oauth/token`
- Access token: **1 hour**; refresh token: **90 days**; `grant_type=refresh_token` preserves original scopes
- Scopes: space-separated (`listings_r listings_w shops_r shops_w transactions_r`)
- **Since 2026-01-18** every request needs `x-api-key: {keystring}:{shared_secret}` — the shared secret is now mandatory. Any code or tutorial predating January 2026 is wrong on this point.

### 3.3 Implementation notes for the loopback server

The pattern itself is trivial with builtins; no framework needed.

- `node:http` `createServer` + `server.listen(PORT, '127.0.0.1')`. **Bind to `127.0.0.1` explicitly**, never `0.0.0.0` — otherwise the callback is reachable from the LAN.
- Ephemeral port via `listen(0)` then `server.address().port` is the textbook approach and is **unusable here** for both providers. Use a fixed port; `get-port@7.2.0` (2026-03-22) is still useful for picking a fallback from a small pre-registered candidate list (register three or four ports with each provider and try them in order).
- `open@11.0.0` (2025-11-15, ESM-only, `>=20`) is the standard cross-platform browser launcher and works on Windows without ceremony. Alternative on Windows only: `cmd /c start ""`.
- Always send an `oauth2 state` nonce and verify it. Etsy's PKCE covers code interception; `state` covers CSRF.
- `req.url` is a path-only string — parse with `new URL(req.url, 'http://127.0.0.1')`.
- Respond with a small self-contained HTML page, `res.end()`, then `server.close()`. Do not leave the listener up.
- Set a timeout (60–120 s) and tear the server down if the user abandons the flow.

---

## 4. Etsy packages

There is **no official Etsy JavaScript/TypeScript SDK**. `github.com/etsy/open-api` (210 stars, 137 open issues, last push 2026-04-29) is a **spec + issue tracker repo only** — it hosts docs, not a client library. Etsy publishes the OpenAPI 3.0.2 spec, and every JS client in the wild is community-generated from it.

The live spec is fetchable and current:
`https://www.etsy.com/openapi/generated/oas/3.0.0.json` — ~900 KB, `openapi: 3.0.2`, `info.version: 3.0.0`. Verified reachable and parseable on 2026-08-10.

### Candidates

| Package | Latest | Published | Repo health | TS | Deps | Weekly DL |
|---|---|---|---|---|---|---|
| **`etsy-ts`** | **7.3.1** | 2026-04-03 | `Granga/etsy-ts`, not archived, push 2026-04-03, 44★, **1 open issue** | native, `dist/index.d.ts` | `axios`, `axios-auth-refresh`, `form-data`, `tslib` | **5,374** |
| `node-etsy-client` | 2.1.4 | 2026-04-15 | `creharmony/node-etsy-client`, push 2026-07-21, 1 open issue | `lib/export.d.ts` (JS + emitted types) | `axios`, `query-string`, `susi-rali`, **`winston`** | 119 |
| `@profplum700/etsy-v3-api-client` | 3.0.0 | 2026-04-01 | `profplum700/etsy-v3-api-client`, push ~2026-04 | native | **effectively zero runtime deps** (only `@eslint/js`, misplaced from devDeps) | 42 |
| `etsy-v3-sdk` (Crazyglue) | — | — | generated from official spec, low activity | generated | — | negligible |

**Assessment:**

- **`etsy-ts` 7.3.1** is the only one with meaningful adoption. It is generated from the official spec, ships full types for every endpoint, and — importantly — was **updated for the 2026-01-18 shared-secret change**: the `Etsy` constructor now requires `sharedSecret` alongside `apiKey`. Downsides: `axios` + `form-data` (an older multipart approach than native `FormData`), ISC license, single-maintainer, four months since last publish.
- **`@profplum700/etsy-v3-api-client` 3.0.0** is architecturally the nicest — modern TS, native fetch, works in browser and Node, **built-in OAuth 2.0 PKCE support**. But 42 weekly downloads and a `package.json` with `@eslint/js` sitting in `dependencies` are both bus-factor-1 warning signs.
- **`node-etsy-client`** pulls in `winston` as a *runtime* dependency, which is unacceptable weight for a CLI. Skip.

**Verdict: pragmatic split.** Use `etsy-ts` for its **types** if convenient, but plan to hand-roll the handful of calls this CLI actually makes against native `fetch`. The reason is that the Etsy surface needed here is tiny and the auth is trivial:

Confirmed directly from the live spec on 2026-08-10:

```
POST   /v3/application/shops/{shop_id}/listings                          createDraftListing
       Content-Type: application/x-www-form-urlencoded   <-- NOT JSON
       required: quantity, title, description, price, who_made, when_made, taxonomy_id
       scope: listings_w

PATCH  /v3/application/shops/{shop_id}/listings/{listing_id}             updateListing
       Content-Type: application/x-www-form-urlencoded   <-- NOT JSON
       fields incl. image_ids, title, description, materials, shipping_profile_id, taxonomy_id
       scope: listings_w

POST   /v3/application/shops/{shop_id}/listings/{listing_id}/images      uploadListingImage
       Content-Type: multipart/form-data
       fields: image, listing_image_id, rank, overwrite, is_watermarked, alt_text
       scope: listings_w

POST   /v3/application/shops/{shop_id}/listings/{listing_id}/files       uploadListingFile
       Content-Type: multipart/form-data
       fields: listing_file_id, file, name, rank
       scope: listings_w                     <-- for the actual STL/3MF digital file

GET    /v3/application/listings/{listing_id}/inventory                   getListingInventory   (listings_r)
PUT    /v3/application/listings/{listing_id}/inventory                   updateListingInventory
       Content-Type: application/json ; required: products               (listings_w)

GET    /v3/application/listings/{listing_id}/images                      getListingImages  (no auth)
GET    /v3/application/openapi-ping                                      ping (no auth — good health check)
```

**Gotcha worth flagging loudly:** `createDraftListing` and `updateListing` are **`application/x-www-form-urlencoded`, not JSON**, while `updateListingInventory` **is** JSON, and the two image/file endpoints are **multipart**. Three different content types across five calls. This mixed encoding is the single most common source of 400s against Etsy v3, and it is exactly the kind of thing a generated client gets right for you — which is the argument for keeping `etsy-ts` in the loop rather than fully hand-rolling.

---

## 5. CLI stack

### 5.1 Argument parsing: `commander` vs `citty` vs `yargs`

| | `commander` | `citty` | `yargs` |
|---|---|---|---|
| Latest | **15.0.0** (2026-05-29) | **0.2.2** (2026-04-01) | **18.1.0** (2026-07-26) |
| Weekly DL | **~477M** | ~28M | ~244M |
| Repo | tj/commander.js | unjs/citty — 1,297★, push 2026-08-06, **62 open issues** | yargs/yargs |
| Types | bundled `typings/index.d.ts` | native TS, `dist/index.d.mts` | **no `types` field** — needs `@types/yargs` |
| Module | **ESM-only** | ESM | dual |
| Engines | `>=22.12.0` | unspecified | `^20.19 \|\| ^22.12 \|\| >=23` |

- **`commander@15`** — the boring, correct answer. Enormous install base, stable API, now ESM-only with a Node 22.12 floor. Types are bundled and adequate (not as sharp as citty's inference, but they don't lie to you). Subcommand + option parsing is exactly the shape this CLI needs.
- **`citty@0.2.2`** — genuinely nicer TypeScript ergonomics (args are inferred from the definition object, so `ctx.args.foo` is typed without manual generics) and lazy subcommand loading for fast startup. But it is **still 0.x after years**, has 62 open issues, and its API can move under you. Fine for a personal tool, a liability for something meant to last.
- **`yargs@18`** — powerful, but no bundled types (a separate `@types/yargs` that drifts), heavier, and the fluent builder API ages worse in TS than either alternative.

**Recommendation: `commander@15`.** Pick `citty` only if the DX of inferred arg types matters more than API stability, and accept the 0.x risk consciously.

### 5.2 Zod

**`zod@4.4.3`**, published **2026-05-04**. Zod 4 is **stable and the default `latest` tag** — the v3 line is legacy. Requires **TypeScript ≥5.5** and `"strict": true` in tsconfig.

Package layout to know: `zod` (full), `zod/mini` (tree-shakeable, much smaller bundle, functional API), `zod/v4` and `zod/v3` subpaths for staged migration, and `zod/v4/core` for library authors. For a CLI, bundle size is irrelevant — **use the full `zod`**.

Uses here: validating parsed config/env, validating the shape of API responses at the boundary, and generating help/prompt schemas. No competitive reason to reach for `valibot`/`arktype` in a CLI where bundle size doesn't matter.

### 5.3 SQLite: `node:sqlite` vs `better-sqlite3`

| | `node:sqlite` (built-in) | `better-sqlite3` |
|---|---|---|
| Version | ships with Node 22.5+ | **13.0.3** (2026-08-05) |
| Stability | **1.2 — Release Candidate** | mature, ~9.7M weekly DL |
| Flag needed | **No** (unflagged since v22.13 / v23.4) | n/a |
| Install | **zero** — no native build, no prebuild download | native addon; prebuilds usually available, otherwise needs a toolchain |
| Engines | Node 22/24/25/26 | `>=22` |
| Types | in `@types/node` | **no bundled types** — needs `@types/better-sqlite3` |

`node:sqlite` feature coverage as of Node 26 is now broad: `DatabaseSync` with `prepare()`/`get()`/`all()`/`run()`/`iterate()`, transactions (`isTransaction`, manual BEGIN/COMMIT via `exec()`), WAL via PRAGMA, `sqlite.backup()` (async, with progress), `loadExtension()`, custom scalar (`function()`) and aggregate/window (`aggregate()`) functions, sessions/changesets, `serialize()`/`deserialize()` (v26.1+), authorizer hooks (v24.10+), and a template-literal tag store with SQL-injection protection. Everything except `backup()` is synchronous — same execution model as `better-sqlite3`.

**Recommendation: `node:sqlite`.** For a Windows-targeted CLI, eliminating a native addon from the dependency tree is worth a great deal — `better-sqlite3` is a recurring source of `node-gyp`/MSVC/Python install failures on Windows machines that lack Build Tools, and of ABI breakage on every Node major. The only real costs are (a) stability index 1.2 means the API can still change across Node majors, and (b) no bundled `better-sqlite3`-style helpers like `db.transaction(fn)`, so you write your own BEGIN/COMMIT wrapper.

**Keep `better-sqlite3@13.0.3` as the documented fallback** if you hit a `node:sqlite` gap or need to support Node 22.x at an older feature level. The APIs are close enough that a thin internal adapter makes the swap cheap.

Query builders, if wanted: `kysely@0.29.5` (2026-08-10, typed, no codegen required, dialect-pluggable) or `drizzle-orm@0.45.2` (2026-03-27). For a CLI with a handful of tables, raw prepared statements are probably enough.

---

## 6. Secret storage on Windows

### `keytar` is DEAD — do not use

| | |
|---|---|
| Latest | **7.9.0, published 2022-02-17** — four and a half years old |
| Repo | `atom/node-keytar` — **ARCHIVED**, last push 2022-12-12, **77 open issues**, read-only |
| npm deprecation flag | not set (misleading — the package is *not* marked deprecated on npm, but the project is dead) |
| Weekly DL | ~2.9M (pure legacy inertia) |

It was archived along with the rest of the Atom org. It is a C++ node-gyp addon with no prebuilds for modern Node ABIs, requires `libsecret` on Linux, and will not build against Node 24. Microsoft's own teams migrated off it — see the tracking issues on `Azure/azure-sdk-for-js#29288` and `AzureAD/microsoft-authentication-library-for-js#7170`, both explicitly "replace keytar with `@napi-rs/keyring`".

### `@napi-rs/keyring` — RECOMMENDED

| | |
|---|---|
| Latest | **1.3.0**, published **2026-04-30** |
| Repo | `Brooooooklyn/keyring-node` — not archived, last push **2026-08-10** (today), 91★, 6 open issues |
| Weekly DL | ~2.8M — has essentially caught up with keytar |
| Dependents | 414+ packages |
| Install | **Rust/NAPI prebuilt binaries via optionalDependencies** — no compiler needed |
| Types | bundled `index.d.ts` |
| Engines | `>= 10` |

Prebuilt platform packages include **`@napi-rs/keyring-win32-x64-msvc`** and **`@napi-rs/keyring-win32-arm64-msvc`** (plus darwin arm64/x64 and linux gnu/musl arm64/x64). On Windows it binds the **Windows Credential Manager** natively, with a PowerShell-based fallback path. It is a **drop-in, 100%-compatible keytar alternative** (`setPassword`/`getPassword`/`deletePassword` on an `Entry`), wraps the Rust `keyring-rs` crate, and drops the `libsecret` requirement on Linux. The maintainer received a Microsoft OSS fund grant.

Also seen: `cross-keychain@1.1.0` (2025-10-07) — but it depends on `@inquirer/prompts` and `meow` at *runtime*, which is wrong for a library. Skip.

### Versus a plain file with restricted permissions

A `0600`-style file is the common fallback, but **Windows has no `chmod`** — `fs.chmod` is largely a no-op there, and getting real protection means ACL manipulation via `icacls`, which is fiddly and easy to get wrong. Two better fallbacks on Windows:

1. **DPAPI** (`CryptProtectData`) — encrypts at rest, scoped to the current Windows user, no key management. Reachable from Node via a small native module or by shelling out to PowerShell's `ConvertTo-SecureString`/`Protect-CmsMessage`. This is what a "restricted file" *should* mean on Windows.
2. **Encrypted file with a key derived from a passphrase** — `node:crypto` `scrypt` + `aes-256-gcm`. Portable, no native deps, but prompts the user for a passphrase.

**Recommendation: `@napi-rs/keyring` as primary, with an `aes-256-gcm` encrypted file under `env-paths@4.0.0`'s config dir as the fallback** for headless/CI/WSL environments where no credential store is reachable. A plain unencrypted file should not be an option for OAuth refresh tokens that live 18 months (eBay) — those are long-lived bearer credentials to a live selling account.

`conf@15.1.0` (2026-02-04) is a reasonable choice for **non-secret** config persistence (it handles the platform config-dir resolution and atomic writes for you). It has an `encryptionKey` option, but that is obfuscation, not security — the key ships in your binary. Don't use it for tokens.

---

## 7. Images and multipart upload

### 7.1 `sharp` for resize / convert — RECOMMENDED, no real competition

| | |
|---|---|
| Latest | **0.35.3**, published **2026-07-01** |
| Weekly DL | ~83.8M |
| Engines | `>=20.9.0` |
| Types | bundled `dist/index.d.mts` |

**Windows install is clean.** Prebuilt binaries ship as optionalDependencies for **`@img/sharp-win32-x64`, `@img/sharp-win32-arm64`, and `@img/sharp-win32-ia32`** (plus darwin arm64/x64, linux x64/arm64/arm/ppc64/riscv64/s390x, musl variants, freebsd-wasm32, and webcontainers-wasm32). libvips is bundled via the `@img/sharp-libvips-*` packages at 1.3.2. **No node-gyp, no build toolchain required** on any mainstream platform.

Relevant capabilities: `resize()` with `fit`/`withoutEnlargement`, `rotate()` (honors EXIF orientation — important, phone photos of prints are routinely sideways), `jpeg({ quality, mozjpeg })` / `webp()` / `avif()` / `png()`, `metadata()` for dimensions before deciding, `withMetadata()` to strip or preserve EXIF (**strip it — EXIF on hobbyist photos frequently carries GPS coordinates of the user's home**), and `toBuffer()` which feeds straight into an upload.

Marketplace constraints to size against: eBay EPS images and Etsy listing images both want large, square-ish, high-quality JPEGs; both platforms re-encode server-side, so upload quality ≈85–90 JPEG rather than lossless PNG.

### 7.2 Multipart upload from Node

**Use the built-in `fetch` + `FormData` + `Blob`.** Node has shipped a WHATWG-spec `FormData`, `Blob`, and `File` in the global scope since v18 (implementation is undici, vendored into core). On Node 24 this is stable and correct:

```js
import { readFile } from 'node:fs/promises';

const bytes = await sharp(input).resize(1600, 1600, { fit: 'inside' })
  .jpeg({ quality: 88, mozjpeg: true }).toBuffer();

const fd = new FormData();
fd.append('image', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
fd.append('rank', '1');

await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'x-api-key': key }, body: fd });
```

**Critical rule: never set `Content-Type` yourself when the body is a `FormData`.** `fetch` computes `multipart/form-data; boundary=...` from the FormData instance. Setting it manually strips the boundary and the server returns a parse error. (This is exactly the pattern that makes `ebay-api`'s `multipartHeader` suspicious — see §2.1.)

**Do you need `undici` as an explicit dependency?** `undici@8.10.0` (2026-08-03, engines `>=22.19.0`) is the same implementation that backs core `fetch`. Add it explicitly only if you need something core doesn't expose: connection pooling/`Agent` tuning, `ProxyAgent` for corporate proxies, retry interceptors, or `request()`'s streaming body. For plain uploads, **the global `fetch` is sufficient and one less dependency**.

Known limitation either way: `FormData.append` accepts `string`, `Buffer`, or a real `Blob`/`File` — **not a Node readable stream**. So a large file is fully buffered in memory. For product photos (a few MB) this is fine. If you ever need true streaming multipart, `formdata-node` (with `fileFromPath`) is the escape hatch. Note also that undici 7.1.0 fixed a trailing-CRLF bug in multipart encoding that broke some strict server parsers — another reason to stay on a current Node.

### 7.3 Where the images actually go — TIME-SENSITIVE

**eBay:**

- The Sell Inventory API does **not** accept image bytes. `Product.imageUrls` is an array of links, and **URLs must use HTTPS**. So images must be hosted somewhere eBay can fetch them.
- The way to get an eBay-hosted URL is **eBay Picture Services (EPS)**.
- **The legacy route, Trading API `UploadSiteHostedPictures`, is deprecated and is being DECOMMISSIONED on 2026-09-30.** That is roughly seven weeks from this research date. Do not build on it.
- **The replacement is the Media API:** `POST /commerce/media/v1_beta/image/create_image_from_file` (multipart/form-data, one image per call) returning an EPS image URL, and `POST .../image/create_image_from_url` for images you already host. `ebay-api@10` exposes both (see §2.1).
- EPS pictures not attached to an active listing are **auto-deleted after 30 days**.

**Etsy:**

- `POST /v3/application/shops/{shop_id}/listings/{listing_id}/images` — `multipart/form-data`, field name `image`, plus optional `rank`, `overwrite`, `is_watermarked`, `alt_text`. The listing must exist first (create the draft, then attach images), and the returned `listing_image_id` values can be reordered later via `updateListing`'s `image_ids`.
- Digital-goods files (the STL/3MF) go to a separate endpoint: `POST .../listings/{listing_id}/files`, field name `file`.

---

## 8. Everything else, briefly

| Need | Package | Latest | Notes |
|---|---|---|---|
| Interactive prompts | `@clack/prompts` | 1.7.0 (2026-07-03) | ~17.7M/wk. Now 1.x — stable. Best-looking, smallest API. |
| Interactive prompts (alt) | `@inquirer/prompts` | 8.5.2 (2026-05-31) | ~35M/wk. More prompt types, larger surface. |
| Spinners | `ora` | 9.4.1 (2026-06-22) | or use clack's built-in spinner and skip this |
| Terminal color | `picocolors` | 1.1.1 (2024-10-16) | stale-looking but genuinely finished; tiny, zero-dep |
| Config dirs | `env-paths` | 4.0.0 (2026-01-24) | correct `%APPDATA%` handling on Windows |
| Config persistence | `conf` | 15.1.0 (2026-02-04) | non-secret config only |
| Port selection | `get-port` | 7.2.0 (2026-03-22) | for fallback among pre-registered ports |
| Browser launch | `open` | 11.0.0 (2025-11-15) | ESM-only, `>=20` |
| Concurrency limit | `p-limit` | 7.3.1 (2026-07-20) | throttle parallel image uploads |
| Dev runner | `tsx` | 4.23.12 (2026-08-10) | run TS directly in dev |
| Build/bundle | `tsdown` | 0.22.14 (2026-07-23) | rolldown-based; `tsc` alone is also fine for a CLI |
| `.env` loading | `dotenv` | 17.4.2 (2026-04-12) | or Node's built-in `--env-file` and skip the dep |

Note that Node 24 has a built-in `--env-file` flag and a built-in test runner (`node:test`), so `dotenv` and a test framework are both optional.

---

## 9. Open questions to resolve before writing code

1. **Does the eBay developer portal accept `https://localhost:PORT` as an Auth Accepted URL today?** Sources conflict (§3.1). Testing this against the live portal takes ten minutes and determines whether the eBay auth flow is "loopback with a local cert" or "paste the code". **Test this first.**
2. **Does `ebay-api`'s `createImageFromFile` actually produce a valid multipart boundary?** The hardcoded boundary-less `Content-Type` header (§2.1) suggests it may not. Test with one real image against sandbox.
3. **Does `etsy-ts@7.3.1` handle the three different content types correctly** across `createDraftListing` (urlencoded), `updateListingInventory` (JSON), and `uploadListingImage` (multipart)? It depends on the older `form-data` package, which is a different code path from native `FormData`.
4. **Is `ebay-api@10.0.0` stable enough?** Five weeks old, breaking release. Check the issue tracker for regressions before pinning; 9.6.0 is a fallback.
5. **eBay sandbox vs production for Inventory + Media.** eBay's sandbox has historically had gaps in Inventory API and EPS behaviour. Confirm the sandbox actually supports `create_image_from_file` before relying on it for development.
