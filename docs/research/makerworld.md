# MakerWorld — single-page model metadata extraction

**Scope:** what ONE user-initiated fetch of ONE MakerWorld model page can reliably obtain, and the
compliance constraints around doing it. This is explicitly **not** a design for a crawler.

**Researched:** 2026-08-11. All HTTP observations below were made live against
`makerworld.com` / `api.bambulab.com` from a German (FRA) egress on that date.
Findings marked *(verified)* were reproduced directly; everything else is cited.

---

## 1. URL shape and identifiers

Canonical model URL:

```
https://makerworld.com/{locale}/models/{designId}-{slug}
e.g. https://makerworld.com/en/models/1029890-flexi-funny-octopus
```

Observed behaviour *(verified)*:

| Input | Result |
| --- | --- |
| `https://makerworld.com/models/12703` (no locale, no slug) | 2 redirects → `https://makerworld.com/en/models/12703-bambu-bed-scraper`, HTTP 200 |
| `https://makerworld.com/en/models/12703-total-nonsense-slug` | HTTP 200, identical 1,385,369-byte body — **the slug is decorative, the numeric id is authoritative** |
| `https://makerworld.com/en/models/999999999-nope` | HTTP **200** (not 404); `__NEXT_DATA__.props.pageProps.design === {"status":-1}` |

The locale prefix is mandatory server-side: `/robots.txt` 307-redirects to `/en/robots.txt`.
Locale-less paths are redirected, not rewritten.

### Identifiers carried

| Identifier | Where | Example | Notes |
| --- | --- | --- | --- |
| **designId** (numeric) | URL path, `design.id` | `1029890` | The primary key. This is what `design-service` takes. |
| **slug** | URL path, `design.slug` | `flexi-funny-octopus` | SEO only; ignored on lookup. |
| **modelId** (string) | `design.modelId` | `USea5cf9cb2d0057` | Storage-bucket key. Appears in every CDN asset path for that model. NOT usable as a page id. |
| **profileId** / instanceId | `design.instances[].profileId` / `.id` | `284748364` / `1396022` | A "print profile". Deep-linked as `…/models/{id}-{slug}#profileId-{profileId}` (the `#profileId` fragment handler is present in the page chunk `pages/models/[designId]-*.js`). `profileId` is the id the download endpoint wants; `id` is the instance row id. |
| **uid** | `design.designCreator.uid` | `4096780105` | Designer numeric id; `handle` gives the vanity name. |

Regex that covers what a user will realistically paste:

```
^https?://(?:www\.)?makerworld\.com(?:/[a-z]{2}(?:-[A-Za-z]{2})?)?/models/(\d+)(?:-[^/?#]*)?(?:[/?#].*)?$
```

Capture group 1 (the numeric designId) is the only part you need.

---

## 2. Is it Next.js? `__NEXT_DATA__` vs `self.__next_f`

**Next.js Pages Router. `__NEXT_DATA__` is present; there is no `self.__next_f` streaming payload.** *(verified)*

```
grep -c '__NEXT_DATA__' model.html   -> 1
grep -c 'self.__next_f' model.html   -> 0
```

Structure:

```html
<script id="__NEXT_DATA__" type="application/json">{ … }</script>
```

Top-level keys: `props, page, query, buildId, isFallback, isExperimentalCompile, gssp, locale, locales, defaultLocale, scriptLoader`.

- `page` = `"/models/[designId]"` — a reliable sanity check that you actually landed on a model page.
- `query` = `{"designId":"1029890-flexi-funny-octopus"}` — note the query value is the **whole** `id-slug` segment.
- `gssp: true` → server-side rendered per request (`getServerSideProps`), so the JSON is fully populated in the initial HTML. **No JS execution is needed to read the model metadata.**
- `buildId` (e.g. `gbZP9c8P6nxLmHPHAr2Qv`) changes on every deploy — never hardcode it.

The payload is large: **~864 KB of JSON inside a ~1.3 MB HTML document** for a typical model.
About two thirds of that is `relateDesigns` / `remixedDesigns` (recommendation carousels), not the model itself.

Parser target:

```js
props.pageProps.design        // the model — 60+ fields, see §4
props.pageProps.remixedDesigns
props.pageProps.relateDesigns
props.pageProps._nextI18Next  // full i18n dictionary, ~200 KB of dead weight
```

### Brittleness assessment

| Layer | Brittleness | Why |
| --- | --- | --- |
| `<script id="__NEXT_DATA__">` extraction | **Low** | Stable Next.js Pages-Router contract. Would only break on a wholesale migration to App Router (which would swap in `self.__next_f.push([...])` chunks — worth a defensive check). |
| `props.pageProps.design` path | **Low–Medium** | Stable in current build; it is an internal prop name with no compatibility guarantee. |
| Individual field names inside `design` | **Medium** | Internal API shape. Note the misspelling `extention` (sic) and `premission` (sic) in their code — these are load-bearing typos, do not "fix" them. |
| CSS-class/DOM scraping (`mw-css-*`) | **High** | Emotion-generated hashes, regenerated per build. Never target these. |

Recommended extraction order (cheapest reliable → fallback):

1. `api.bambulab.com/v1/design-service/design/{id}` (§3) — smaller, cleaner, no Cloudflare UA gate.
2. `__NEXT_DATA__` → `props.pageProps.design`.
3. `<meta property="og:*">` + the server-rendered License block (§4) — coarse but survives JSON restructuring.

Parse the script tag with a regex on the raw HTML rather than a DOM parser; the JSON body contains
`</` sequences only inside JSON-escaped strings, so
`/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/` is safe *(verified on 7 pages)*.
Guard the JSON with a size cap — a 900 KB `JSON.parse` per request is not free.

There is **no JSON-LD** on the page (`application/ld+json` count = 0) *(verified)*, so schema.org extraction is not an option.

---

## 3. `api.bambulab.com/v1/design-service` — what it actually does

Community documentation: [Doridian/OpenBambuAPI `cloud-makerworld.md`](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-makerworld.md)
and [Bambuddy wiki – MakerWorld integration](https://wiki.bambuddy.cool/features/makerworld/).
Both state that *all* design-service endpoints require `Authorization: Bearer <JWT>`.

**That is not true for the design-detail read.** *(verified 2026-08-11)*

```
GET https://api.bambulab.com/v1/design-service/design/1029890
  -> HTTP 200, 278,409 bytes of JSON, NO Authorization header
  -> identical result from https://makerworld.com/api/v1/design-service/design/1029890
  -> identical result with User-Agent: python-requests/2.31.0
  -> identical result with NO User-Agent header at all
GET .../design/999999999
  -> HTTP 404  {"code":404,"error":"The server cannot find the requested resource."}
```

So for public, free designs the detail endpoint is **anonymous-readable**. Treat this as an
undocumented, unversioned implementation detail that can be closed at any time — not a contract.

### Endpoints (community-documented; auth column = observed where marked ✓)

| Endpoint | Method | Auth | Returns |
| --- | --- | --- | --- |
| `/v1/design-service/design/{designId}` | GET | **none needed for public designs** ✓ | Full design object — same shape as `pageProps.design`. Optional `?trafficSource=browse\|recommend\|search`, `?visitHistory=true` (analytics; omit both). |
| `/v1/design-service/design/{designId}/remixed` | GET | not tested | Designs that remix this one. |
| `/v1/design-service/design/{designId}/like` | POST | Bearer | Toggle like. Write op — out of scope. |
| `/v1/design-service/instance/{instanceId}/f3mf?type=preview\|download` | GET | Bearer | 3MF metadata / binary. Bambuddy notes the `makerworld.com/api/v1/...f3mf` path is "cookie-gated at Cloudflare" and unusable from a backend. |
| `/v1/iot-service/api/user/profile/{profileId}?model_id={modelId}` | GET | Bearer | `{url, name}` — a **5-minute-TTL presigned S3 URL** for the file. Not design-service, but this is the actual download path. |
| `/v1/design-service/favorites/designs/{userId}` | GET | Bearer | User favourites. |
| `/v1/design-service/my/design/like`, `/my/design/favoriteslist`, `/my/favorites/listlite`, `/draft/sliceerror` | GET | Bearer | Per-user; irrelevant here. |

Bambuddy documents the token as a Bambu Cloud bearer valid ~90 days, non-renewable without
re-login, scoped `makerworld:view` / `makerworld:import`.

### Cloudflare on the API

`api.bambulab.com` **is** behind Cloudflare (`Server: cloudflare`, sets `__cf_bm`), but for
`design-service/design/{id}` it is *not* running a challenge — `cf-cache-status: DYNAMIC`, no
`cf-mitigated` header, and bot-like UAs pass *(verified)*. This is the opposite of the HTML site (§7).
`HEAD` is rejected: `405 Method Not Allowed, allow: GET, DELETE`.

Practical implication for a single-page tool: **prefer the API for metadata** (278 KB JSON vs
1.3 MB HTML, no UA spoofing needed, honest 404s), and keep `__NEXT_DATA__` as the fallback.

---

## 4. Licence — the gate field

### Where it lives

Three independent places, in decreasing order of machine-friendliness:

1. **`design.license`** — a short string. Present in both `__NEXT_DATA__` and the API response. *(verified)*
   Observed values: `"BY-NC"`, `"Standard Digital File License"`.
2. **`design.licenseDescriptionInfo`** — `{title, content}`. **Only populated for the proprietary
   licences**; it is `{"title":"","content":""}` for CC licences *(verified on `12703`, BY-NC)*.
   For SDFL it carries the full restriction text
   ("You shall not share, sub-license, sell, rent, host, transfer, or distribute…").
   Do **not** key your gate on this — it is empty exactly where the permissive licences are.
3. **Server-rendered HTML** — a `<h4>License</h4>` block containing the badge image and, for CC
   licences, a direct link to the deed *(verified)*:
   ```html
   <img src="https://makerworld.bblmw.com/makerworld/static/creativecommons/by-nc.png">
   <div>This user content is licensed under a</div>
   <a href="https://creativecommons.org/licenses/by-nc/4.0/">Creative Commons Attribution-Noncommercial</a>
   ```
   Regexing `creativecommons\.org/licenses/([a-z-]+)/4\.0` out of the HTML is a decent
   cross-check that survives JSON refactors.
4. **`design.allowReCreation`** (boolean) — MakerWorld's own derived "may be remixed" flag.
   `true` for BY-NC, `false` for SDFL *(verified)*. A useful corroborating signal, not a
   commercial-use signal.

### The complete licence enumeration

Extracted verbatim from MakerWorld's own bundle
`https://makerworld.com/_next/static/chunks/pages/_app-<hash>.js` (module `78412`) *(verified)*.
This is the authoritative table the site itself uses; `value` is exactly the string that appears
in `design.license`.

| `design.license` value | Label | Deed link | `commmerical` (sic) | `premission` (sic) |
| --- | --- | --- | --- | --- |
| `CC0` | Creative Commons-Public Domain | `/share-your-work/public-domain/cc0/` | **1** | `[T,T,T,T,T]` |
| `BY` | Creative Commons-Attribution | `/licenses/by/4.0/` | **1** | `[F,T,T,T,T]` |
| `BY-SA` | Creative Commons-Attribution-Share Alike | `/licenses/by-sa/4.0/` | **1** | `[F,T,T,T,T]` |
| `BY-ND` | Creative Commons-Attribution-NoDerivatives | `/licenses/by-nd/4.0/` | **1** | `[F,F,T,T,T]` |
| `BY-NC` | …-Noncommercial | `/licenses/by-nc/4.0/` | 2 | `[F,T,F,F,F]` |
| `BY-NC-SA` | …-Noncommercial-Share Alike | `/licenses/by-nc-sa/4.0/` | 2 | `[F,T,F,F,F]` |
| `BY-NC-ND` | …-Noncommercial-NoDerivatives | `/licenses/by-nc-nd/4.0/` | 2 | `[F,F,F,F,F]` |
| `Standard Digital File License` | (same) | — | 2 | `[F,F,F,F,F]` |
| `MakerWorld Exclusive License` | (same) | — | 2 | `[F,F,F,F,F]` |
| `Standard Digital File License - Community Use` | (same) | — | 2 | `[F,F,F,F,F]` |
| `Standard Digital File License - Platform Print Only (SDFL-PPO)` | (same) | — | 2 | `[F,F,F,F,F]` |

Badge asset base: `https://makerworld.bblmw.com/makerworld/static/creativecommons/{by,by-sa,by-nd,by-nc,by-nc-sa,by-nc-nd,cc-zero,standard-digital-file-license,standard-digital-file-license-community-use,makerworld-exclusive-license,only-mw-print-license}.png`
(`makerworld.bblmw.cn` on the CN site).

Note the CC values are **bare** (`BY-NC`), not `CC-BY-NC`. Prefix normalisation is on you.
`premission[1]` is the derivatives/remix flag; `premission[2..4]` are the commercial-family flags.

### How to determine "commercial use allowed"

```js
const COMMERCIAL_OK = new Set(['CC0', 'BY', 'BY-SA', 'BY-ND']);

function commercialUseAllowed(license) {
  if (typeof license !== 'string') return { allowed: false, reason: 'missing' };
  const v = license.trim().replace(/^CC[- ]/i, '').toUpperCase();
  if (COMMERCIAL_OK.has(v)) return { allowed: true, reason: v };
  if (KNOWN_NONCOMMERCIAL.has(license.trim())) return { allowed: false, reason: license };
  return { allowed: false, reason: 'unknown-license:' + license }; // fail closed
}
```

Rules the gate must respect:

- **Fail closed on any unrecognised string.** MakerWorld has added licence types over time
  (SDFL-PPO, Community Use, Exclusive are all newer than the CC set); a new one must not
  default to "allowed".
- **`BY-ND` allows commercial use but forbids derivatives.** If your tool does anything that
  creates a derivative (remixing, re-rendering, re-cutting the model), `commercialUseAllowed`
  alone is insufficient — check `premission[1]` / `allowReCreation` too.
- **`BY-SA` allows commercial use but is copyleft.** Downstream obligations apply.
- **`CC0` is the only licence not requiring attribution** (`premission[0]`). For everything else
  surface `designCreator.name` + the canonical URL.
- **The licence field is not the whole story.** Observed on design `1029890` *(verified)*: licence
  is SDFL (non-commercial) but the description says "Commercial license is available for this
  design by subscribing to [Patreon]". Conversely, some CC-BY models carry description text
  restricting commercial use. A licence gate reading `design.license` is a *floor*, not a legal
  conclusion — surface the description and the deed link to the user rather than asserting rights.
- Also check `design.paidSetting.isPaid` and `design.status`; `status: -1` means the design page
  rendered but there is no design (deleted / never existed).

MakerWorld's own Terms confirm the licence is a real, user-selected grant:
> "the User is required to select a type of License from a set of License Terms including without
> limitation the Creative Commons License (CCLs) (the 'Free Licenses'). Other Users of the Services
> can access and use the User Content per the Free License selected by you… the Free Licences are
> irrevocable after publication."
> — [Terms of Use §"User Content"](https://makerworld.com/en/user-agreement)

---

## 5. Available metadata

All of the following are present in a single response (both `pageProps.design` and the
design-service JSON — same shape) *(verified on `1029890` and `12703`)*.

### Design level

```
id, modelId, designType, title, slug, titleTranslated,
summary            // HTML string (rich text, incl. proprietary <boostme> tags) — sanitise before render
summaryTranslated,
coverUrl, coverLandscape, coverPortrait,
tags[], tagsTranslated[], tagsOriginal[],
categories[]       // [{id, name, slug, picUrl, …}] — leaf first, then parent
designCreator      // {uid, name, handle, avatar, fanCount, level, certificated, …}
license, licenseDescriptionInfo, allowReCreation,
likeCount, collectionCount, shareCount, printCount, commentCount,
downloadCount, rawModelFileDownloadCount, readCount,
createTime, updateTime,          // ISO-8601 Z
status, nsfw, isPrintable, isOfficial, isStaffPicked, pickReason,
isExclusive, isPointRedeemable, isAIGC, paidSetting {isPaid, crowdfunding},
modelSource,       // 1 = original, 3 = remix/shared (see i18n modelSourceOptions)
originals[],       // source models when this is a remix
instances[], defaultInstanceId,
designExtension { design_pictures[], design_video[], model_files[], boms*, … }
```

### Images / CDN

Two hosts *(verified)*:

- `https://makerworld.bblmw.com` — model covers, gallery photos, plate thumbnails, licence badges
  (`makerworld.bblmw.cn` for the China site; the base is selected at runtime by the bundle).
- `https://public-cdn.bblmw.com` — user avatars. `public-cdn.bambulab.com` for category icons.

Path pattern: `…/makerworld/model/{modelId}/design/{yyyy-mm-dd}_{hash}.{jpg|jpeg|webp}` for design
gallery images, and `…/makerworld/model/{modelId}/{profileId}/instance/{file}` for
per-print-profile photos and `plate_N.png` thumbnails.

It is an Alibaba OSS-style CDN and accepts image-processing query params — the page's own
`og:image` is emitted as:
```
…/design/2025-01-23_9d59945f3212d8.jpg?x-oss-process=image/resize,w_1200/ignore-error,1
```
so you can request your own thumbnail size rather than downloading full-res.

Some asset URLs are **signed and short-lived** — `model_files[].thumbnailUrl` carries
`?at=…&exp=…&key=…&uid=0` *(verified)*. Do not persist those; re-fetch.

### Print profiles (`instances[]`)

```
id, profileId, profile2dId, title, summary, isDefault, status,
cover, pictures[] {name, url, isRealLifePhoto, isCompression},
instanceCreator, publishTime, createTime, updateTime,
weight,            // grams, whole design
prediction,        // print time in seconds
materialCnt, materialColorCnt, needAms, hasZipStl, appCanPrint,
instanceFilaments[] {type, color, usedM, usedG},
downloadCount, printCount, ratingCount, ratingScoreTotal, score,
extention.modelInfo {
  compatibility        {devModelName:"N1", devProductName:"A1 mini", nozzleDiameter:0.4},
  otherCompatibility[] {devModelName:"C11", devProductName:"P1P", …},
  projectSettings      {layerHeight:"0.2", wallLoops:"2", sparseInfillDensity:"15%"},
  plates[] {
    index, name, prediction, weight,
    thumbnail {name, url}, top_picture, pick_picture,
    filaments[] {id, type, color, usedM, usedG},
    objects[], skipped_objects[], warning[]
  },
  auxiliaryPictures[], auxiliaryBom[], auxiliaryGuide[], auxiliaryOther[]
}
```

Note `extention` (sic) — misspelled in the API.

### File list

`design.designExtension.model_files[]` *(verified)*:

```
{ modelName: "STL Body .stl", modelType: "stl", modelSize: 12955084,
  modelUpdateTime: "2025-01-23T18:05:57.244Z",
  modelUrl: "",                 // ALWAYS EMPTY unauthenticated
  thumbnailUrl: "…?at=&exp=&key=&uid=0",   // signed, short TTL
  isDir, dirName, children[], protected, unikey, projectSettings, … }
```

So you get the **file manifest** (names, types, byte sizes, directory tree) but **not download
URLs**. Actual downloads go through the authenticated
`/v1/iot-service/api/user/profile/{profileId}?model_id={modelId}` presigned-URL flow.
`model_files` can also be an empty array (design `12703` — a Bambu-official model with 28 profiles
returned no `model_files` entries), so treat it as optional.

### `<meta>` fallbacks *(verified)*

`og:title` (`"{title} - Free 3D Print Model - MakerWorld"`), `og:url`, `og:image` (+`:width`/`:height`/`:type`),
`name="og:description"` (note: `name`, not `property` — a bug in their markup, handle both),
`twitter:card`, and `<link rel="canonical">`. Enough to render a link preview if the JSON path breaks.

---

## 6. robots.txt and Terms of Use

### robots.txt

`https://makerworld.com/robots.txt` 307s to `/en/robots.txt`, which returns in full *(verified)*:

```
# *
User-agent: *
Allow: /
Disallow: /sign-up
Disallow: /sign-in
Disallow: /my
Disallow: /policies
Disallow: /*/sign-up
Disallow: /*/sign-in
Disallow: /*/my
Disallow: /*/policies

# Host
Host: https://makerworld.com/

# Sitemaps
Sitemap: https://makerworld.com/sitemap.xml
```

Reading: **`/en/models/...` is explicitly allowed for all user agents.** No `Crawl-delay`, no
per-agent blocks, no AI-crawler-specific rules. The disallow list is auth/account/policy pages only.
(`/policies` being disallowed while the Terms live at `/en/user-agreement` — which is *not*
disallowed — is worth noting.)

### Terms of Use — the operative clause

From [https://makerworld.com/en/user-agreement](https://makerworld.com/en/user-agreement),
section 9 (Intellectual Property) *(fetched and quoted verbatim)*:

> "All content and data on this website (including but not limited to 3D model files, text, images,
> audio, video, etc.) are protected by applicable copyright law and/or equivalent laws and
> regulations. You may not use any 'deep-link', 'page-scrape', 'robot', 'spider' or other automatic
> device, program, algorithm or methodology, or by any means of artificial intelligence service, or
> any similar or equivalent manual process, to access, acquire, copy, reproduce, exploit or monitor
> any portion of the site or any content, or in any way reproduce or circumvent the navigational
> structure or presentation of the site or any content, to obtain or attempt to obtain any
> materials, documents or information through any means not purposely made available through the
> site. We reserve the right to pursue legal responsibilities for any behavior that violates this
> statement."

This is broad and explicitly names AI services and "deep-link". Read plainly it covers programmatic
page reads even at n=1.

### Compliance posture

The two sources conflict: robots.txt permits `/models/*`, the ToS prohibits automated access.
**The ToS is a contract; robots.txt is a convention. The ToS governs.** Points to carry into the design:

- A single fetch, on explicit per-URL user action, of a page the user could open in their own
  browser, is the *narrowest* possible posture — but it is not clearly outside the clause above.
- The clause also covers `api.bambulab.com`, which is Bambu Lab infrastructure and is not
  "purposely made available" as a public API (no published docs, no versioning promise, no ToS
  carve-out). Anonymous readability is not permission.
- Practical mitigations: no caching beyond what the user's session needs; no bulk/queued fetches;
  no background refresh; identify honestly in the User-Agent; store only what you display;
  attribute the designer and link the canonical URL; respect the licence gate for anything
  downstream. None of these make the ToS clause go away — they only reduce exposure.
- **Recommendation: treat this as legal-risk-accepted-by-the-user, surface it in the UI, and make
  the feature opt-in per URL.** If MakerWorld data is load-bearing for the product, the correct
  path is asking Bambu Lab for API access, not a nicer parser.

---

## 7. Failure modes for a single-page fetch

### The HTML site is UA-gated by Cloudflare

*(verified, same URL, same second, same IP)*

| User-Agent | Result |
| --- | --- |
| `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/126.0.0.0 Safari/537.36` | **HTTP 200**, 1.38 MB, full `__NEXT_DATA__` |
| curl default (`curl/8.x`) | **HTTP 403**, 5,589 bytes |
| `python-requests/2.31.0` | **HTTP 403**, 5,589 bytes |
| header omitted entirely | **HTTP 403**, 5,525 bytes |

The 403 body is the Cloudflare interstitial — text content is literally
`"Just a moment... Enable JavaScript and cookies to continue"`, with response headers:

```
HTTP/1.1 403 Forbidden
Cf-Mitigated: challenge
Server: cloudflare
Server-Timing: chlray;desc="…"
```

So: **a plain fetch with a normal browser User-Agent DOES work and returns fully server-rendered
HTML with complete model JSON.** No headless browser, no JS execution, no cookies needed for the
happy path. But the gate is UA-string-based and it *is* a Cloudflare managed challenge, which means
it can escalate at Cloudflare's discretion (IP reputation, datacenter ASN, request rate) without
any change on your side. Anthropic's own `WebFetch` tool was 403'd on `/robots.txt` during this
research — a real, observed instance of the gate firing on a non-browser client.

Also note: setting a browser UA you are not is, in itself, circumventing a bot mitigation — which
sits squarely inside the ToS clause quoted above. Sending an honest UA
(`3d-print-lister/0.1 (+contact)`) is the compliant choice and will get you a 403. That tension is
unresolvable in your favour; it is a product decision, not an engineering one.

### Failure taxonomy and detection

| Failure | Signal | Handling |
| --- | --- | --- |
| Cloudflare challenge | HTTP 403 + `cf-mitigated: challenge`, body contains `"Just a moment"` | Do not retry-loop. Surface "MakerWorld blocked the request" and offer to open the URL in the user's browser. |
| Cloudflare rate limit / ban | 429 or 403 with `cf-mitigated: block` | Back off hard; single-fetch tool should just fail. |
| Design does not exist | HTTP **200** with `pageProps.design.status === -1` (page) or HTTP 404 `{"code":404,…}` (API) | **The page never 404s** — you must check `design.status`. Treat `status !== 1` as unavailable. |
| Deleted / private / under review | `design.status` other than `1`; `design` may be a stub | Same as above. |
| Payload shape drift | `__NEXT_DATA__` present but `props.pageProps.design` undefined | Fall back to `og:*` meta; report degraded extraction rather than crashing. |
| App Router migration | `self.__next_f.push(` present, `__NEXT_DATA__` absent | Detect explicitly and fail with a clear "MakerWorld changed their page format" message. |
| Locale drift | Response served in a non-`en` locale (`__NEXT_DATA__.locale`) | Send `Accept-Language: en-US,en;q=0.9` and use the `/en/` prefix; check `locale` in the payload. |
| Signed asset expiry | `thumbnailUrl` with `exp=` in the past → 403 from CDN | Never persist signed URLs. |
| Oversized payload | ~1.4 MB HTML / ~900 KB JSON per fetch | Stream with a size cap; reject > ~5 MB. |

### What JS-rendering does and doesn't buy you

Nothing that matters. `gssp: true` means everything in §5 is in the first byte-stream. A headless
browser would only be needed to defeat the Cloudflare challenge — i.e. purely as a circumvention
tool, with no data benefit. Do not build that.

---

## 8. Bottom line for the tool

- **Use `GET https://api.bambulab.com/v1/design-service/design/{designId}`** with an honest
  User-Agent. It works anonymously today, returns the same object as the page, is 5× smaller, and
  gives honest 404s. *(verified)*
- **Fall back to the HTML page → `__NEXT_DATA__` → `props.pageProps.design`.** Requires a
  browser-like UA to clear Cloudflare, which has ToS implications.
- **Licence gate:** allowlist `{CC0, BY, BY-SA, BY-ND}` from `design.license`, fail closed on
  anything else, check `allowReCreation`/`premission[1]` separately for derivative rights, and always
  show the user the raw licence string, the deed link and the description text rather than asserting
  a legal conclusion.
- **Never** batch, queue, schedule, or background these fetches. One URL, one user action, one request.

---

## Sources

- [MakerWorld robots.txt](https://makerworld.com/en/robots.txt) — fetched 2026-08-11
- [MakerWorld Terms of Use](https://makerworld.com/en/user-agreement) — fetched 2026-08-11
- Live HTTP observations against `makerworld.com/en/models/1029890-flexi-funny-octopus`,
  `…/12703-bambu-bed-scraper` and four other model pages, and against
  `api.bambulab.com/v1/design-service/design/{1029890,12703,999999999}` — 2026-08-11
- MakerWorld client bundle `https://makerworld.com/_next/static/chunks/pages/_app-4f54046e4479629e.js`
  (module 78412 — the licence table)
- [Doridian/OpenBambuAPI — cloud-makerworld.md](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-makerworld.md)
- [Doridian/OpenBambuAPI — cloud-http.md](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md)
- [Bambuddy wiki — MakerWorld integration](https://wiki.bambuddy.cool/features/makerworld/)
