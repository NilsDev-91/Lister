import { searchItems } from '../marketplaces/ebay/browse.js'
import { CompetitorListingSchema, type SearchResult } from './types.js'

/**
 * eBay as a research source.
 *
 * Thinner than Etsy's, and the gaps are the interesting part:
 *
 *  - **No tags.** eBay has no seller-set keyword field, so every candidate here
 *    is mined from title text. Consensus among Best Match winners is the whole
 *    signal.
 *  - **No view counts.** Demand cannot be measured per listing, so scoring
 *    falls back to consensus over competition. That is why `demandPerDay` is
 *    nullable rather than defaulted to zero — absent is not the same as none.
 *  - **But aspect facets.** eBay reports how many matching items carry each
 *    item specific, which Etsy has no equivalent for and which is a better
 *    source for `copy.ebay.aspects` than the copywriter's guess.
 */

export interface EbaySearchArgs {
  query: string
  limit?: number
  categoryIds?: string[] | undefined
  marketplaceId?: string | undefined
}

export async function searchEbay(args: EbaySearchArgs): Promise<SearchResult> {
  const result = await searchItems({
    query: args.query,
    limit: args.limit ?? 50,
    categoryIds: args.categoryIds,
    marketplaceId: args.marketplaceId,
  })

  return {
    query: args.query,
    totalMatches: result.total,
    listings: result.items.map((item) =>
      CompetitorListingSchema.parse({
        id: item.itemId,
        title: item.title,
        tags: [],
        materials: [],
        priceEur: item.priceEur,
        views: null,
        favourites: null,
        daysListed: null,
        categoryId: item.categoryId,
        url: item.url,
      }),
    ),
    aspectFacets: result.facets,
  }
}
