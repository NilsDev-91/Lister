import { normaliseTag, STOPWORDS } from './text.js'
import type { KeywordEvidence, CompetitorListing } from './types.js'
import type { ListingRecord } from '../types.js'

/**
 * Whether a sampled competitor sells the same kind of thing at all.
 *
 * The run that forced this module into existence: an Etsy search for the
 * German seed "dart halter" returned twelve listings, eleven of them
 * halter-neck dress patterns. **"Dart" is the English sewing term for a fitted
 * seam** — the search term means something else entirely in the market being
 * searched, and nothing in the pipeline noticed. The mined phrases from those
 * eleven ("sewing pattern", "sleeveless dress") then became round two's
 * queries, which pulled in a hundred more dresses, and the digital-download
 * filter removed the sewing patterns while keeping the dresses. The stored
 * "market" for a dart holder was 56 linen dresses at a median of EUR 59.54.
 *
 * Two defences, and the second one is the load-bearing one:
 *
 * 1. A competitor must share at least one word with the item being sold.
 *    This is a coarse net by design — see the limitation below.
 * 2. Below `MIN_COMPARABLE` comparable listings, the research states that it
 *    found nothing and withholds every conclusion. An empty niche is a real
 *    answer; a median over one listing is not.
 *
 * **Known limitation, deliberately accepted:** this matches words, not
 * meaning. "vintage sewing pattern / halter top / dart fitted" hits both
 * "dart" and "halter" and survives the filter. Tightening the net far enough
 * to catch it would also throw out genuine niche competitors, which is the
 * more expensive mistake — so the evidence floor, not the filter, is what
 * keeps a poisoned sample from becoming a recommendation. Same shape as the
 * image rule that recognises file names rather than picture content.
 */

/**
 * Fewest comparable listings a sample needs before it may carry a conclusion.
 *
 * Twelve is chosen against what the marketplace answers with, not from
 * statistics: the failing run had exactly one real competitor, and every
 * plausible tightening of the net still left that one. `mine()` already
 * refuses a demand median below three rates for the same reason, one level
 * further down — a figure drawn from a handful of listings is presented with
 * the same authority as one drawn from forty, and cannot earn it.
 */
export const MIN_COMPARABLE = 12

/** Shorter than this, a word is not distinctive enough to anchor anything. */
const MIN_ANCHOR_LENGTH = 3

/**
 * From this length an anchor may also match inside a longer word.
 *
 * German compounds make this necessary: "dart" has to find "Dartpfeil-Halter",
 * and "halter" has to find "Wandhalterung". Below four characters the same
 * rule would be a disaster — "pla", the material, is inside "display",
 * "place" and "plant" — so short anchors match whole words only.
 */
const MIN_COMPOUND_ANCHOR = 4

/**
 * The words that describe the item being sold.
 *
 * Taken from the source page, both marketplace titles and the material: the
 * vocabulary the item is actually described in. Not marketplace-specific on
 * purpose — an item is the same item on eBay and Etsy, and the wider
 * vocabulary makes the net gentler, which is the direction this filter should
 * err in.
 *
 * **The Etsy tags are deliberately left out, and that is the important line.**
 * Tags are where a rewrite puts the phrases the research just mined. Feeding
 * them back in as anchors closes a loop: research → tags → wider anchors →
 * broader sample → broader research. It was measured, not feared. A Benchy
 * rewrite adopted "desk decor" and "desk ornament"; the next run seeded on
 * those, admitted 171 of 285 listings as comparable, and recommended "decor
 * gift", "teacher gift" and "glasses holder" while the price band moved from
 * a median of EUR 4.09 to EUR 25.37. The same amplification the follow-up
 * gate stopped inside one run, one loop further out.
 *
 * A filter must not be fed by the thing it filters. Titles stay: the seller
 * and the model write those to describe the item, not to chase a ranking.
 */
export function anchorTerms(listing: ListingRecord): string[] {
  const texts = [
    listing.source.title,
    ...listing.source.tags,
    listing.copy.ebay.title,
    listing.copy.etsy.title,
    listing.product.material,
  ]

  const anchors = new Set<string>()
  for (const text of texts) {
    // normaliseTag rather than a private tokeniser: the anchors have to be
    // comparable to the tokens mined out of competitor titles, and there is
    // exactly one way to produce those.
    for (const token of normaliseTag(text).split(' ')) {
      if (!token || STOPWORDS.has(token)) continue
      if (token.length < MIN_ANCHOR_LENGTH && !/\d/.test(token)) continue
      anchors.add(token)
    }
  }
  return [...anchors].sort()
}

/**
 * The text-bearing fields, and nothing else.
 *
 * Narrower than `CompetitorListing` on purpose: it lets a bare mined phrase be
 * checked by the same rule as a whole listing, which is what keeps round two
 * from searching for something round one would have thrown away.
 */
type Describable = Pick<CompetitorListing, 'title' | 'tags' | 'materials'>

function tokensOf(listing: Describable): string[] {
  return normaliseTag([listing.title, ...listing.tags, ...listing.materials].join(' ')).split(' ')
}

/** How many distinct anchors a competitor listing mentions. */
export function anchorHits(listing: Describable, anchors: string[]): number {
  const tokens = tokensOf(listing)
  let hits = 0
  for (const anchor of anchors) {
    const found = tokens.some(
      (token) =>
        token === anchor ||
        (anchor.length >= MIN_COMPOUND_ANCHOR && (token.startsWith(anchor) || token.endsWith(anchor))),
    )
    if (found) hits++
  }
  return hits
}

/**
 * One shared word is enough.
 *
 * A single hit is a low bar and it is meant to be: the filter's job is to
 * remove listings with *nothing whatsoever* in common with the item, which is
 * what an ambiguous search term drags in. Sorting the survivors is the
 * scoring's job, and deciding whether there are enough of them is the floor's.
 */
export function isComparable(listing: Describable, anchors: string[]): boolean {
  // No vocabulary means no opinion — a filter that cannot be computed must not
  // silently empty the sample.
  if (!anchors.length) return true
  return anchorHits(listing, anchors) >= 1
}

/** The same rule applied to a bare phrase — see `followUpQueries`. */
export function phraseIsAnchored(phrase: string, anchors: string[]): boolean {
  return isComparable({ title: phrase, tags: [], materials: [] }, anchors)
}

/**
 * Strips the conclusions from evidence too thin to support them.
 *
 * Everything that describes the *attempt* survives — the queries, how much was
 * sampled, how little of it was comparable, the notes. That record is useful in
 * itself: "six searches, 113 hits, one of them comparable" says the niche is
 * empty in this language, which is something a seller wants to know. What goes
 * is everything that would be read as a finding: phrases to use, what
 * competitors charge, which category they sit in.
 *
 * Applied once, where research is produced, rather than at each of the six
 * places that read it — a consumer that forgets the check would show a median
 * over one listing as the market.
 */
export function withholdThinEvidence(evidence: KeywordEvidence): KeywordEvidence {
  if (evidence.relevance.sufficient) return evidence

  const { kept, sampled } = evidence.relevance
  const note =
    sampled === 0
      ? evidence.marketplace === 'ebay'
        ? 'No search returned a single listing — the Browse API needs a production keyset; sandbox credentials answer 403.'
        : 'No search returned a single listing.'
      : `Only ${kept} of ${sampled} sampled listing(s) sell anything comparable to this item — too thin for phrase recommendations, a price band or a category. Nothing was inferred from the rest.`

  return {
    ...evidence,
    candidates: [],
    categoryCandidates: [],
    priceBandEur: null,
    aspectFacets: [],
    notes: [...evidence.notes, note],
  }
}
