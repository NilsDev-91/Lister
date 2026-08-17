# eBay OAuth for the Sell APIs (Node/TypeScript CLI, ebay.de / EBAY_DE)

Research date: 2026-08-11
Primary source: `developer.ebay.com` — the consolidated **guides-v2 "Authorization"** page and per-method
API reference pages (footer reads "Copyright 1999—2026 eBay Inc.", so this is current).

> **Fetch note:** `WebFetch` against `developer.ebay.com` timed out on every attempt (60s), repeatedly.
> All eBay-doc facts below were read through a real browser session against `developer.ebay.com`.
> Anything that could *not* be confirmed from eBay's own docs is explicitly marked
> **[UNCONFIRMED]** or **[COMMUNITY]**.

---

## 1. TL;DR for the CLI

| Decision | Answer |
| --- | --- |
| Grant flow for listing creation | **Authorization Code Grant** (User access token). Not client credentials. |
| Can we run a `http://localhost` loopback callback? | **No.** eBay's RuName accept-URL must be **HTTPS** and the portal rejects `localhost`. |
| Recommended CLI approach | HTTPS accept-URL on a **hosts-file hostname mapped to 127.0.0.1**, with **manual paste of the redirect URL** as the guaranteed fallback. |
| Scopes to request | `sell.inventory` + `sell.account` (add `sell.marketing` only if you do Promoted Listings). |
| Access token life | **7200 s (2 h)** |
| Refresh token life | **47 304 000 s (~18 months)** |
| Blocker before first production call | **Marketplace account deletion** subscription **or** opt-out. Still mandatory in 2026. |

---

## 2. Endpoints (verbatim from eBay docs)

### 2.1 Consent / authorize endpoint

| Environment | Endpoint |
| --- | --- |
| Sandbox | `GET https://auth.sandbox.ebay.com/oauth2/authorize` |
| Production | `GET https://auth.ebay.com/oauth2/authorize` |

### 2.2 Token endpoint (all three grant types use the same URL)

| Environment | Endpoint |
| --- | --- |
| Sandbox | `POST https://api.sandbox.ebay.com/identity/v1/oauth2/token` |
| Production | `POST https://api.ebay.com/identity/v1/oauth2/token` |

### 2.3 API base URIs

| API | Production | Sandbox |
| --- | --- | --- |
| Inventory | `https://api.ebay.com/sell/inventory/v1` | `https://api.sandbox.ebay.com/sell/inventory/v1` |
| Account | `https://api.ebay.com/sell/account/v1` | `https://api.sandbox.ebay.com/sell/account/v1` |
| Taxonomy | `https://api.ebay.com/commerce/taxonomy/v1` | *not supported in Sandbox* (see gotchas) |

eBay's own wording on every method page: *"This method is supported in Sandbox environment.
To access the endpoint, just replace the `api.ebay.com` root URI with `api.sandbox.ebay.com`."*

---

## 3. The RuName — what it actually is

This is the part that trips everyone up.

**The `redirect_uri` parameter in eBay's OAuth flow is NOT a URL. It is an opaque eBay-issued token
called a RuName** (also labelled "eBay Redirect URL name" in the portal). It looks like:

```
Davy_Developer-DavyDeve-DavysT-euiukxwt
```

From the docs, verbatim:

> "The requests to get user access tokens require a `redirect_url` value that is used for
> authorization, as well as a URL to redirect the user to after they have completed the permissions
> grant request. **Instead of a URL, the OAuth flow requires a custom RuName value that eBay
> generates and assigns to your application.**"

> "The RuName contains several pieces of information, including the accept URL and reject URL values,
> which lets you customize different pages, depending on how the user responds to the permissions
> grant request."

> "Your application has **two unique RuName values**, each supports either the Sandbox or Production
> environments."

### 3.1 What you configure in the portal

Path: **eBay Developer Program → Your Account → Application Keys → `User Tokens` link next to the
Client ID → "Get a Token from eBay via Your Application"**.

If you have no RuName yet, you click *"You have no Redirect URLs. Click here to add one."* You must
first complete a **"Confirm the Legal Address for the Primary Contact or Business"** form (real name
and address — this is a hard gate, plan for it). Then eBay generates the RuName string.

Behind that RuName you configure four fields:

| Field | Meaning (verbatim from eBay) |
| --- | --- |
| **Display Title** | "The title that eBay displays at the top of the Grant Application Access page during the client-grant flow." |
| **Privacy Policy URL** | "Enter the URL where you host your privacy policy." |
| **Auth Accepted URL** | "eBay redirects the user to this URL if the user grants your application the permissions it needs to act upon their behalf." |
| **Auth Declined URL** | "eBay redirects the user to this URL if the user does not grant your application the permissions it needs." |

> eBay note: *"If you are only using Application token, you do not need to fill out the rest of the
> RuName fields. URLs to your privacy policy and your accept and decline URLs are needed only if you
> are using User access tokens."* — We need User access tokens, so we must fill them in.

### 3.2 So the mapping is

```
authorize?redirect_uri=<RuName>          <-- the opaque token, NOT a URL
        |
        v  eBay looks up the RuName record
        |
   Auth Accepted URL (the real https:// URL you configured)
        ?state=<your-state>&code=<url-encoded-code>&expires_in=299
```

You then send that **same RuName string** (not the accept URL) as `redirect_uri` in the token
exchange POST body. Sending the real URL there is the classic `invalid_request` cause.

### 3.3 What the callback actually receives

Verbatim example from the docs:

```
https://www.example.com/acceptURL.html?
  state=<client_supplied_state_value>&
  code=v%5E1.1% ... NjA%3D&
  expires_in=299
```

- `code` — **URL-encoded**, single-use, **max 1024 characters**, valid **299 seconds (~5 min)**.
- `expires_in` — lifetime of the *authorization code*, not of the access token.
- `state` — echoed back verbatim if you sent it. eBay explicitly recommends using it for CSRF.

Docs: *"The authorization code returned from the authorization code grant is a single-use token that
can be used only to retrieve an access token. You cannot use the authorization code to make API
requests."* and *"Do not store this value, instead use the value only as a run-time parameter."*

---

## 4. CRITICAL: can the accept URL be `http://localhost`?

**No. And `https://localhost` is also rejected by the portal.**

### 4.1 Evidence

eBay's own docs never state the HTTPS rule on the RuName page, but they do state it plainly for the
sibling notification-endpoint field, which shows eBay's platform stance:

> "Please note that the provided endpoint URL should use the **'https' protocol, and it should not
> contain an internal IP address or 'localhost' in its path**."
> — *Marketplace User Account Deletion* guide (this is the account-deletion endpoint field, a
> **different** field from the RuName accept URL — do not conflate them, but it is the same policy family).

For the RuName accept URL specifically, the confirmation is **[COMMUNITY]** but consistent across
independent sources:

- eBay Community thread *"Test oAuth over localhost - redirect url"*: the Auth Accepted URL **"must
  support SSL and must use the HTTPS protocol."** Users report the portal's **Save button stays
  greyed out** when entering `https://localhost:7127/ebay/callback` in either the accepted or
  declined URL field.
- eBay Community thread *"RuName (eBay Redirect URL name) Not allowing localhost as 'auth accepted
  URL1'"* — same symptom, thread went unanswered.
- A Node.js walkthrough (gangyistudios, Medium) states plainly that **"'localhost' is not a valid
  redirect URL"** per eBay's validation, and works around it with a hosts-file entry.

**[UNCONFIRMED / CONFLICTING]** CData's connector docs claim *"For Desktop Apps you can set this to:
`https://localhost:33333`"*. This directly contradicts the community reports above. Treat it as
stale or generic boilerplate. **Do not design around it.** Verify by hand in the portal before
relying on a loopback listener.

### 4.2 Recommended approach for this CLI

**Primary — hosts-file hostname + HTTPS loopback server** (this is the standard desktop workaround,
confirmed by two independent sources):

1. Add to `C:\Windows\System32\drivers\etc\hosts`:
   ```
   127.0.0.1  local.host
   ```
   (any hostname that *looks* like a real domain to eBay's validator; `local.host` is the commonly
   used one.)
2. Register `https://local.host:3000/ebay/callback` as the **Auth Accepted URL** in the RuName.
3. Run a Node HTTPS server on port 3000 with a **self-signed certificate**.
4. The browser will warn about the self-signed cert. The user clicks through once. (Chrome:
   `chrome://flags/#allow-insecure-localhost` also helps.)

**Fallback — manual paste (always works, zero infrastructure):**

Leave the accept URL as any https page you control (or eBay's default landing page). After the user
clicks **Agree**, they land on a page whose **address bar contains `?code=...&expires_in=299`**. The
CLI prompts: *"Paste the full URL from your browser address bar:"* and parses `code` out of it.

> **[COMMUNITY]** eBay Community, *"OAuth Redirect URL for Desktop Applications"*: *"don't specify a
> redirect URL on eBay. After the user consents, they will get a 'thank you' page on eBay. They will
> then copy the URL in the address bar which contains the consent token. They can paste it into your
> app where you will parse the token from it."* The original poster confirmed this worked.

**Recommendation for a personal CLI:** ship the **manual-paste flow as the default** (it is
dependency-free, has no cert warnings, and cannot break), and offer the loopback server as an
opt-in `--serve` convenience. The 299-second code lifetime is plenty for a copy-paste.

---

## 5. Scopes

### 5.1 The scope strings are always `api.ebay.com`, even in Sandbox

Scope identifiers are opaque strings. **They use the `https://api.ebay.com/...` form in BOTH
environments** — there is no `api.sandbox.ebay.com` scope string. Only the *endpoints* differ.

But note eBay's caveat:

> "Be aware, it's possible the **Sandbox and Production environments support different sets of
> scopes** for your application. When supplying the string of scopes in your token requests, be sure
> to match the scopes to the environment you're targeting."

The authoritative list for *your* keyset is on **Application Keys → OAuth Scopes**.

### 5.2 Scopes needed to create and publish inventory listings

| Scope string | Needed for |
| --- | --- |
| `https://api.ebay.com/oauth/api_scope/sell.inventory` | **Everything in the Inventory API** — inventory items, offers, publish, merchant locations |
| `https://api.ebay.com/oauth/api_scope/sell.account` | **Business policies** (fulfillment / payment / return), program opt-in, seller account settings |
| `https://api.ebay.com/oauth/api_scope` | Base scope — Taxonomy API and other public-data calls (client credentials) |
| `https://api.ebay.com/oauth/api_scope/sell.marketing` | **Only** if you create Promoted Listings campaigns / promotions. **Not needed to list.** |
| `https://api.ebay.com/oauth/api_scope/sell.fulfillment` | Orders / shipping fulfillment. Not needed to list. |

Read-only variants exist (`sell.inventory.readonly`, `sell.account.readonly`, `sell.marketing.readonly`).
eBay best practice: *"there is no need to specify a read-only scope if the corresponding view and
manage scope is also being specified."*

### 5.3 Verified per-call scope mapping

Each of these was read directly off the method's reference page ("OAuth scope" section):

| Call | Method + path | Grant flow | Scope |
| --- | --- | --- | --- |
| `createOrReplaceInventoryItem` | `PUT /sell/inventory/v1/inventory_item/{sku}` | Authorization Code | `sell.inventory` |
| `createInventoryLocation` | `POST /sell/inventory/v1/location/{merchantLocationKey}` | Authorization Code | `sell.inventory` ✅ verified |
| `createOffer` | `POST /sell/inventory/v1/offer` | Authorization Code | `sell.inventory` |
| `publishOffer` | `POST /sell/inventory/v1/offer/{offerId}/publish` | Authorization Code | `sell.inventory` ✅ verified |
| `createFulfillmentPolicy` | `POST /sell/account/v1/fulfillment_policy/` | Authorization Code | `sell.account` ✅ verified |
| `optInToProgram` | `POST /sell/account/v1/program/opt_in` | Authorization Code | `sell.account` ✅ verified |
| `getCategorySuggestions` | `GET /commerce/taxonomy/v1/category_tree/{id}/get_category_suggestions` | **Client Credentials** | `https://api.ebay.com/oauth/api_scope` ✅ verified |

✅ = the exact "OAuth scope" block was read on that method's page during this research.
Unmarked rows are the same-family calls on the same resource and follow the identical pattern;
they are high-confidence but were not each individually opened.

### 5.4 Scope string to send

URL-encoded, space-separated (`%20` between entries):

```
https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account
```

---

## 6. Client Credentials vs Authorization Code — which token for which call

From the docs:

> "The **client credentials** grant flow is used to mint **application tokens**, which can be used if
> the application is accessing or working with resources and data that is **not specific to an eBay
> user**. Good examples of methods that require application tokens are **metadata or taxonomy calls**."

> "The **authorization code** grant flow is used to mint **user tokens**, which are used for methods
> that post or return data that is **specific to an eBay user**. There are a lot more methods that
> require user tokens than application tokens."

**For this CLI:**

- **Everything that writes a listing** (Inventory API, Account API) → **User access token**
  (authorization code grant). No exceptions.
- **Taxonomy / category suggestions / metadata** → **Application access token**
  (client credentials grant).

So the CLI needs **both** token managers. The `token_type` field in the response tells you which you
got: `"User Access Token"` vs `"Application Access Token"`.

---

## 7. Token lifetimes

| Token | Field | Value | Meaning |
| --- | --- | --- | --- |
| Authorization code | `expires_in` (on the callback URL) | `299` | ~5 minutes, single use |
| User access token | `expires_in` | `7200` | 2 hours |
| Refresh token | `refresh_token_expires_in` | `47304000` | ~18 months (547.5 days) |
| Application access token | `expires_in` | `7200` | 2 hours |

**Critical implementation detail:** the **refresh response does NOT return a new refresh token.**
eBay's documented refresh response is only:

```json
{
  "access_token": "v^1.1#i ... AjRV4yNjA=",
  "expires_in": 7200,
  "token_type": "User Access Token"
}
```

> **[UNCONFIRMED — and contradicted]** Several community/blog sources claim "each time you use a
> refresh token, eBay provides a new refresh token with a fresh 18-month expiry." eBay's own
> documented response payload contains **no `refresh_token` field**. Write the persistence layer to
> **keep the original refresh token** and only overwrite it if a `refresh_token` field is actually
> present in the response. Do not assume the 18 months rolls forward — plan for a hard re-consent at
> ~18 months.

eBay's guidance on refresh strategy:

> "it is best to **refresh each access token after it expires** (and you receive an 'Invalid access
> token' error), rather than trying to renew each token before it expires."

Refresh tokens can also be revoked early — docs call out seller login-name changes, password changes,
and consent revocation. Handle revocation by falling back to a full re-consent.

---

## 8. Request shapes (real curl)

Throughout: `BASIC=$(printf '%s:%s' "$CLIENT_ID" "$CLIENT_SECRET" | base64 -w0)`

> On Windows PowerShell:
> ```powershell
> $BASIC = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$CLIENT_ID`:$CLIENT_SECRET"))
> ```
> The Base64 payload is exactly `<client_id>:<client_secret>` — no URL-encoding of the parts,
> no trailing newline. eBay: *"Base64 encode the following: `<client_id>:<client_secret>`"* and the
> header is `Basic ` + that value.

### 8.1 Step 1 — send the user to the consent page (production, German locale)

```
https://auth.ebay.com/oauth2/authorize
  ?client_id=YourApp-PRD-1234567890-abcdef12
  &redirect_uri=Your_Name-YourApp-PRD-abcde
  &response_type=code
  &scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope%2Fsell.inventory%20https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope%2Fsell.account
  &state=9f2c1a7b4e
  &locale=de-DE
```

Sandbox: swap the host for `https://auth.sandbox.ebay.com/oauth2/authorize`.

Query parameters (all verbatim from the docs table):

| Param | Required | Notes |
| --- | --- | --- |
| `client_id` | Required | Client ID for the environment you're targeting |
| `redirect_uri` | Required | **The RuName**, not a URL |
| `response_type` | Required | Literal `code` |
| `scope` | Required | URL-encoded, space-separated |
| `state` | Optional | Echoed back; use it for CSRF |
| `locale` | Optional | **`de-DE` for Germany** — localizes the consent page |
| `prompt` | Optional | Set to `login` to force re-authentication even with an existing session |

For ebay.de, **set `locale=de-DE`** so the seller sees a German consent screen.

### 8.2 Step 2 — exchange the code for a User access token

```bash
curl -X POST 'https://api.ebay.com/identity/v1/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "Authorization: Basic ${BASIC}" \
  -d 'grant_type=authorization_code' \
  -d 'code=v%5E1.1%23i%5E1%23f%25 ... 3D%3D' \
  -d 'redirect_uri=Your_Name-YourApp-PRD-abcde'
```

Response:

```json
{
  "access_token": "v^1.1#i^1#p^3#r^1...XzMjRV4xMjg0",
  "expires_in": 7200,
  "refresh_token": "v^1.1#i^1#p^3#r^1...zYjRV4xMjg0",
  "refresh_token_expires_in": 47304000,
  "token_type": "User Access Token"
}
```

**The URL-encoding trap** — verbatim from eBay:

> "The authorization code returned by eBay is URL-encoded. This value must be URL-encoded when you
> pass the value in the `code` parameter of the authorization code grant request. **However, if the
> method you use to make the request URL-encodes the values you pass, then you must URL-decode the
> authorization code before using it** in the authorization code grant request."

In Node this matters: if you build the body with `URLSearchParams` (which encodes for you), you must
pass the **decoded** code. If you hand-concatenate the body string, pass the **encoded** code.
Double-encoding is the #1 cause of `invalid_grant` here.

```ts
// Correct with URLSearchParams — decode first, let URLSearchParams re-encode
const codeFromCallback = new URL(pastedUrl).searchParams.get('code')!; // already decoded by URL API
const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code: codeFromCallback,          // decoded
  redirect_uri: RU_NAME,
});
```

### 8.3 Step 3 — refresh the User access token

```bash
curl -X POST 'https://api.ebay.com/identity/v1/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "Authorization: Basic ${BASIC}" \
  -d 'grant_type=refresh_token' \
  -d 'refresh_token=v^1.1#i^1#p^3# ... fMSNFXjEyODQ=' \
  -d 'scope=https://api.ebay.com/oauth/api_scope/sell.account%20https://api.ebay.com/oauth/api_scope/sell.inventory'
```

Response:

```json
{
  "access_token": "v^1.1#i ... AjRV4yNjA=",
  "expires_in": 7200,
  "token_type": "User Access Token"
}
```

`scope` is **optional** here:

> "If you do not specify a `scope` parameter, the default will be the set of scope values included in
> the consent request. If you do specify a `scope` parameter, the included scope values must be
> **equal to or a subset of** the scope values included in the consent request."

Simplest correct behaviour: **omit `scope` on refresh.**

### 8.4 Application access token (client credentials) — for Taxonomy

```bash
curl -X POST 'https://api.ebay.com/identity/v1/oauth2/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H "Authorization: Basic ${BASIC}" \
  -d 'grant_type=client_credentials' \
  -d 'scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
```

Response:

```json
{
  "access_token": "v^1.1#i^1#p^1#r^0#I^3#f^0#t^H4s ... wu67e3xAhskz4DAAA",
  "expires_in": 7200,
  "token_type": "Application Access Token"
}
```

### 8.5 Using the token against a Sell API (ebay.de)

```bash
curl -X POST 'https://api.ebay.com/sell/inventory/v1/offer/1234567890/publish' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'X-EBAY-C-MARKETPLACE-ID: EBAY_DE' \
  -H 'Content-Language: de-DE' \
  -H 'Accept-Language: de-DE'
```

`X-EBAY-C-MARKETPLACE-ID: EBAY_DE` is the marketplace selector. `Content-Language: de-DE` is required
by the Inventory API on write calls that carry localized content (offer descriptions, item titles)
for the German marketplace.

---

## 9. Rate limits on the token endpoint

eBay enforces per-app daily caps on `https://api.ebay.com/identity/v1/oauth2/token`:

| Grant type | Token minted | Rate limit |
| --- | --- | --- |
| `client_credentials` | Application access token | **1,000 requests/day** |
| `authorization_code` | User access token | **10,000 requests/day** |
| `refresh_token` | User access token | **50,000 requests/day** |

The client-credentials limit of 1,000/day is the tight one. Cache the application token for its full
2 hours (12 mints/day) rather than minting per call. eBay: *"applications should store access tokens
in memory and re-use them until they expire."*

---

## 10. Developer Program prerequisites (what must exist before any of this works)

### 10.1 Account and keysets

1. **Register for the eBay Developer Program** (developer.ebay.com) — a developer account, distinct
   from your eBay selling account.
2. **Generate keysets.** You get a separate keyset per environment:
   - Sandbox keyset: App ID (Client ID), Dev ID, Cert ID (Client Secret)
   - Production keyset: App ID (Client ID), Dev ID, Cert ID (Client Secret)
   The **Client ID = App ID** and **Client Secret = Cert ID**. Naming is inconsistent across eBay's
   own UI; they are the same values.
3. **Create a RuName per environment** (see §3.1). Requires completing the legal-address confirmation
   form. Fill in Display Title, Privacy Policy URL, Auth Accepted URL, Auth Declined URL.
4. **Confirm your OAuth scopes** on Application Keys → OAuth Scopes. A keyset is only granted a
   subset of scopes; if `sell.inventory` is not listed there, your token requests will fail no matter
   what you send.

### 10.2 Marketplace account deletion — **YES, still mandatory in 2026**

Verbatim from the current *Marketplace User Account Deletion* guide:

> "**All** existing and new third-party developers integrated with eBay APIs via the eBay Developers
> Program are **required to**: 1) **subscribe** to eBay marketplace account deletion/closure
> notifications; or 2) follow the process to **opt out** of subscribing to these notifications if
> they do not store any eBay data."

> "Failure to comply with this requirement will result in **termination of your access to the
> Developer Tools**, and/or reduced access to all or some APIs. New third-party developers coming to
> the platform must subscribe to or opt out **before they make their first production API call**.
> Once the new developer's application is subscribed ... or they have successfully opted out ...,
> **the keyset/App ID is activated** and they can begin making API calls."

**Two important consequences:**

1. **Sandbox is unaffected.** The gate is on the *first production API call*. You can build and test
   the entire flow against Sandbox before dealing with this.
2. **There is an opt-out path**, and for a personal CLI that stores tokens locally it may apply:
   > "For any developer application that is **not persisting any eBay data**, there is an option to
   > opt out ... However, developers should be aware that failure to provide correct information may
   > result in penalties or having their account disabled."

   Portal path: **Application Keys → Notifications → Marketplace Account Deletion page → slide the
   "Not persisting eBay data" toggle to On → Confirm → select an Exemption reason → Submit.**

   ⚠️ Judgement call, not a doc fact: a listing CLI that caches SKUs, offer IDs, or seller data
   arguably *does* persist eBay data. Assess honestly — eBay warns of penalties for incorrect claims.

**If you subscribe instead**, the endpoint requirements are strict:

- Portal path: **Application Keys → `Notifications` link next to App ID → Alerts and Notifications →
  select "Marketplace Account Deletion" radio → save an alert email → set Notification Endpoint URL →
  set Verification token.**
- Endpoint **must be HTTPS**, must not contain an internal IP or `localhost`.
- **Verification token: 32–80 characters**, allowed characters are alphanumeric, underscore (`_`),
  and hyphen (`-`) only.
- eBay immediately sends `GET https://<callback_URL>?challenge_code=123`.
- You must reply **200 OK**, `Content-Type: application/json`, body:
  ```json
  { "challengeResponse": "<sha256 hex>" }
  ```
- The hash is **`sha256(challengeCode + verificationToken + endpoint)`, hex-encoded, in exactly that
  order** — wrong order fails validation. eBay's own Node.js snippet:
  ```js
  const hash = createHash('sha256');
  hash.update(challengeCode);
  hash.update(verificationToken);
  hash.update(endpoint);
  const responseHash = hash.digest('hex');
  ```
  `endpoint` is the full endpoint URL string as registered.
- ⚠️ eBay explicitly warns: **build the response with a JSON library, not string concatenation** — a
  hand-written string often gets a BOM prepended, which is invalid JSON and silently fails subscription.

Ongoing notifications arrive as HTTP POST with a `MARKETPLACE_ACCOUNT_DELETION` topic and a
`notification.data` object containing `username`, `userId`, and `eiasToken`.

### 10.3 Seller-account prerequisites for listing on ebay.de

- The **eBay selling account** that grants consent must be a German (ebay.de) seller account for
  `EBAY_DE` listings.
- **Business policies must be opted in** before the Inventory API can attach fulfillment/payment/
  return policies to an offer. Use `POST /sell/account/v1/program/opt_in` with
  `{"programType": "SELLING_POLICY_MANAGEMENT"}` (scope `sell.account`). ✅ verified — the
  `ProgramTypeEnum` values are `OUT_OF_STOCK_CONTROL`, `PARTNER_MOTORS_DEALER`,
  `SELLING_POLICY_MANAGEMENT`.
- At least one **merchant inventory location** must exist (`createInventoryLocation`) before
  `publishOffer` will succeed.

---

## 11. Gotchas / common 400s

1. **Sending the accept URL instead of the RuName** as `redirect_uri` → `invalid_request`. It is
   always the RuName string, in both the authorize URL and the token POST.
2. **Double-encoding the authorization code** → `invalid_grant`. See §8.2.
3. **Wrong environment RuName.** Sandbox and Production have *different* RuName values. Mixing them
   fails at the consent step with an unhelpful error.
4. **Assuming refresh returns a new refresh token** — it does not, per the documented payload. Don't
   overwrite your stored refresh token with `undefined`.
5. **Authorization code expires in 299 seconds.** A slow manual copy-paste can blow past it.
6. **Scope not granted to your keyset.** The scopes in your token request must be a subset of what
   Application Keys → OAuth Scopes shows for that environment. Sandbox and Production sets can differ.
7. **Taxonomy `getCategorySuggestions` is NOT supported in Sandbox** — verbatim: *"This method is not
   supported in Sandbox environment."* You cannot test category suggestion against Sandbox at all;
   hard-code a category ID for Sandbox testing.
8. **Client-credentials rate limit is only 1,000/day.** Cache aggressively.
9. **Business policies not opted in** → `publishOffer` fails with policy-not-found style errors even
   though the offer was created fine.
10. **Missing `Content-Language: de-DE`** on Inventory write calls for EBAY_DE → 400 on localized
    content fields.
11. **Missing merchant location** → `publishOffer` fails.
12. **Self-signed cert** on the loopback approach: Node's own `fetch`/`https` will reject it if the
    CLI ever calls itself; the browser will warn the user once. This is cosmetic but confusing.

---

## 12. Suggested CLI token flow

```
                 ┌─ token.json exists? ─────────────────┐
                 │                                       │
                no                                     yes
                 │                                       │
      ┌──────────▼──────────┐              ┌────────────▼────────────┐
      │ Build authorize URL │              │ access_token still      │
      │ (locale=de-DE)      │              │ valid (< 2h)?           │
      │ Print + open browser│              └──────┬───────────┬──────┘
      └──────────┬──────────┘                    yes          no
                 │                                │            │
      ┌──────────▼──────────┐                     │   ┌────────▼────────┐
      │ User pastes full    │                     │   │ POST refresh_   │
      │ redirect URL        │                     │   │ token grant     │
      └──────────┬──────────┘                     │   └────────┬────────┘
                 │                                │            │
      ┌──────────▼──────────┐                     │      on invalid_grant
      │ Verify state, parse │                     │      → re-consent
      │ code                │                     │
      └──────────┬──────────┘                     │
                 │                                │
      ┌──────────▼──────────┐                     │
      │ POST authorization_ │                     │
      │ code grant          │                     │
      └──────────┬──────────┘                     │
                 │                                │
                 └────────► store {access_token, expires_at,
                                   refresh_token, refresh_expires_at} ◄──┘
```

Store tokens with restrictive file permissions. eBay: *"Store your OAuth credentials and refresh
tokens on a secure server."* For a local CLI, at minimum keep them out of the repo and out of shell
history.

---

## 13. Sources

**Primary (developer.ebay.com, read via browser):**
- `https://developer.ebay.com/develop/guides-v2/authorization` — consolidated OAuth guide: endpoints,
  RuName, consent params, all three grant requests, response payloads, lifetimes, rate limits,
  best practices
- `https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion` — mandatory
  subscription/opt-out, challenge-code validation, hashing snippets
- `https://developer.ebay.com/develop/api/sell/inventory_api/offer/publishoffer`
- `https://developer.ebay.com/develop/api/sell/inventory_api/location/createinventorylocation`
- `https://developer.ebay.com/develop/api/sell/account_api_v1/fulfillment_policy/createfulfillmentpolicy`
- `https://developer.ebay.com/develop/api/sell/account_api_v1/program/optintoprogram`
- `https://developer.ebay.com/develop/api/sell/taxonomy_api/category_tree/getcategorysuggestions`

**Secondary / community (marked in-line where relied upon):**
- `https://apitut.com/ebay/api/scopelist.html` — full scope string list
- `https://github.com/hendt/ebay-api` (`src/auth/oAuth2.ts`, `README.md`) — endpoint + grant
  confirmation, `X-EBAY-C-MARKETPLACE-ID: EBAY_DE`
- eBay Community: *"Test oAuth over localhost - redirect url"* — HTTPS/SSL requirement, greyed-out Save
- eBay Community: *"OAuth Redirect URL for Desktop Applications"* — manual-paste workaround
- eBay Community: *"RuName ... Not allowing localhost as 'auth accepted URL1'"* — corroborating report
- Medium (gangyistudios), *Generate User & Application Access Tokens for eBay RESTful APIs* —
  hosts-file + self-signed cert workaround
- CData connector docs — **conflicting** `https://localhost:33333` claim, flagged as unreliable
