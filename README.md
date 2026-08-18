# 3d-print-lister

Turn a model page (MakerWorld, Cults3D or Printables) into eBay and Etsy
listings, with Claude writing the copy.

```bash
lister create --url https://makerworld.com/en/models/1029890-flexi-octopus \
              --from-html ./saved-page.html \
              --price 24.90 --material PETG --colour Petrol \
              --dimensions 220x60x30 --weight 120

# Cults3D and Printables are read through their APIs — no saved page needed:
lister create --url https://cults3d.com/en/3d-model/gadget/flexi-turtle \
              --price 24.90 --material PETG

lister publish mw-1029890-a1b2c3 --marketplace etsy --draft
```

---

## What it does

1. Reads a model page — title, description, images, designer, licence.
   MakerWorld is parsed from a browser-saved page (Cloudflare); Cults3D
   (API key required, see `.env.example`) and Printables come through their
   GraphQL APIs.
2. **Checks the licence** and decides whether the designer's images and text may be reused.
3. Asks Claude for marketplace-native copy — German for both, written natively
   for each rather than translated (the shop ships within Germany only; see
   "Language and market" below).
4. Validates that copy against each marketplace's rules *before* sending it.
5. Creates drafts, and publishes only when you say so.

Nothing goes live without an explicit confirmation. Both marketplaces charge real
money at the final step, so `create` never publishes and `publish` always asks.

---

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
npm run build
```

You need three sets of credentials. `.env.example` lists them all.

### Anthropic

An API key from <https://console.anthropic.com>. The tool uses `claude-opus-5`.

### Etsy

Register at <https://www.etsy.com/developers/register>. For listing to your own
shop a **Seller App** is enough and is approved automatically within minutes.

Two credentials, used in two different places — this is the single most common
source of 403s:

| Where | Value |
|---|---|
| `x-api-key` header, every API call | `keystring:shared_secret` (colon-joined) |
| `client_id`, the OAuth flow | the bare keystring |

Register `http://localhost:3456/callback` as a redirect URI on the app, then:

```bash
lister auth etsy
```

### eBay

Create a keyset at <https://developer.ebay.com/my/keys> — you get separate
Sandbox and Production keysets, and they are not interchangeable.

**eBay's redirect is a RuName, not a URL.** Create one under your keyset
("User Tokens" → "Get a Token from eBay via Your Application"). The real HTTPS
callback URL is configured behind it.

**eBay will not register a `localhost` callback**, so a desktop CLI cannot catch
the redirect. `lister auth ebay` therefore opens the consent page and asks you to
paste the URL you land on. The authorization code inside it expires after about
five minutes, so paste promptly.

```bash
lister auth ebay
```

Before publishing, your eBay account also needs:

- **Business policies** — a fulfillment (shipping), payment and return policy for
  your marketplace. The tool reads these; it will not invent shipping terms or a
  returns policy for you. Create them in eBay's seller settings.
- **Marketplace account deletion notifications** — every eBay developer
  application must either subscribe to these or explicitly opt out. Production
  keysets get disabled until this is settled.

Start on `EBAY_ENV=sandbox`.

---

## Getting the MakerWorld page

MakerWorld sits behind Cloudflare and refuses non-browser requests. A direct
fetch returns **403 with a challenge page** — this was verified, and it is the
normal outcome rather than a bug. `lister create --url …` will try, and tell you
so when it fails.

The dependable route is to let your browser do the fetching:

1. Open the model page in your browser.
2. Save it — Ctrl+S, "Webpage, HTML only" is enough.
3. `lister create --url <the model url> --from-html <the saved file>`

The tool then only parses a local file, so no automated request ever reaches
MakerWorld. That also sidesteps the automated-access restriction in MakerWorld's
Terms of Use, which its permissive `robots.txt` does not override.

---

## The licence gate

MakerWorld records a licence per model, and it decides two separate things:

- May you sell prints of this model?
- May you reuse the designer's renders and description in your listing?

The tool maps MakerWorld's own vocabulary — the values are bare, `BY-NC` rather
than `CC BY-NC`:

| Licence | Sell prints? | Reuse the designer's media? |
|---|---|---|
| `CC0`, `BY`, `BY-SA`, `BY-ND` | yes | yes, with attribution (except CC0) |
| `BY-NC`, `BY-NC-SA`, `BY-NC-ND` | **no** | **no** |
| `Standard Digital File License` (and its variants) | **no** | **no** |
| `MakerWorld Exclusive License` | **no** | **no** |
| anything unrecognised | treated as **no** | treated as **no** |

A licence that **forbids** the sale (SDFL, the NC variants) is a hard stop:
`create` refuses, preflight blocks, and `publish` refuses even with
`--skip-preflight`. An **unrecognised** licence routes to a confirmation
instead — that is the case where you may know more than the page does. When
media reuse is blocked, the tool asks for your own photos rather than quietly
proceeding.

If you hold a commercial licence the page does not reflect — bought separately,
or because it is your own model — `--i-have-commercial-rights` overrides the
gate, and still asks for confirmation.

**This is a routing aid, not legal advice.** It reads a field on a web page.

### Language and market

**Both marketplaces are German-language.** The shop ships within Germany only:
packaging-law (VerpackG) registration and EPR duties are per country, so copy
written for an international audience would attract exactly the orders that
cannot be fulfilled. Etsy copy used to be English and switched on 2026-08-18.

Consequences worth knowing:

- Keyword research runs in German on both marketplaces, and Etsy research is
  restricted to shops delivering to DE (`etsyBuyerCountry`). The Etsy sample is
  smaller than the English one would be — that is the market you actually sell
  into, not a worse measurement.
- German compounds are long and Etsy tags are capped at 20 characters, so the
  two-word form usually wins ("moosstab pflanzen", not
  "zimmerpflanzenmoosstab").
- `taxonomyHint` stays English: it is matched against Etsy's own category tree.
- Listings created before the switch keep their English Etsy copy. Regenerate
  with `lister keywords <id> -M etsy --rewrite`, then accept the proposal.

To sell internationally again, three places change together: `ETSY_LANGUAGE` in
`src/ai/composer.ts`, the research language in `src/seo/research.ts`, and the
`etsyBuyerCountry` default in `src/settings.ts`.

### The Etsy authorship gate

Etsy asks a question no licence can answer: since 10 June 2025 its Creativity
Standards require items "produced based on a seller's original design". A
commercial licence only says the *designer* permits the sale — Etsy asks who
designed it. So Etsy is **default-deny** for third-party models: without
`--own-design` the listing gets no Etsy channel at all.

There is one deliberate way through: `--i-accept-etsy-design-risk` (or the
switch under "Herkunft und Rechte" on the listing page) records that **you**
carry that platform risk for **this** listing. The decision is stored with
timestamp and source URL — so it is provable later on what basis the listing
went live — it survives revises, asks for confirmation, and shows up on the
draft as an assertion rather than a verified condition. It unlocks nothing but
this one gate: the licence rules, the media rules and every money check stay.

**Etsy images have no override.** Etsy requires your own original material of
the finished product — designer renders and generated product images never
qualify, whatever the licence says (editing your own photos is fine).
Source-platform downloads are excluded from Etsy uploads and a listing without
at least one own photo is blocked.

---

## Images

The two marketplaces want images in opposite forms, which is worth knowing before
you shoot photos:

- **Etsy** takes the actual files. `--image photo.jpg`
- **eBay** takes public **HTTPS URLs** and fetches them itself. It cannot see a
  local file. `--image-url https://…/photo.jpg`

If the licence permits reuse, MakerWorld's own CDN URLs satisfy **eBay**
directly. **Etsy never gets downloaded source images** — it requires your own
photos of the finished product, so staged downloads are excluded from Etsy
uploads (see "The Etsy authorship gate"). If you use your own photos, they need
to be hosted somewhere before eBay will accept them.

---

## Commands

| Command | What it does |
|---|---|
| `lister auth ebay\|etsy` | Connect an account |
| `lister whoami` | Show what is connected and when tokens expire |
| `lister create` | Build a draft from a model page |
| `lister show <id>` | Read the generated copy |
| `lister list` | All drafts and their status |
| `lister publish <id>` | Send to the marketplaces |
| `lister revise <id>` | Push edited copy to listings that are already live |
| `lister delete <id>` | Remove a local draft |

`publish` takes `--draft` to create the remote draft and stop before anything is
charged, and `--marketplace ebay|etsy` to do one at a time.

Once a listing is live, edits are pushed with `revise` (or `publish`, which
notices and does the same): eBay is updated in place so the item ID, watchers
and sales history survive — never end-and-relist — and Etsy gets its four text
fields (title, description, tags, materials) rewritten. Price and quantity are
not revised. Revising costs nothing on either marketplace.

**In the eBay sandbox you must pass `--category-id <id>`.** eBay's category
suggestion endpoint is unsupported there, and it does not fail — it returns a
*successful* response full of random boilerplate category names. Trusting it
would publish under an arbitrary category, so the tool refuses to guess in
sandbox and asks for the id instead.

---

## Costs

- **Etsy** charges a listing fee (about €0.20) **when a listing is activated**,
  not when the draft is created. `--draft` is free. Auto-renew is off by default,
  because each renewal is another fee.
- **eBay** fees depend on your account and category.

The final publish call is never retried automatically — a retried publish can
create a duplicate listing, and duplicates cost money.

---

## Development

```bash
npm test          # 293 tests, no network
npm run typecheck
npm run dev -- list
```

The tests pin the things that fail at publish time rather than at compile time:
Etsy's undocumented character rules (only one `&` per title; no hyphens in
materials), MakerWorld's bare licence vocabulary, and the page parser.

`docs/research/` holds the API research this was built from, including the
verified request shapes for both marketplaces.

---

## EU product safety (GPSR) and VAT

**If you print the item and sell it under your own name, GPSR (EU 2023/988
Art. 3) makes you the manufacturer.** Because you are established in the EU you
are also your own responsible economic operator — so eBay wants your name and
address in `regulatory.manufacturer`, and the `responsiblePersons` array stays
empty. That array is for manufacturers based *outside* the EU, and the tool
deliberately never sends it.

Fill in the `SELLER_*` fields in `.env`. eBay requires this block only for
certain categories, so the tool asks eBay which apply and refuses to publish
into a category that needs data you have not provided.

Being the manufacturer also carries duties **outside** any API — risk analysis,
technical documentation, and your name and address on the product or its
packaging. This tool cannot help with those.

**VAT.** Pass `--vat 19` only if you are a business seller with a VAT ID
registered at eBay; `vatPercentage` is invoice metadata and the price you send
stays gross. Under the Kleinunternehmerregelung (§19 UStG) the correct encoding
is to send no tax block at all, which is what happens when you omit `--vat`.
There is no field that expresses VAT exemption — and eBay's neighbouring
`applyTax` flag is a US sales-tax switch, not a VAT one, so the tool never sends
it. **This is not tax advice.**

---

## Known gaps

- **Etsy has no GPSR API surface at all.** eBay exposes the fields; Etsy does
  not, so any EU compliance data for an Etsy listing has to be entered in Shop
  Manager by hand.
- **Packaging register (LUCID / VerpackG)** is an account setting on both
  platforms. eBay's `extendedProducerResponsibility` fields look like the right
  place and are explicitly marked "DO NOT USE" in its own docs, so the tool
  leaves them alone.
- **Colour variations, both marketplaces.** One line per colour in the editor
  (`SKU; Farbe; Preis; Menge`) publishes ONE listing with a colour dropdown —
  own SKU, price and quantity per colour. On eBay via the inventory item group
  (sales pooled on a single item ID; per-colour photos supported; not every
  category allows it — the taxonomy's `aspectEnabledForVariations` decides and
  the tool checks; a live listing cannot switch shape). On Etsy via the
  inventory endpoint (custom property "Farbe"; shape may change freely, and
  the variations ride along on both draft creation and revise).
- **Custom SKUs.** `--sku` on create, or the SKU field in the editor; empty
  falls back to the local id. eBay charset: letters, digits, `.` `_` `-`, max
  50 characters.
- eBay item specifics come from Claude and are checked against the category's
  required aspects, but a mismatch surfaces as a publish rejection rather than
  being auto-corrected.
