import { z } from 'zod'
// From `marketplace.js`, not `types.js`: the listing record in `types.js`
// embeds this evidence, so importing it back would close a cycle.
import { MarketplaceSchema } from '../marketplace.js'

/**
 * The shapes keyword research passes around.
 *
 * Both marketplaces are reduced to one `CompetitorListing` form so the mining
 * and scoring in `mine.ts` runs once rather than twice. What differs between
 * them is which fields are *available*, not what they mean:
 *
 *   - Etsy exposes seller-set `tags`, and `views` per listing. eBay exposes
 *     neither, but does report aspect facets for a whole search.
 *   - eBay exposes item specifics buyers actually filter on. Etsy does not.
 *
 * Every field a marketplace cannot answer is `null`, never a zero or an empty
 * string. Scoring treats null as "unknown" and stays neutral; a zero would be
 * read as "measured, and it is nothing", which is a different claim.
 */

// ---------------------------------------------------------------------------
// Raw material: what a marketplace search gives back
// ---------------------------------------------------------------------------

export const CompetitorListingSchema = z.object({
  /** Marketplace-native id, kept as a string — it is an identifier. */
  id: z.string(),
  title: z.string(),
  /** Seller-set search tags. Etsy has them; eBay has no equivalent field. */
  tags: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  /** Null when the marketplace reports a currency we did not ask for. */
  priceEur: z.number().nonnegative().nullable().default(null),
  /**
   * Lifetime view count. Etsy tabulates this once a day and only for active
   * listings, so it lags and can be 0 for a listing that simply has not been
   * counted yet — which is why `daysListed` is carried alongside it rather
   * than folded in here.
   */
  views: z.number().int().nonnegative().nullable().default(null),
  favourites: z.number().int().nonnegative().nullable().default(null),
  /** Days since the listing was first created, for a per-day rate. */
  daysListed: z.number().nonnegative().nullable().default(null),
  /**
   * Whether the competitor ships an object or a file.
   *
   * Load-bearing, not descriptive. A live sample for "dart holder" ran from
   * EUR 0.56 to EUR 744.94 — the bottom end being STL downloads, which are a
   * different business at a different price with different keywords. Mixing
   * them in drags the median under what any printed object can be sold for and
   * recommends phrases like "stl bundle" to someone selling a physical print.
   */
  kind: z.enum(['physical', 'digital', 'both', 'unknown']).default('unknown'),
  /** Marketplace category id, as a string for the same reason as `id`. */
  categoryId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
})
export type CompetitorListing = z.infer<typeof CompetitorListingSchema>

/**
 * A facet the marketplace itself reports for a search: "of the items matching
 * this query, 412 have Material=PLA".
 *
 * This is strictly better than inferring item specifics from titles, because it
 * is the marketplace's own index rather than our guess at it. Only eBay's
 * Browse API offers it.
 */
export const AspectFacetSchema = z.object({
  name: z.string(),
  value: z.string(),
  count: z.number().int().nonnegative(),
})
export type AspectFacet = z.infer<typeof AspectFacetSchema>

export const SearchResultSchema = z.object({
  query: z.string(),
  /**
   * Total active listings matching the query — the competition figure.
   *
   * Null means the marketplace did not tell us, not that there is no
   * competition. eBay reports it; Etsy reports it as `count`.
   */
  totalMatches: z.number().int().nonnegative().nullable().default(null),
  listings: z.array(CompetitorListingSchema).default([]),
  aspectFacets: z.array(AspectFacetSchema).default([]),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

// ---------------------------------------------------------------------------
// Mined output: what the copywriter is handed
// ---------------------------------------------------------------------------

export const KeywordSourceSchema = z.enum(['tag', 'title'])
export type KeywordSource = z.infer<typeof KeywordSourceSchema>

export const KeywordCandidateSchema = z.object({
  phrase: z.string().min(1),
  /** How many sampled top-ranked listings use it. */
  rankerCount: z.number().int().nonnegative(),
  /** That count as a share of the sample, 0..1. The consensus signal. */
  rankerShare: z.number().min(0).max(1),
  /** Whether it came from explicit tags, from title text, or both. */
  sources: z.array(KeywordSourceSchema),
  /** Active listings competing for the phrase. Null when not measured. */
  competition: z.number().int().nonnegative().nullable(),
  /** Median views per day across ranked listings carrying it. Null on eBay. */
  demandPerDay: z.number().nonnegative().nullable(),
  /** See `scoreCandidate` in mine.ts. Higher is a better bet, not more traffic. */
  score: z.number(),
  /** Passes the marketplace's own field rules, so it can be used verbatim. */
  usableAsTag: z.boolean(),
})
export type KeywordCandidate = z.infer<typeof KeywordCandidateSchema>

/**
 * What competitors charge for the same kind of thing.
 *
 * Both the quartiles and the extremes are kept. The quartiles say where the
 * market actually sits; the extremes say how wide it is, and a market running
 * from 4 € to 90 € is telling you something a median alone hides — usually that
 * the sample mixes digital files with printed objects.
 *
 * `count` is carried because a band drawn from six listings and one drawn from
 * three hundred deserve different amounts of trust, and the number is the only
 * honest way to show which one this is.
 */
export const PriceBandSchema = z.object({
  count: z.number().int().nonnegative(),
  min: z.number(),
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  max: z.number(),
})
export type PriceBand = z.infer<typeof PriceBandSchema>

export const KeywordEvidenceSchema = z.object({
  marketplace: MarketplaceSchema,
  /**
   * Research is language-bound. Both marketplaces are German today (the shop
   * ships to Germany only); `en` stays in the enum because older records carry
   * it from when the Etsy copy was English.
   */
  language: z.enum(['de', 'en']),
  generatedAt: z.string(),
  /** The searches this was built from, so a result can be reproduced. */
  queries: z.array(z.string()),
  /** How many competitor listings were actually examined. */
  sampleSize: z.number().int().nonnegative(),
  candidates: z.array(KeywordCandidateSchema),
  /**
   * The category most top-ranked listings sit in.
   *
   * A measured answer to the question `categoryHint` currently guesses at.
   * `share` is how much of the sample agreed, so a weak consensus is visible
   * rather than presented as fact.
   */
  categoryConsensus: z
    .object({ id: z.string(), share: z.number().min(0).max(1) })
    .nullable()
    .default(null),
  priceBandEur: PriceBandSchema.nullable().default(null),
  aspectFacets: z.array(AspectFacetSchema).default([]),
  /**
   * Anything that limited the research: a truncated batch, a quota stop, a
   * marketplace that withheld a field.
   *
   * These are surfaced to the user verbatim. A silently shortened sample reads
   * exactly like a complete one, which is how a half-answer gets trusted.
   */
  notes: z.array(z.string()).default([]),
})
export type KeywordEvidence = z.infer<typeof KeywordEvidenceSchema>

/** Both marketplaces' evidence for one listing, as persisted on the record. */
export const SeoEvidenceSchema = z.object({
  ebay: KeywordEvidenceSchema.nullable().default(null),
  etsy: KeywordEvidenceSchema.nullable().default(null),
})
export type SeoEvidence = z.infer<typeof SeoEvidenceSchema>
