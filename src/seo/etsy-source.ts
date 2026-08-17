import {
  searchActiveListings,
  getPublicListings,
  getPublicListing,
  type PublicListing,
} from '../marketplaces/etsy/client.js'
import { CompetitorListingSchema, type CompetitorListing, type SearchResult } from './types.js'

/**
 * Etsy as a research source.
 *
 * Normally one call per query. The documented schema for
 * `findAllListingsActive` lists neither `views` nor `tags` nor
 * `original_creation_timestamp`, but the live API returns all three on every
 * result — verified 2026-08-13, 25 of 25. The detail lookup below is therefore
 * a fallback, not the normal path; taking the documentation at its word would
 * double the call count for nothing.
 *
 * None of this needs OAuth. Every endpoint used here declares no scope and runs
 * on the api key alone, which is what makes research possible before a shop
 * exists.
 */

const SECONDS_PER_DAY = 86_400

/**
 * Etsy money is an integer plus a divisor, not a float.
 *
 * `price` is in the *shop's own* currency — in a 25-result sample only two were
 * EUR, the rest USD, AUD, MAD and GBP. `converted_price` is what the
 * `currency=EUR` request parameter fills in, and it was present on all 25.
 * Reading `price` alone would throw away most of the sample and leave the price
 * band describing whichever handful of shops happen to price in euros.
 */
function toEur(listing: PublicListing): number | null {
  const money =
    listing.converted_price?.currency_code === 'EUR' ? listing.converted_price : listing.price
  if (!money || money.currency_code !== 'EUR' || !money.divisor) return null
  const value = money.amount / money.divisor
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** Etsy says `download`; the rest of this codebase says `digital`. */
function toKind(listingType: string | null | undefined): 'physical' | 'digital' | 'both' | 'unknown' {
  switch (listingType) {
    case 'physical':
      return 'physical'
    case 'download':
      return 'digital'
    case 'both':
      return 'both'
    default:
      return 'unknown'
  }
}

function daysSince(timestampSeconds: number | null | undefined, nowMs: number): number | null {
  if (!timestampSeconds) return null
  const days = (nowMs / 1000 - timestampSeconds) / SECONDS_PER_DAY
  return Number.isFinite(days) && days >= 0 ? days : null
}

export function toCompetitorListing(listing: PublicListing, nowMs: number): CompetitorListing {
  return CompetitorListingSchema.parse({
    id: String(listing.listing_id),
    title: listing.title ?? '',
    tags: listing.tags ?? [],
    materials: listing.materials ?? [],
    priceEur: toEur(listing),
    views: typeof listing.views === 'number' ? listing.views : null,
    favourites: typeof listing.num_favorers === 'number' ? listing.num_favorers : null,
    daysListed: daysSince(listing.original_creation_timestamp ?? listing.creation_timestamp, nowMs),
    kind: toKind(listing.listing_type),
    categoryId: listing.taxonomy_id != null ? String(listing.taxonomy_id) : null,
    url: listing.url ?? null,
  })
}

/**
 * How many listings we will spend a single-listing call on when the batch
 * endpoint turns out not to carry `views`.
 *
 * A cap rather than the whole sample: the top of a Best Match ranking is where
 * the signal is, and the tail is not worth one request each.
 */
const DETAIL_FALLBACK_LIMIT = 12

export interface EtsySearchArgs {
  query: string
  limit?: number
  taxonomyId?: number | undefined
  buyerCountry?: string | undefined
  nowMs: number
  notes: string[]
}

export async function searchEtsy(args: EtsySearchArgs): Promise<SearchResult> {
  const { count, results } = await searchActiveListings({
    keywords: args.query,
    limit: args.limit ?? 50,
    sortOnScore: true,
    taxonomyId: args.taxonomyId,
    buyerCountry: args.buyerCountry,
    currency: 'EUR',
  })

  const enriched = await withViews(results, args.query, args.notes)

  return {
    query: args.query,
    totalMatches: count,
    listings: enriched.map((l) => toCompetitorListing(l, args.nowMs)),
    aspectFacets: [],
  }
}

/**
 * Fills in `views` when a search response happens not to carry it.
 *
 * The live API does carry it, so this normally returns immediately without
 * spending a call. It stays because the published schema does not promise the
 * field: checking is one comparison, and assuming would mean a silent loss of
 * the only demand signal Etsy exposes if the response shape ever changes.
 */
async function withViews(
  results: PublicListing[],
  query: string,
  notes: string[],
): Promise<PublicListing[]> {
  if (!results.length) return results

  // The normal path: the search already answered.
  if (results.every((r) => typeof r.views === 'number')) return results

  const ids = results.map((r) => r.listing_id).filter((id): id is number => typeof id === 'number')
  if (!ids.length) return results

  let batch: PublicListing[] = []
  try {
    batch = await getPublicListings(ids.slice(0, 100))
  } catch {
    // A single missing id 404s the whole batch. That is a data problem, not a
    // reason to abandon the query — fall through to the per-listing path.
    notes.push(`Batch lookup failed for "${query}"; fell back to individual listing fetches.`)
  }

  const byId = new Map<number, PublicListing>()
  for (const listing of batch) byId.set(listing.listing_id, listing)

  // The batch and detail endpoints are called *without* the currency parameter,
  // so their `converted_price` is null — spreading the whole record over the
  // search result would null out the EUR price the search already delivered.
  // Only the fields this fallback exists to fetch are taken.
  const enrich = (base: PublicListing, extra: PublicListing | undefined): PublicListing => {
    if (!extra) return base
    return {
      ...base,
      views: extra.views ?? base.views,
      num_favorers: extra.num_favorers ?? base.num_favorers,
      tags: extra.tags ?? base.tags,
      materials: extra.materials ?? base.materials,
      original_creation_timestamp: extra.original_creation_timestamp ?? base.original_creation_timestamp,
      creation_timestamp: extra.creation_timestamp ?? base.creation_timestamp,
      listing_type: extra.listing_type ?? base.listing_type,
      taxonomy_id: extra.taxonomy_id ?? base.taxonomy_id,
    }
  }

  const batchHasViews = batch.some((l) => typeof l.views === 'number')
  if (batchHasViews) {
    return results.map((r) => enrich(r, byId.get(r.listing_id)))
  }

  notes.push(
    `Etsy's batch endpoint returned no view counts for "${query}"; ` +
      `fetched the top ${Math.min(DETAIL_FALLBACK_LIMIT, results.length)} of ${results.length} individually.`,
  )

  const merged = results.map((r) => enrich(r, byId.get(r.listing_id)))
  for (let i = 0; i < Math.min(DETAIL_FALLBACK_LIMIT, merged.length); i++) {
    const listing = merged[i]!
    try {
      merged[i] = enrich(listing, await getPublicListing(listing.listing_id))
    } catch {
      // One unreachable listing must not sink the whole query.
    }
  }
  return merged
}
