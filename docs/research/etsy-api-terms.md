# Etsy API Terms of Use — What They Mean for This Tool

**Researched:** 2026-08-17
**Primary source:** `https://www.etsy.com/legal/api` ("API-Nutzungsbedingungen"), read
in full in the German locale on 2026-08-17. Clause names below are translated back
from that rendering; the English original governs. Sections 6+ (termination,
liability, indemnity, arbitration) are standard boilerplate and are only summarised
where they bite.

This answers the open question from ARCHITECTURE.md: **is systematic analysis of
other sellers' public listings covered?** Short version: *own-listing management is
squarely the intended use; keyword research over competitor listings is a grey zone
with two clauses that can be read against it, and the mitigations that keep it
defensible are exactly the ones this tool now implements.*

---

## 1. What is clearly fine

- **Creating, updating and revising the seller's own listings** is the API's core
  purpose ("develop, build, share and run applications that integrate with the
  Etsy services"). The definition of "Application" explicitly covers a tool you
  use "in connection with your own Etsy shop(s)" — a single-user tool for the
  developer's own shop is in scope without making it available to anyone else.
- **Commercial use is allowed** ("Etsy provides the API so developers can build
  applications that can be used for commercial purposes"), subject to Etsy's
  discretion to prohibit uses it deems inappropriate.
- The developer-account registration asks whether the key is for **personal or
  commercial use**, and the **application purpose must be submitted to and
  approved by Etsy** before API access is granted. Whatever purpose was declared
  when the key was created is the envelope this tool must stay inside.

## 2. The two clauses that touch keyword research

From the "Prohibited conduct" list in §5, verbatim in meaning:

1. **No collection for analytics without written approval.** Using the API "to
   collect, scan or otherwise request Etsy content **for analytics**, machine
   learning, AI model training, licensing or content removal" is prohibited
   "unless Etsy has expressly approved it in writing".
2. **Minimum-data rule.** You may not "request more than the minimum amount of
   data from the Etsy API required to provide the desired application to Etsy
   sellers".

Also relevant: automated systems or browser extensions that "access, analyse or
scrape the Etsy website, the Etsy API or Etsy data" are prohibited **unless
expressly approved in writing** — the approved-application route *is* that
written approval for API access within the declared purpose, but it does not
stretch to scraping the website (which the MakerWorld-style save-page trick would
be if it were ever pointed at Etsy — don't).

**Reading:** clause 1 is aimed at data products — harvesting Etsy content to sell
analytics, train models, or build datasets. A seller tool that runs ~7 searches
to word *that seller's own listing* and stores only aggregates is a service to
the seller, not an analytics product; but the clause's text is broad enough that
a hostile reading could cover it. This stays a **grey zone** — it cannot be
declared "covered" from the terms alone.

## 3. What keeps this tool defensible (and must stay true)

- **Research is tied 1:1 to preparing the seller's own listing.** It runs on
  demand, per listing, never as a standing crawl. No scheduled sweeps, no niche
  monitoring, no dataset accumulation beyond the cache below.
- **Only aggregates are kept and shown.** Candidates are n-grams with counts,
  the price band is quartiles, category consensus is a share. The UI and CLI
  never display a competitor listing's content — which also means the 6-hour
  display-freshness rule (§5 "Display of data": listing content you *display*
  may be at most 6 h staler than on Etsy; other Etsy content 24 h) is not
  triggered at all. Keep it that way: **never add a feature that shows or
  exports competitor listings verbatim.**
- **The research cache (built 2026-08-17) cuts calls, which is what the
  minimum-data rule asks for.** Raw search results are cached 24 h so a repeat
  run costs zero calls. §5 also says cached Etsy content may be stored "no
  longer than reasonably necessary to provide the service to your application's
  users" — a 24 h TTL for making a repeat research run free is a reasonable
  necessity in that sense, and entries expire on their own. Do not raise the
  TTL to weeks "to be safe on quota"; that inverts the justification.
- **Volume is trivial.** ~7 calls per marketplace per listing against a
  10,000/day key. Nothing here approaches "unreasonable load" (§5) or the
  Enterprise tier (3M/day).

## 4. Practical obligations worth knowing

- **Rate limits are per key, one key per application,** and creating extra keys
  to widen the limit is expressly prohibited. Limit increases go through
  developer@etsy.com.
- **Inactive keys:** no successful call for 6 months → Etsy may suspend the key.
  (Relevant: this key sat unused between sessions.)
- **Etsy may change the API and these terms at any time**, with notice by email
  to the developer address for material changes. The 6 h/24 h freshness numbers
  and the analytics clause can move.
- **If the tool is ever given to other sellers** (not currently planned), a whole
  block of obligations activates: binding application terms + privacy policy, a
  monitored support email, the verbatim "not endorsed or certified by Etsy"
  disclaimer, the trademark notice, and 30 days' written notice before
  discontinuing. Single-user use for the own shop carries none of that.
- **Member content belongs to members.** Designer photos, titles and descriptions
  reached through the API are other people's IP; the tool's existing
  image-licence gates point the right way and must not be weakened for anything
  Etsy-sourced.

## 5. Recommendation

1. Keep research on-demand, aggregate-only, cache-backed — the current shape.
2. Check that the **declared application purpose** on the developer account
   honestly names listing management *and* keyword research for the seller's own
   listings. If it only says "listing management", update it before research
   becomes routine.
3. For belt-and-braces certainty (or before any feature that widens research),
   email developer@etsy.com and ask whether per-listing keyword research within
   the declared purpose needs separate written approval. Their answer is the
   only thing that turns the grey zone white.
