import type { Marketplace } from '../types.js'
import { EtsyTagSchema } from '../types.js'
import { isComparable, MIN_COMPARABLE } from './relevance.js'
import { normaliseTag, phrasesFromTitle } from './text.js'
import type {
  CompetitorListing,
  KeywordCandidate,
  KeywordEvidence,
  KeywordSource,
  SearchResult,
} from './types.js'
// Re-exported, not moved out of reach: the miner stays the address for phrase
// handling; `text.js` exists to break an import cycle, not to become a second
// module every caller has to know about.
export { normaliseTag, phrasesFromTitle } from './text.js'

/**
 * Turns competitor listings into ranked keyword candidates.
 *
 * Everything here is pure: same input, same output, no clock and no network.
 * That is deliberate — the counting is mechanical, so it belongs in code that
 * can be tested against a saved search response rather than in a model that
 * has to be asked twice to see whether it agrees with itself.
 */

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * How a phrase with no measured demand is scored: as if it carried about
 * 22 views/day, i.e. mid-pack. Not zero — an unmeasured phrase has not been
 * shown to be bad, only left unexamined.
 */
const DEMAND_NEUTRAL = 1.5

/**
 * How a phrase with no measured competition is scored: as if moderately
 * crowded (~900 competing listings).
 *
 * Set well above the best case on purpose. If "unknown" scored as
 * "uncontested", never measuring a phrase would be the winning move and the
 * second search round would make results worse. Measuring a phrase and finding
 * it uncrowded is what earns the boost.
 */
const COMPETITION_NEUTRAL = 2.25

/**
 * How a phrase is scored when the marketplace *does* report views, but this
 * phrase had too few listings behind it to form a rate.
 *
 * Pointedly not the neutral value. On a marketplace with no view data at all —
 * eBay — "unknown" is a property of the API, and neutral is fair. Here it is a
 * property of the phrase: almost nothing carries it, so nothing can be
 * measured. Scoring that as mid-pack repeats the mistake already fixed for
 * competition, where not measuring beat measuring.
 *
 * A live run showed what it costs. Searching "dart" also matches t-shirts about
 * an American footballer named Jaxson Dart, and "cam skattebo", "graphic tee"
 * and "vintage 90s" — two listings each, out of 302 — landed in the top ten
 * purely on the neutral default.
 */
const DEMAND_THIN = 1.0

function demandTerm(demandPerDay: number | null, viewsReported: boolean): number {
  if (demandPerDay === null) return viewsReported ? DEMAND_THIN : DEMAND_NEUTRAL
  // Logarithmic: view counts are long-tailed, and on a linear scale a single
  // viral listing would outweigh every other signal in the sample. The +10
  // keeps zero views as a poor score rather than an annihilating one — Etsy
  // tabulates views once a day, so a real listing can legitimately read 0.
  return Math.log10(10 + demandPerDay)
}

/**
 * How an *unmeasured single word* is scored: as if roughly 100,000 listings
 * competed for it.
 *
 * Measured against the live API, a one-word query really is that crowded —
 * "3d printed" returned 1.2 million matches where "dart holder" returned 1,611.
 * And single words are never seeded, so they never acquire a real figure and
 * would otherwise keep the moderate default. That default flatters them twice
 * over: a one-word phrase also has the highest possible ranker share, because
 * it is contained in every longer phrase built on it.
 *
 * Without this, the top of every result list is "dart", "holder", "gift" —
 * words that describe the market rather than a way into it.
 */
const COMPETITION_NEUTRAL_HEAD = 6.25

function competitionTerm(competition: number | null, words: number): number {
  if (competition === null) return words <= 1 ? COMPETITION_NEUTRAL_HEAD : COMPETITION_NEUTRAL
  // Squared, and that is the load-bearing part. With a plain logarithm on both
  // sides, crowding is damped so much more gently than demand that a saturated
  // head term outranks an uncrowded long-tail one — which inverts the entire
  // point of the score. Squaring makes competition the dominant term, so a
  // phrase with ten times the traffic and two hundred times the competition
  // loses, as it should for a shop with no sales history.
  return Math.log10(100 + competition) ** 2 / 4
}

/**
 * Opportunity, not popularity.
 *
 * A shop with no sales history never wins "3d printed dragon"; it wins
 * "articulated dragon desk toy". So traffic is divided by crowding, and the
 * result deliberately ranks a medium-demand, low-competition phrase above a
 * high-demand, saturated one.
 */
export function scoreCandidate(
  c: Pick<KeywordCandidate, 'phrase' | 'rankerShare' | 'demandPerDay' | 'competition'>,
  /** Whether this marketplace reports view counts at all. Etsy does; eBay does not. */
  viewsReported = false,
): number {
  // Floor at 0.25 so a phrase only one ranked listing uses still competes on
  // its demand and competition rather than being zeroed out by consensus alone.
  const consensus = 0.25 + 0.75 * c.rankerShare
  const words = c.phrase.split(' ').filter(Boolean).length
  return (consensus * demandTerm(c.demandPerDay, viewsReported)) / competitionTerm(c.competition, words)
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile. `values` need not be sorted. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!
}

function median(values: number[]): number | null {
  return percentile(values, 50)
}

/**
 * Views per day, or null when the listing cannot support the figure.
 *
 * Listings younger than a week are excluded rather than divided: Etsy tabulates
 * views once a day, so a two-day-old listing reading 0 says nothing about the
 * phrase, while a two-day-old listing reading 40 implies 20/day, which is a
 * rate no established listing could match. Both directions are noise.
 */
const MIN_DAYS_FOR_RATE = 7

function viewsPerDay(listing: CompetitorListing): number | null {
  if (listing.views === null || listing.daysListed === null) return null
  if (listing.daysListed < MIN_DAYS_FOR_RATE) return null
  return listing.views / listing.daysListed
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

/**
 * Below this, a phrase is one seller's habit rather than a market signal.
 * Two independent listings is the cheapest evidence that it is not a fluke.
 */
/**
 * Fewest listings that make a phrase a market signal rather than one seller's
 * habit: two, or 2% of the sample, whichever is larger.
 *
 * The scaling is the point. Two listings out of fifty is a pattern; two out of
 * three hundred is a coincidence. A fixed floor gets *worse* as the sample
 * grows, because a wider search returns more unrelated products, not fewer.
 */
function minRankers(sampleSize: number): number {
  return Math.max(2, Math.ceil(sampleSize * 0.02))
}

/**
 * Fewest view rates that can form a median.
 *
 * With one or two, the "median" is that listing. A live run surfaced a phrase
 * used by 1% of rankers claiming 28.8 views/day — one lucky listing, presented
 * with the same authority as a figure drawn from forty. Below this the demand
 * is reported as unknown, which is what it is.
 */
const MIN_RATE_SAMPLE = 3

export interface MineArgs {
  marketplace: Marketplace
  language: 'de' | 'en'
  results: SearchResult[]
  generatedAt: string
  maxCandidates?: number
  /**
   * The item's own vocabulary, from `relevance.ts`.
   *
   * Omitted, nothing is filtered — mining a sample is a separate question from
   * whether the sample belongs to the item, and the tests for the former say
   * nothing about the latter.
   */
  anchors?: string[]
  /** Carried through to the evidence so limits stay visible to the user. */
  notes?: string[]
}

/**
 * Whether a phrase can be used verbatim in the marketplace's keyword field.
 *
 * Etsy has a real tag field with real rules, and those rules live in
 * `types.ts` — checking them here through the same schema means a phrase that
 * passes mining cannot fail validation later. eBay has no tag field at all, so
 * the question becomes whether the phrase fits a title without consuming it.
 */
function isUsable(phrase: string, marketplace: Marketplace): boolean {
  if (marketplace === 'etsy') return EtsyTagSchema.safeParse(phrase).success
  // eBay titles cap at 80 characters; half the title for one phrase is already
  // more than a keyword and closer to the whole title.
  return phrase.length <= 40
}

export function mine(args: MineArgs): KeywordEvidence {
  const { marketplace, results } = args
  const listings = results.flatMap((r) => r.listings)

  // Competition is only known for phrases we actually searched, because
  // `totalMatches` is a property of a query and not of a phrase. The second
  // research round exists to turn the strongest candidates into queries so
  // this map covers them.
  const competitionByQuery = new Map<string, number>()
  for (const result of results) {
    if (result.totalMatches === null) continue
    const key = normaliseTag(result.query)
    if (key) competitionByQuery.set(key, result.totalMatches)
  }

  // Deduplicate by listing id first: the same listing ranks for several queries
  // and would otherwise vote once per query it appears in.
  const unique = new Map<string, CompetitorListing>()
  for (const listing of listings) unique.set(listing.id, listing)

  // Digital downloads are excluded outright, not merely down-weighted. A seller
  // shipping a printed object does not compete with an STL file: the price is a
  // different order of magnitude, the buyer owns a printer, and the winning
  // keywords ("stl bundle", "digital download") are ones this seller must not
  // use. Leaving them in produced a "market" spanning EUR 0.56 to EUR 744.94.
  const deduped = [...unique.values()]
  const physical = deduped.filter((l) => l.kind !== 'digital')
  const droppedDigital = deduped.length - physical.length

  // The same move as the digital filter, one step further out: a listing that
  // sells something else entirely is not competition either. This one is not
  // hypothetical — an Etsy search for the German seed "dart halter" answered
  // with halter-neck dress patterns, because "dart" is the English sewing term
  // for a fitted seam. Note the order: the digital filter had already removed
  // the sewing patterns (PDFs) and *kept* the dresses, so the surviving noise
  // was the noise with nothing at all to do with darts.
  const anchors = args.anchors ?? []
  const sample = anchors.length ? physical.filter((l) => isComparable(l, anchors)) : physical
  const droppedOffTopic = physical.length - sample.length

  interface Bucket {
    rankers: Set<string>
    sources: Set<KeywordSource>
    rates: number[]
  }
  const buckets = new Map<string, Bucket>()

  const bucketFor = (phrase: string): Bucket => {
    let bucket = buckets.get(phrase)
    if (!bucket) {
      bucket = { rankers: new Set(), sources: new Set(), rates: [] }
      buckets.set(phrase, bucket)
    }
    return bucket
  }

  for (const listing of sample) {
    const rate = viewsPerDay(listing)
    // Per listing, per phrase, once — a title repeating a word must not count
    // as two listings agreeing on it.
    const seen = new Map<string, KeywordSource>()

    for (const tag of listing.tags) {
      const phrase = normaliseTag(tag)
      if (phrase) seen.set(phrase, 'tag')
    }
    for (const phrase of phrasesFromTitle(listing.title)) {
      // A phrase found in both is a tag: the seller chose it deliberately there,
      // whereas a title match may be incidental.
      if (!seen.has(phrase)) seen.set(phrase, 'title')
    }

    for (const [phrase, source] of seen) {
      const bucket = bucketFor(phrase)
      bucket.rankers.add(listing.id)
      bucket.sources.add(source)
      if (rate !== null) bucket.rates.push(rate)
    }
  }

  const sampleSize = sample.length
  const threshold = minRankers(sampleSize)
  // Etsy returns view counts; eBay has no equivalent. Which of the two we are
  // looking at decides whether a missing demand figure is the API's silence or
  // the phrase's thinness.
  const viewsReported = sample.some((l) => l.views !== null)
  const candidates: KeywordCandidate[] = []

  for (const [phrase, bucket] of buckets) {
    const rankerCount = bucket.rankers.size
    if (rankerCount < threshold) continue

    const rankerShare = sampleSize ? rankerCount / sampleSize : 0
    const competition = competitionByQuery.get(phrase) ?? null
    const demandPerDay = bucket.rates.length >= MIN_RATE_SAMPLE ? median(bucket.rates) : null

    candidates.push({
      phrase,
      rankerCount,
      rankerShare,
      sources: [...bucket.sources].sort(),
      competition,
      demandPerDay,
      score: scoreCandidate({ phrase, rankerShare, competition, demandPerDay }, viewsReported),
      usableAsTag: isUsable(phrase, marketplace),
    })
  }

  // Ties broken by ranker count so the order is stable across runs; a Map's
  // insertion order would otherwise leak the sample's arrival order into it.
  candidates.sort((a, b) => b.score - a.score || b.rankerCount - a.rankerCount || a.phrase.localeCompare(b.phrase))

  const notes = [...(args.notes ?? [])]
  if (droppedDigital) {
    notes.push(
      `Excluded ${droppedDigital} digital download listing(s) of ${deduped.length} — they sell files, not printed objects.`,
    )
  }
  if (droppedOffTopic) {
    notes.push(
      `Excluded ${droppedOffTopic} listing(s) of ${physical.length} sharing no word with this item — ` +
        'a search term can mean something else entirely in the market it is searched in.',
    )
  }
  const limit = args.maxCandidates ?? 60
  if (candidates.length > limit) {
    notes.push(`${candidates.length} candidates found; keeping the top ${limit} by score.`)
  }

  const prices = sample.map((l) => l.priceEur).filter((p): p is number => p !== null)

  return {
    marketplace,
    language: args.language,
    generatedAt: args.generatedAt,
    queries: results.map((r) => r.query),
    sampleSize,
    relevance: {
      anchors,
      sampled: deduped.length,
      kept: sampleSize,
      sufficient: sampleSize >= MIN_COMPARABLE,
    },
    candidates: candidates.slice(0, limit),
    categoryCandidates: rankCategories(sample),
    // Four is the fewest that can produce quartiles meaning anything at all.
    // Below it the band would be two numbers wearing a statistic's clothes.
    priceBandEur:
      prices.length >= 4
        ? {
            count: prices.length,
            min: Math.min(...prices),
            p25: percentile(prices, 25)!,
            median: percentile(prices, 50)!,
            p75: percentile(prices, 75)!,
            max: Math.max(...prices),
          }
        : null,
    aspectFacets: mergeFacets(results),
    notes,
  }
}

/**
 * The categories of the comparable sample, most-used first.
 *
 * A ranking rather than a winner. The mode alone answered "which category?"
 * with the same confidence whether it held 80 % of the sample or 17 %, and
 * 17 % is what the first real run produced — five categories in a near-even
 * split, presented as a consensus.
 *
 * Names come from the listings that carry them: eBay states the name next to
 * the id, Etsy states nothing and gets its names resolved afterwards. Where a
 * category appears under several spellings, the most frequent one wins, so a
 * single odd response cannot rename a category.
 */
export function rankCategories(
  listings: { categoryId: string | null; categoryName: string | null }[],
  max = 5,
): { id: string; name: string | null; count: number; share: number }[] {
  const counts = new Map<string, number>()
  const names = new Map<string, Map<string, number>>()

  let total = 0
  for (const listing of listings) {
    if (!listing.categoryId) continue
    total++
    counts.set(listing.categoryId, (counts.get(listing.categoryId) ?? 0) + 1)
    if (!listing.categoryName) continue
    const seen = names.get(listing.categoryId) ?? new Map<string, number>()
    seen.set(listing.categoryName, (seen.get(listing.categoryName) ?? 0) + 1)
    names.set(listing.categoryId, seen)
  }
  if (!total) return []

  const commonest = (id: string): string | null => {
    let best: [string, number] | undefined
    for (const entry of names.get(id) ?? []) {
      if (!best || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry
    }
    return best ? best[0] : null
  }

  return [...counts]
    // Ties broken by id so the order is stable across runs rather than
    // inherited from the arrival order of the search results.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([id, count]) => ({ id, name: commonest(id), count, share: count / total }))
}

/** Sums facet counts across searches; the same aspect appears in several. */
function mergeFacets(results: SearchResult[]): KeywordEvidence['aspectFacets'] {
  const merged = new Map<string, { name: string; value: string; count: number }>()
  for (const result of results) {
    for (const facet of result.aspectFacets) {
      const key = `${facet.name} ${facet.value}`
      const existing = merged.get(key)
      if (existing) existing.count += facet.count
      else merged.set(key, { ...facet })
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
