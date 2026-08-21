import { config } from '../../config.js'
import { log, UserError } from '../../util/log.js'
import { request, explain, ApiError, RateLimiter } from '../../util/http.js'
import { getAppToken, apiBase } from './auth.js'

/**
 * eBay Browse API — buyer-side search, used here for keyword research.
 *
 * A separate file for the same reason `pictures.ts` is one: this is a different
 * eBay API family with different rules from the Sell Inventory API, and the
 * differences are the kind that fail quietly.
 *
 *  - **Auth is an application token**, not a user token. `client_credentials`
 *    with the plain `api_scope` is enough, which means research needs **no
 *    RuName and no user consent** — it is not blocked on the seller-side OAuth
 *    setup at all.
 *  - **`X-EBAY-C-MARKETPLACE-ID` is mandatory here.** In the Inventory API that
 *    header does nothing and the marketplace comes from the offer body. Same
 *    vendor, opposite rule; carrying the Inventory habit over yields US results
 *    for a German shop, which looks like working code.
 *  - The sandbox holds no real inventory, so mined data from it is noise —
 *    the same trap as sandbox category suggestions, which return confident
 *    nonsense with HTTP 200.
 *
 * Response shapes below follow eBay's documentation and are **not yet verified
 * against the live API**; every field is read defensively for that reason.
 */

/** eBay's Browse limit is generous, but research runs in bursts. */
const limiter = new RateLimiter(5)

interface BrowseCallOptions {
  /** Browse selects the marketplace by header, unlike the Inventory API. */
  marketplaceId: string
}

async function call<T>(path: string, options: BrowseCallOptions): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await getAppToken()}`,
    accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': options.marketplaceId,
  }

  const response = await limiter.run(() =>
    request(`${apiBase()}${path}`, {
      headers,
      onRetry: (attempt, delay, reason) =>
        log.detail(`eBay browse ${path}: ${reason}, retrying in ${Math.round(delay)}ms (attempt ${attempt})`),
    }),
  )

  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

interface ItemSummary {
  itemId?: string
  title?: string
  itemWebUrl?: string
  price?: { value?: string; currency?: string }
  categories?: { categoryId?: string; categoryName?: string }[]
}

interface AspectDistribution {
  localizedAspectName?: string
  aspectValueDistributions?: { localizedAspectValue?: string; matchCount?: number }[]
}

interface SearchResponse {
  total?: number
  itemSummaries?: ItemSummary[]
  refinement?: { aspectDistributions?: AspectDistribution[] }
}

export interface BrowseItem {
  itemId: string
  title: string
  /** Null unless eBay quoted the currency we asked for; never silently converted. */
  priceEur: number | null
  categoryId: string | null
  /** eBay states it next to the id; Etsy has no equivalent. */
  categoryName: string | null
  url: string | null
}

export interface BrowseFacet {
  name: string
  value: string
  count: number
}

export interface BrowseSearchResult {
  /** Total matching active items — the competition figure for this query. */
  total: number | null
  items: BrowseItem[]
  /**
   * Item specifics buyers actually filter on, with counts.
   *
   * This is eBay's own index rather than our inference from titles, which makes
   * it the right source for `copy.ebay.aspects` — currently guessed by the
   * copywriter with no evidence behind it.
   */
  facets: BrowseFacet[]
}

/** eBay's Browse ceiling per request. */
const MAX_LIMIT = 200

export interface BrowseSearchArgs {
  query: string
  limit?: number
  categoryIds?: string[] | undefined
  marketplaceId?: string | undefined
}

/**
 * Searches active eBay items the way a buyer does.
 *
 * Default sort is Best Match, eBay's own ranking — which is the point: the top
 * results are what the search engine already rewards for this query.
 */
export async function searchItems(args: BrowseSearchArgs): Promise<BrowseSearchResult> {
  const marketplaceId = args.marketplaceId ?? config.ebay.marketplaceId

  const query = new URLSearchParams({
    q: args.query,
    limit: String(Math.min(args.limit ?? 50, MAX_LIMIT)),
    // MATCHING_ITEMS keeps the items in the response alongside the facets;
    // asking for refinements alone returns facets and no items.
    fieldgroups: 'MATCHING_ITEMS,ASPECT_REFINEMENTS',
  })
  if (args.categoryIds?.length) query.set('category_ids', args.categoryIds.join(','))

  let response: SearchResponse
  try {
    response = await call<SearchResponse>(`/buy/browse/v1/item_summary/search?${query.toString()}`, {
      marketplaceId,
    })
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      throw new UserError(
        `eBay refused the Browse search for "${args.query}" (403).`,
        'The Browse API needs a production keyset. An application token is enough — no RuName and no user consent — but sandbox credentials will not do.',
      )
    }
    return explain(error, `Searching eBay for "${args.query}"`)
  }

  const items: BrowseItem[] = []
  for (const summary of response.itemSummaries ?? []) {
    if (!summary.itemId || !summary.title) continue
    items.push({
      itemId: summary.itemId,
      title: summary.title,
      priceEur: parsePrice(summary.price),
      categoryId: summary.categories?.[0]?.categoryId ?? null,
      // Free of charge, and the research is unreadable without it: eBay sends
      // the name right next to the id, and dropping it left the category
      // suggestion as a bare number.
      categoryName: summary.categories?.[0]?.categoryName ?? null,
      url: summary.itemWebUrl ?? null,
    })
  }

  const facets: BrowseFacet[] = []
  for (const distribution of response.refinement?.aspectDistributions ?? []) {
    const name = distribution.localizedAspectName
    if (!name) continue
    for (const value of distribution.aspectValueDistributions ?? []) {
      if (!value.localizedAspectValue || typeof value.matchCount !== 'number') continue
      facets.push({ name, value: value.localizedAspectValue, count: value.matchCount })
    }
  }

  return { total: typeof response.total === 'number' ? response.total : null, items, facets }
}

/**
 * Prices arrive as strings with a currency code. A EUR figure is taken at face
 * value; anything else is dropped rather than converted, because a made-up
 * exchange rate in a price band is worse than an absent one.
 */
function parsePrice(price: ItemSummary['price']): number | null {
  if (!price?.value || price.currency !== 'EUR') return null
  const value = Number(price.value)
  return Number.isFinite(value) && value >= 0 ? value : null
}
