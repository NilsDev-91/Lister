# Etsy Open API v3 — Authentication Research

**Researched:** 2026-08-10
**Target:** Node 18+ / TypeScript CLI that creates Etsy listings with images
**Primary sources:** developers.etsy.com/documentation (Essentials → Authentication, Request Standards; Tutorials → Quick Start, Listings, Shop Management), etsy/open-api GitHub, spec-generated client libraries

> **Bottom line for a CLI:** OAuth 2.0 Authorization Code + **PKCE is mandatory** — there is no client secret in the token exchange. But the **shared secret is still required**, in the `x-api-key` header, colon-joined to the keystring. Those are two different credentials used in two different places, and that is the single biggest source of confusion in this API.

---

## 1. The `x-api-key` header — conflict RESOLVED

**Answer: `x-api-key` must be `<keystring>:<shared_secret>` (colon-joined). Keystring alone is not sufficient.**

This is stated consistently across **four separate official Etsy doc pages**:

| Source | Text |
|---|---|
| Essentials → Request Standards | "Your Etsy App API Key *keystring* and *shared secret*, separated by a colon (`:`)" — example `exJeyZtXODeekHfX8VRgMQ:a1b2c3d4e5` |
| Essentials → Authentication | `x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5` |
| Tutorials → Quick Start | `'x-api-key': '1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5'` |
| Tutorials → Listings | `x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5` alongside `Authorization: Bearer` |

Independent production codebases confirm it empirically, including the exact server rejection string:

- `anano303/soul-art` (`server/src/etsy/etsy.service.ts`): *"Etsy requires `keystring:shared_secret` in the x-api-key header (returns 403 'Shared secret is required in x-api-key header' otherwise). OAuth token requests still use the bare keystring as client_id."*
- `ItMoney22/imagine-this-printed` (`backend/services/etsy.ts`): *"Keystring-alone now returns 403 'Shared secret is required in x-api-key header' (Etsy v3 change, verified live 2026-07-25). The OAuth client_id stays the bare keystring."*
- `dobutsustationery/admin`: *"Etsy v3 'confidential' apps require the keystring concatenated with the app's shared secret (separated by a colon) as the x-api-key value."*
- `Jaal-Yantra-Textiles/v2`: *"Every request sends `x-api-key: <keystring>:<shared_secret>`. Scoped requests also send `Authorization: Bearer <userId>.<token>`."*

Note the corroborating detail in `imagine-this-printed`: their own research doc dated 2026-07-24 wrote `x-api-key: <keystring>`, and the code comment dated 2026-07-25 corrects it to the colon form after live testing. Stale blog posts and older client libraries that say "keystring only" are the source of the conflict.

### Where each credential goes

| Place | Value | Notes |
|---|---|---|
| `x-api-key` header — **every** API call under `/v3/application/...` | `keystring:shared_secret` | Both app-key-only and OAuth endpoints |
| `client_id` param — authorize URL and token endpoint | **bare keystring** (no colon, no secret) | PKCE replaces the client secret here |
| `Authorization` header — OAuth-scoped endpoints only | `Bearer <user_id>.<token>` | Etsy's access token literally embeds the user id |

**Do not** send the colon form as `client_id`, and **do not** send the bare keystring as `x-api-key`.

```ts
// src/etsy/credentials.ts
const KEYSTRING = process.env.ETSY_KEYSTRING!;      // e.g. "1aa2bb33c44d55eeeeee6fff"
const SHARED_SECRET = process.env.ETSY_SHARED_SECRET!;

export const X_API_KEY = `${KEYSTRING}:${SHARED_SECRET}`; // header value
export const CLIENT_ID = KEYSTRING;                        // OAuth client_id
```

### Which endpoints need what

| Endpoint class | `x-api-key` | `Authorization: Bearer` |
|---|---|---|
| `GET /v3/application/openapi-ping` | required | no |
| Public reads (`getListing`, public shop/taxonomy lookups) | required | no |
| Anything with an OAuth scope (`listings_w`, `shops_r`, …) | required | **required** |
| `POST /v3/public/oauth/token` | **not sent** | no (uses `client_id` + `code_verifier` in the body) |

The token endpoint lives under `/v3/public/` and takes no `x-api-key`. Everything else is `/v3/application/`.

---

## 2. OAuth 2.0 Authorization Code + PKCE

### URLs

| Purpose | URL |
|---|---|
| Authorize (browser redirect) | `https://www.etsy.com/oauth/connect` |
| Token exchange + refresh | `https://api.etsy.com/v3/public/oauth/token` |
| API base | `https://api.etsy.com/v3/application` (alias: `https://openapi.etsy.com/v3/application`) |

### Step 1 — authorize request (GET, browser)

| Param | Required | Value |
|---|---|---|
| `response_type` | yes | `code` |
| `client_id` | yes | bare keystring |
| `redirect_uri` | yes | must **exactly** match a URI registered on the app |
| `scope` | yes | space-separated, URL-encoded (`%20`) |
| `state` | yes in practice (docs say "recommended") | single-use, unguessable CSRF token |
| `code_challenge` | yes | `BASE64URL(SHA256(code_verifier))`, no padding |
| `code_challenge_method` | yes | `S256` (only supported method) |

```
https://www.etsy.com/oauth/connect?response_type=code&client_id=1aa2bb33c44d55eeeeee6fff&redirect_uri=http://localhost:3003/callback&scope=listings_r%20listings_w%20shops_r&state=superstate&code_challenge=DSWlW2Abh-cf8CeLL8-g3hQ2WQyYdKyiu83u_s7nRhI&code_challenge_method=S256
```

**CLI note on `redirect_uri`:** the Authentication page says the redirect URI "must be https://". In practice `http://localhost:<port>/callback` is accepted and is the standard pattern for CLI/loopback flows — several of the reviewed production repos register exactly that (e.g. `http://localhost:3939/callback`). It must be registered on the app first. *Treat plain-`http` localhost as very likely but verify against your own app registration.*

### PKCE generation rules

- **`code_verifier`:** high-entropy random string, **43–128 characters**, from the character set `[A-Za-z0-9._~-]` (RFC 7636 unreserved set).
- **`code_challenge`:** `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))`, **URL-safe alphabet, no `=` padding**.
- **`code_challenge_method`:** `S256`. Plain is not supported.
- The verifier must be persisted alongside the `state` value until the callback returns.

```ts
// src/etsy/pkce.ts
import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes -> 43 base64url chars, the minimum legal verifier length. */
export function createVerifier(): string {
  return randomBytes(32).toString("base64url"); // base64url is unpadded in Node 16+
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createState(): string {
  return randomBytes(16).toString("base64url");
}
```

`base64url` in Node produces only `[A-Za-z0-9_-]` and strips padding, so it satisfies both the verifier charset and the challenge encoding. Do **not** use `toString("base64")` — `+`, `/`, and `=` will break the exchange.

### Step 2 — token exchange (POST)

`Content-Type: application/x-www-form-urlencoded`. No `x-api-key`, no client secret, no `Authorization`.

| Param | Required | Value |
|---|---|---|
| `grant_type` | yes | `authorization_code` |
| `client_id` | yes | bare keystring |
| `redirect_uri` | yes (must match step 1) | same URI |
| `code` | yes | code from the callback query string |
| `code_verifier` | yes | the original 43–128 char verifier |

```bash
curl -X POST https://api.etsy.com/v3/public/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code \
  -d client_id=1aa2bb33c44d55eeeeee6fff \
  -d redirect_uri=http://localhost:3003/callback \
  -d code=bftcubu-wownsvftz5kowdmxnqtsuoikwqkha7_4na3igu1uy \
  -d code_verifier=vvkdljkejllufrvbhgeiegrnvufrhvrffnkvcknjvfid
```

Response:

```json
{
  "access_token": "12345678.O1zLuwveeKjpIqCQFfmR-PaMMpBmagH6DljRAkK9qt05OtRKiANJOyZlMx3WQ_o2FdComQGuoiAWy3dxyGI4Ke_76PR",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "12345678.JNGIJtvLmwfDMhlYoOJl8aLR1BWottyHC6yhNcET-eC7RogSR5e1GTIXGrgrelWZalvh3YvvyLfKYYqvymd-u37Sjtx",
  "scope": "listings_r listings_w shops_r"
}
```

The numeric prefix before the `.` in both tokens is the Etsy **`user_id`** — you can parse it without an API call:

```ts
const userId = Number(accessToken.split(".")[0]);
```

`scope` in the response may be a **subset** of what you requested. Validate it rather than assuming.

### Step 3 — refresh

```bash
curl -X POST https://api.etsy.com/v3/public/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=refresh_token \
  -d client_id=1aa2bb33c44d55eeeeee6fff \
  -d refresh_token=12345678.JNGIJtvLmwfDMhlYoOJl8aLR1BWottyHC6yhNcET
```

Same response shape. No `code_verifier`, no `redirect_uri`, no secret.

### Lifetimes

| Token | Lifetime | Notes |
|---|---|---|
| `access_token` | **3600 s (1 hour)** — `expires_in` | Refresh when < 60 s remain |
| `refresh_token` | **90 days** | Rotates: each refresh returns a *new* refresh token |

**Refresh token rotation is the #1 way to brick a CLI integration.** Every refresh response contains a new `refresh_token`; persist the new pair atomically. If the process crashes between "used the old token" and "saved the new one", the connection is dead and the user must re-consent. Etsy's docs describe the 90-day validity but do not state rotation explicitly — rotation is confirmed by multiple production integrations (`imagine-this-printed`, `jewellery-catalogue`, `Jaal-Yantra-Textiles/v2`). *Treat as high-confidence but design defensively either way: write-new-then-mark-old-consumed.*

Going 90 days without refreshing requires a full re-authorization through the consent screen. A CLI should surface that as a "reconnect" state, not a silent failure.

---

## 3. Scopes

Full scope list relevant to listing creation:

| Scope | Etsy's description |
|---|---|
| `listings_r` | "Read a member's inactive and expired (i.e., non-public) listings." |
| `listings_w` | "Create and edit a member's listings." |
| `listings_d` | "Delete a member's listings." |
| `shops_r` | "See a member's shop description, messages and sections, even if not (yet) public." |
| `shops_w` | "Update a member's shop description, messages and sections." |

Other scopes exist (`transactions_r/w`, `profile_r/w`, `address_r/w`, `billing_r`, `cart_r/w`, `email_r`, `favorites_r/w`, `feedback_r`, `recommend_r/w`) but none are needed for listing creation.

### Scope → endpoint mapping

| Operation | Method + path | Scope |
|---|---|---|
| getMe | `GET /v3/application/users/me` | `shops_r` |
| getShopByOwnerUserId | `GET /v3/application/users/{user_id}/shops` | `shops_r` |
| getShop | `GET /v3/application/shops/{shop_id}` | `shops_r` |
| getShopShippingProfiles | `GET /v3/application/shops/{shop_id}/shipping-profiles` | `shops_r` |
| getSellerTaxonomyNodes | `GET /v3/application/seller-taxonomy/nodes` | *none* (api key only) |
| createDraftListing | `POST /v3/application/shops/{shop_id}/listings` | `listings_w` |
| uploadListingImage | `POST /v3/application/shops/{shop_id}/listings/{listing_id}/images` | `listings_w` |
| updateListing (activate) | `PATCH /v3/application/shops/{shop_id}/listings/{listing_id}` | `listings_w` |
| updateListingInventory | `PUT /v3/application/listings/{listing_id}/inventory` | `listings_w` |
| getListingsByShop (incl. drafts) | `GET /v3/application/shops/{shop_id}/listings` | `listings_r` |
| deleteListing | `DELETE /v3/application/listings/{listing_id}` | `listings_d` |
| updateShop | `PATCH /v3/application/shops/{shop_id}` | `shops_w` |

**Minimum scope set to create listings with images:**

```
listings_w shops_r
```

Add `listings_r` if the CLI reads back its own drafts (it almost certainly should, to be idempotent). Add `listings_d` only for a delete/cleanup command. **`shops_w` is not needed** — it only covers editing shop descriptions/sections, not creating listings. Request the narrowest set; over-requesting makes the consent screen scarier and buys nothing.

Recommended for this CLI: `listings_r listings_w shops_r`

---

## 4. Getting `user_id` and `shop_id` after auth

`getMe` returns both in one call. The spec's `Self` model has exactly two fields:

| Field | Type | Description (from spec) |
|---|---|---|
| `user_id` | Long | "The numeric ID of a user. This number is also a valid shop ID for the user's shop." |
| `shop_id` | Long | "The unique positive non-zero numeric ID for an Etsy Shop." |

```bash
curl -s https://api.etsy.com/v3/application/users/me \
  -H 'x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5' \
  -H 'Authorization: Bearer 12345678.O1zLuwveeKjpIqCQFfmR-PaMMpBmagH6DljRAkK9qt05'
```

```json
{ "user_id": 12345678, "shop_id": 87654321 }
```

So: **one call, both ids.** `GET /v3/application/users/{user_id}/shops` (`getShopByOwnerUserId`) is the fallback if `shop_id` comes back null — which happens when the authorizing account has no shop yet. Note there is **no** `/users/me/shops` path in the spec despite some client-library JSDoc claiming otherwise; use the explicit `{user_id}`.

You can also skip `getMe` entirely for `user_id` by splitting the access token on `.`. You still need `getMe` (or `getShopByOwnerUserId`) for `shop_id`.

---

## 5. App registration and approval

Register at `https://www.etsy.com/developers/register`; manage at `https://www.etsy.com/developers/your-apps`. Registration produces an **Etsy App API keystring** and a **shared secret**, both visible in "Your Apps".

### Access tiers

| Tier | What it grants | Review |
|---|---|---|
| **Seller App** | Read/write against **your own registered shop** only | Automated — "eligible sellers receive approval within minutes, with no manual review queue" |
| **Personal App** | Beyond your own shop, at limited scale | "a deeper review process than Seller Apps" — manual, variable timeline |
| **Commercial Access** | OAuth against *any* consenting seller | Start from an approved Personal App, then request upgrade. "Commercial Access requests are reviewed manually. Review time may vary depending on your proposed use case." |

**For a CLI that lists your own 3D prints to your own shop: Seller App is sufficient, and there is effectively no review gate** — approval is near-instant. You only hit manual review if you distribute the CLI for other sellers to use against their own shops (Commercial Access).

Important: the Quick Start warns "Your API key is not active until it has been approved." Even in the fast path, the key does not work the instant you submit the form — check "Manage Your Apps" for status before debugging 401s.

### Setup checklist

1. Etsy account owns an actual **shop** (one-time shop setup fee; $0.20 per *published* listing — drafts are free).
2. Create app → get keystring + shared secret.
3. Register **exact-match** redirect URIs (e.g. `http://localhost:3003/callback` for local CLI, plus any prod URI). Exact match, including port and trailing path.
4. Wait for the key to show approved.
5. Verify with the ping endpoint before writing any OAuth code.

```bash
curl -s https://api.etsy.com/v3/application/openapi-ping \
  -H 'x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5'
# -> {"application_id": 1234}
```

This validates the keystring **and** the shared secret with zero OAuth involvement. If this 403s with "Shared secret is required in x-api-key header", your header format is wrong. Make it the first thing the CLI's `doctor` command runs.

---

## 6. Listing creation flow (for context)

```
getMe                       -> user_id, shop_id
getSellerTaxonomyNodes      -> taxonomy_id  (required; Etsy-specific, map once)
getShopShippingProfiles     -> shipping_profile_id  (required to activate physical listings)
POST .../shops/{shop_id}/listings                        -> listing_id (state=draft)
POST .../shops/{shop_id}/listings/{listing_id}/images    -> repeat per image (multipart)
PATCH .../shops/{shop_id}/listings/{listing_id}          -> state=active   (incurs $0.20 fee)
```

`createDraftListing` required fields: `quantity`, `title` (≤140 chars), `description`, `price` (decimal in shop currency — **dollars, not cents**, on create; the inventory endpoint uses `{amount, divisor}` money objects instead), `who_made` (`i_did` | `someone_else` | `collective`), `when_made` (`made_to_order` for print-on-demand), `taxonomy_id`. Physical listings also need `shipping_profile_id` and `type=physical`.

`uploadListingImage` is `multipart/form-data` with field `image` = binary (JPG/PNG/GIF), max 10 MB, up to 10 images + 1 video per listing. Upload order sets display order; `rank=1` is the hero image.

**3D-print specific gotcha:** transparent PNG areas render **black** on Etsy. Flatten renders onto a solid background before upload.

### Full authenticated request example

```bash
curl -X POST "https://api.etsy.com/v3/application/shops/87654321/listings" \
  -H 'x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5' \
  -H 'Authorization: Bearer 12345678.O1zLuwveeKjpIqCQFfmR-PaMMpBmagH6DljRAkK9qt05' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'quantity=10' \
  --data-urlencode 'title=Articulated Dragon 3D Printed Fidget Toy' \
  --data-urlencode 'description=Printed in PLA on a Bambu Lab P1S.' \
  --data-urlencode 'price=24.99' \
  --data-urlencode 'who_made=i_did' \
  --data-urlencode 'when_made=made_to_order' \
  --data-urlencode 'taxonomy_id=1633' \
  --data-urlencode 'shipping_profile_id=123456789' \
  --data-urlencode 'type=physical'
```

```bash
curl -X POST "https://api.etsy.com/v3/application/shops/87654321/listings/1234567890/images" \
  -H 'x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5' \
  -H 'Authorization: Bearer 12345678.O1zLuwveeKjpIqCQFfmR-PaMMpBmagH6DljRAkK9qt05' \
  -F 'image=@./renders/dragon-hero.jpg' \
  -F 'rank=1'
```

---

## 7. Gotchas

1. **`x-api-key` is `keystring:shared_secret`; `client_id` is the bare keystring.** Mixing these up is the most common cause of 403s and "invalid client" errors.
2. **Keystring alone now 403s** with "Shared secret is required in x-api-key header". Older tutorials and some client libraries are stale on this.
3. **Refresh tokens rotate.** Persist the new one on every refresh, atomically, or the integration bricks.
4. **90 days of inactivity** kills the refresh token — full re-consent required.
5. **No sandbox environment.** Every listing is real. Default to `state=draft`; drafts are free and invisible to buyers. Publishing costs $0.20/listing.
6. **`redirect_uri` must match exactly**, including port and path, and must be pre-registered.
7. **`taxonomy_id` is required** and Etsy-specific — fetch `seller-taxonomy/nodes` and build a mapping once; do not hardcode blind.
8. **A shipping profile must already exist** in the shop before a physical listing can be activated.
9. **API key isn't active until approved**, even on the fast Seller App path.
10. **Granted scope may be narrower than requested** — check the `scope` field in the token response.
11. **Rate limits** arrive as response headers: `x-limit-per-second`, `x-remaining-this-second`, `x-limit-per-day`, `x-remaining-today`. Default is roughly 10,000 requests/rolling-24h at ~10 QPS; the daily window slides rather than resetting at midnight. 429s carry `retry-after`. Budget ~13 calls per product (create + ≤10 images + activate). Throttle to 2–3 QPS.
12. **Transparent PNGs render black.** Flatten first.
13. The official Node SDK is unmaintained — build a thin client on Node 18+ `fetch`/`FormData`.

---

## 8. Unconfirmed / verify yourself

- **`http://localhost` redirect URIs.** Etsy's Authentication page says the redirect URI "must be https://", yet multiple production repos register plain-http localhost callbacks and report them working. Register one and test before building the CLI's loopback server around it.
- **Token endpoint accepting JSON.** Etsy's official examples are `application/x-www-form-urlencoded`. Several community integrations post a JSON body and report success. Use form-encoding — it's the documented path.
- **`getMe` requiring `shops_r` specifically.** This comes from a spec-derived endpoint table, not Etsy prose. It definitely requires *some* OAuth token; `shops_r` is in our recommended set regardless, so this is low-risk.
- **Refresh token rotation** is not stated explicitly in Etsy's docs — it's inferred from the response shape ("new access + refresh tokens") and confirmed by multiple production integrations.
- **Exact rate-limit numbers.** Etsy stopped publishing these and directs developers to per-app values in the Developer Portal. Read the response headers at runtime rather than hardcoding.
- **Whether `state` is strictly enforced.** The Authentication page's parameter table marks it "Recommended" while the prose treats it as essential. Always send it.

---

## Sources

- https://developers.etsy.com/documentation/essentials/authentication
- https://developers.etsy.com/documentation/essentials/requests/
- https://developers.etsy.com/documentation/tutorials/quickstart/
- https://developers.etsy.com/documentation/tutorials/listings/
- https://developers.etsy.com/documentation/tutorials/shopmanagement/
- https://developers.etsy.com/documentation/ (app tiers / approval)
- https://github.com/etsy/open-api (+ discussions)
- Spec-generated clients: `gordonturner/etsy-open-api-client` (`docs/UserApi.md`, `docs/Self.md`), `Crazyglue/etsy-v3-sdk`, `profplum700/etsy-v3-api-client`
- Live-verified community integrations: `ItMoney22/imagine-this-printed`, `anano303/soul-art`, `dobutsustationery/admin`, `Jaal-Yantra-Textiles/v2`, `igor-siergiej/jewellery-catalogue`
- RFC 7636 (PKCE), Appendix B
