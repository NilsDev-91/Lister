import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { config } from '../../config.js'
import { log, UserError } from '../../util/log.js'
import { RateLimiter, request, explain } from '../../util/http.js'
import { getAccessToken, apiKeyHeader, ETSY_API_BASE } from './auth.js'
import type { EtsyCopy, ProductInput } from '../../types.js'

/**
 * Etsy Open API v3 client, scoped to what this tool needs.
 *
 * Two content-type traps live in this file, both of which produce opaque 400s:
 *   - createDraftListing and updateListing are application/x-www-form-urlencoded
 *   - updateListingInventory is the one JSON endpoint, and it is PUT
 */

/**
 * Etsy's own guide no longer publishes a fixed ceiling: limits are per API key,
 * shown in the developer portal and returned on every response. 8/second is a
 * conservative start; `lastRateLimit()` reports what this key is actually
 * allowed, so callers that run batches can adapt instead of guessing.
 */
const limiter = new RateLimiter(8)

export interface RateLimitStatus {
  perSecond: number | null
  remainingThisSecond: number | null
  perDay: number | null
  remainingToday: number | null
}

let rateLimit: RateLimitStatus = {
  perSecond: null,
  remainingThisSecond: null,
  perDay: null,
  remainingToday: null,
}

/** What the last Etsy response said about this key's quota. */
export function lastRateLimit(): RateLimitStatus {
  return { ...rateLimit }
}

function numericHeader(response: Response, ...names: string[]): number | null {
  for (const name of names) {
    const raw = response.headers.get(name)
    if (raw !== null && /^\d+$/.test(raw.trim())) return Number(raw.trim())
  }
  return null
}

function captureRateLimit(response: Response): void {
  rateLimit = {
    perSecond: numericHeader(response, 'x-limit-per-second'),
    // Etsy's guide prints this header as `x-remaining-this-secon`, missing a
    // final "d". Rather than bet on which spelling the live API sends, read
    // both — the wrong one simply is not there.
    remainingThisSecond: numericHeader(response, 'x-remaining-this-second', 'x-remaining-this-secon'),
    perDay: numericHeader(response, 'x-limit-per-day'),
    remainingToday: numericHeader(response, 'x-remaining-today'),
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await getAccessToken()}`,
    'x-api-key': apiKeyHeader(),
  }
}

interface CallOptions extends RequestInit {
  form?: Record<string, string | string[]>
  json?: unknown
  /** Attempts including the first. Set to 1 for anything that costs money. */
  maxAttempts?: number
  /**
   * `apikey` skips the OAuth token entirely.
   *
   * Several read endpoints — the taxonomy, listing search, listing detail —
   * declare no OAuth scope and work on the key alone. That is what lets
   * keyword research run before a shop is ever connected.
   */
  auth?: 'oauth' | 'apikey'
}

async function call<T>(path: string, init: CallOptions = {}): Promise<T> {
  const { form, json, auth = 'oauth', ...rest } = init
  const credentials =
    auth === 'oauth' ? await authHeaders() : { 'x-api-key': apiKeyHeader() }
  const headers: Record<string, string> = { ...credentials, ...(rest.headers as Record<string, string>) }

  let body: string | URLSearchParams | undefined
  if (form) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(form)) {
      // Etsy encodes arrays as repeated keys: tags=a&tags=b
      if (Array.isArray(value)) for (const v of value) params.append(key, v)
      else params.append(key, value)
    }
    body = params
    headers['content-type'] = 'application/x-www-form-urlencoded'
  } else if (json !== undefined) {
    body = JSON.stringify(json)
    headers['content-type'] = 'application/json'
  }

  const response = await limiter.run(() =>
    request(`${ETSY_API_BASE}${path}`, {
      ...rest,
      headers,
      body,
      onRetry: (attempt, delay, reason) =>
        log.detail(`Etsy ${path}: ${reason}, retrying in ${Math.round(delay)}ms (attempt ${attempt})`),
    }),
  )

  captureRateLimit(response)

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface EtsyIdentity {
  userId: number
  shopId: number
}

/** One call returns both ids. shop_id is null when the account has no shop. */
export async function getIdentity(): Promise<EtsyIdentity> {
  try {
    const me = await call<{ user_id: number; shop_id: number | null }>('/users/me')
    if (me.shop_id == null) {
      throw new UserError(
        'That Etsy account has no shop.',
        'Open a shop at https://www.etsy.com/sell before listing through the API.',
      )
    }
    return { userId: me.user_id, shopId: me.shop_id }
  } catch (error) {
    return explain(error, 'Fetching your Etsy identity')
  }
}

// ---------------------------------------------------------------------------
// Prerequisites: shipping profile, taxonomy
// ---------------------------------------------------------------------------

export interface ShippingProfile {
  shipping_profile_id: number
  title: string
}

export async function listShippingProfiles(shopId: number): Promise<ShippingProfile[]> {
  try {
    const result = await call<{ results: ShippingProfile[] }>(`/shops/${shopId}/shipping-profiles`)
    return result.results ?? []
  } catch (error) {
    return explain(error, 'Listing Etsy shipping profiles')
  }
}

export interface ReturnPolicy {
  return_policy_id: number
  accepts_returns?: boolean
  accepts_exchanges?: boolean
}

/**
 * The shop's return policies. Optional for an EU shop, but Etsy counts a set
 * policy — even "no returns" — as a positive search-placement signal, so the
 * publish path attaches one when it exists.
 */
export async function listReturnPolicies(shopId: number): Promise<ReturnPolicy[]> {
  try {
    const result = await call<{ results: ReturnPolicy[] }>(`/shops/${shopId}/policies/return`)
    return result.results ?? []
  } catch (error) {
    return explain(error, 'Listing Etsy return policies')
  }
}

export interface TaxonomyNode {
  id: number
  name: string
  /** Root-to-here names, built while flattening — the API sends no such field. */
  path: string[]
  /** True when the node has no children; listings should sit on leaves. */
  leaf: boolean
  /** Depth in the tree, roots at 0. */
  level: number
}

interface RawTaxonomyNode {
  id?: number
  name?: string
  level?: number
  children?: RawTaxonomyNode[]
}

/**
 * The endpoint returns the *tree*: fifteen root nodes, each carrying its whole
 * subtree in `children`. Searching only `results` — as this client once did —
 * therefore matched nothing more specific than "Home & Living", and a hint like
 * "Desk Organizer" failed outright. Flattening is what makes the three thousand
 * real categories reachable.
 */
function flattenTaxonomy(nodes: RawTaxonomyNode[], parents: string[] = [], out: TaxonomyNode[] = []): TaxonomyNode[] {
  for (const node of nodes) {
    if (typeof node?.id !== 'number' || typeof node.name !== 'string') continue
    const path = [...parents, node.name]
    const children = Array.isArray(node.children) ? node.children : []
    out.push({ id: node.id, name: node.name, path, leaf: children.length === 0, level: path.length - 1 })
    flattenTaxonomy(children, path, out)
  }
  return out
}

/** The full taxonomy, flattened. Public — no OAuth scope needed, only the api key. */
export async function listTaxonomyNodes(): Promise<TaxonomyNode[]> {
  try {
    const result = await call<{ results: RawTaxonomyNode[] }>('/seller-taxonomy/nodes', { auth: 'apikey' })
    return flattenTaxonomy(result.results ?? [])
  } catch (error) {
    return explain(error, 'Fetching the Etsy seller taxonomy')
  }
}

// ---------------------------------------------------------------------------
// Public search — the basis of keyword research
// ---------------------------------------------------------------------------

/** As much of a ShopListing as research cares about. Everything else is dropped. */
export interface PublicListing {
  listing_id: number
  title: string
  tags?: string[] | null
  materials?: string[] | null
  /** The shop's own currency, whatever that is — usually not EUR. */
  price?: { amount: number; divisor: number; currency_code: string } | null
  /** Present only when the request passed `currency`; then it is that currency. */
  converted_price?: { amount: number; divisor: number; currency_code: string } | null
  num_favorers?: number | null
  views?: number | null
  original_creation_timestamp?: number | null
  creation_timestamp?: number | null
  taxonomy_id?: number | null
  /** `physical`, `download` or `both` — an object, a file, or one of each. */
  listing_type?: string | null
  url?: string | null
}

export interface SearchListingsArgs {
  keywords: string
  limit?: number
  /** Etsy's own relevance rank. Always descending — `sort_order` is ignored. */
  sortOnScore?: boolean
  taxonomyId?: number | undefined
  /** ISO 3166-1 alpha-2; restricts results to shops that deliver there. */
  buyerCountry?: string | undefined
  currency?: string | undefined
}

/**
 * Searches all active listings on Etsy the way a buyer would.
 *
 * Declares no OAuth scope: the api key alone is enough, so this runs without a
 * shop, without user consent and without spending anything. It is also the
 * cheapest possible live check of the whole Etsy client — base URL, key format,
 * limiter, retry and error translation — which is why `etsyPing` uses it.
 *
 * `count` is the total number of active listings matching the query. For
 * keyword research that number *is* the competition figure.
 */
export async function searchActiveListings(
  args: SearchListingsArgs,
): Promise<{ count: number | null; results: PublicListing[] }> {
  const query = new URLSearchParams({
    keywords: args.keywords,
    limit: String(args.limit ?? 50),
  })
  // sort_on only takes effect alongside a search option. Without `keywords` it
  // is silently ignored and the response is newest-first — which reads exactly
  // like a ranking and is not one.
  if (args.sortOnScore !== false) query.set('sort_on', 'score')
  if (args.taxonomyId !== undefined) query.set('taxonomy_id', String(args.taxonomyId))
  if (args.buyerCountry) query.set('buyer_country', args.buyerCountry)
  if (args.currency) query.set('currency', args.currency)

  try {
    const result = await call<{ count?: number | null; results?: PublicListing[] }>(
      `/listings/active?${query.toString()}`,
      { auth: 'apikey' },
    )
    return { count: result.count ?? null, results: result.results ?? [] }
  } catch (error) {
    return explain(error, `Searching Etsy for "${args.keywords}"`)
  }
}

/**
 * Fetches listings by id, up to 100 per call, without OAuth.
 *
 * A fallback for the view count. In practice the search response already
 * carries `views`, so this is rarely needed — but it does return the field
 * (verified 2026-08-13: 20 of 20), which makes it the cheap way to recover if
 * a search ever comes back without it.
 *
 * Etsy returns 404 for the *whole* request if any single id is missing, so a
 * caller batching stale ids loses the entire batch, not one row.
 */
export async function getPublicListings(listingIds: number[]): Promise<PublicListing[]> {
  if (!listingIds.length) return []
  if (listingIds.length > 100) throw new UserError('Etsy accepts at most 100 listing ids per batch.')

  const query = new URLSearchParams({ listing_ids: listingIds.join(',') })
  try {
    const result = await call<{ results?: PublicListing[] }>(`/listings/batch?${query.toString()}`, {
      auth: 'apikey',
    })
    return result.results ?? []
  } catch (error) {
    return explain(error, 'Fetching Etsy listings by id')
  }
}

/** One listing, with the fields the batch endpoint may not carry. */
export async function getPublicListing(listingId: number): Promise<PublicListing> {
  try {
    return await call<PublicListing>(`/listings/${listingId}`, { auth: 'apikey' })
  } catch (error) {
    return explain(error, `Fetching Etsy listing ${listingId}`)
  }
}

/**
 * One search against the live API, to prove the credentials and read the quota.
 *
 * Deliberately the smallest possible request: no OAuth, no shop, no write.
 */
export async function etsyPing(): Promise<{ matches: number | null; limits: RateLimitStatus }> {
  const { count } = await searchActiveListings({ keywords: '3d printed', limit: 1 })
  return { matches: count, limits: lastRateLimit() }
}

// ---------------------------------------------------------------------------
// Listing lifecycle
// ---------------------------------------------------------------------------

export interface DraftListingArgs {
  shopId: number
  copy: EtsyCopy
  product: ProductInput
  taxonomyId: number
  shippingProfileId: number
  /** EU shops do not require a return policy; elsewhere it is mandatory to activate. */
  returnPolicyId?: number | undefined
}

export interface EtsyListing {
  listing_id: number
  state: string
  url?: string
}

/**
 * Creates the listing in `draft` state. This does not charge the listing fee —
 * activation does. See `activateListing`.
 */
export async function createDraftListing(args: DraftListingArgs): Promise<EtsyListing> {
  const { copy, product } = args

  const form: Record<string, string | string[]> = {
    quantity: String(product.quantity),
    title: copy.title,
    description: copy.description,
    price: product.priceEur.toFixed(2),
    // These three are mutually dependent — Etsy requires all or none.
    who_made: 'i_did',
    when_made: 'made_to_order',
    is_supply: 'false',
    taxonomy_id: String(args.taxonomyId),
    type: 'physical',
    shipping_profile_id: String(args.shippingProfileId),
    // Auto-renew costs another listing fee every four months. Off by default;
    // the seller can turn it on in Etsy's UI if they want it.
    should_auto_renew: 'false',
    is_taxable: 'true',
    // Made-to-order dispatch time. A realistic processing window is one of
    // Etsy's listing-quality signals, and silently omitting it made every
    // listing claim the shop default instead of the seller's stated days.
    processing_min: String(product.processingDays),
    processing_max: String(product.processingDays),
  }

  if (args.returnPolicyId !== undefined) form['return_policy_id'] = String(args.returnPolicyId)
  if (copy.tags.length) form['tags'] = copy.tags
  if (copy.materials.length) form['materials'] = copy.materials

  if (product.weightGrams !== null) {
    form['item_weight'] = String(product.weightGrams)
    form['item_weight_unit'] = 'g'
  }
  if (product.dimensionsMm !== null) {
    const { length, width, height } = product.dimensionsMm
    form['item_length'] = String(length)
    form['item_width'] = String(width)
    form['item_height'] = String(height)
    form['item_dimensions_unit'] = 'mm'
  }

  try {
    // Not retried: draft creation is not idempotent. A timeout after Etsy has
    // committed would mint a duplicate draft per retry — free, but each one an
    // orphan in Shop Manager that the reuse logic can never find again. Same
    // rule as createOffer and the image upload.
    return await call<EtsyListing>(`/shops/${args.shopId}/listings`, { method: 'POST', form, maxAttempts: 1 })
  } catch (error) {
    return explain(error, 'Creating the Etsy draft listing')
  }
}

/**
 * Uploads one image. Etsy takes a single file per request, so callers loop.
 * `rank` is 1-based and rank 1 is the primary image — not 0.
 */
export async function uploadListingImage(args: {
  shopId: number
  listingId: number
  filePath: string
  rank: number
  altText?: string
}): Promise<{ listing_image_id: number }> {
  const bytes = await readFile(args.filePath)
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)]), basename(args.filePath))
  form.append('rank', String(args.rank))
  // Etsy caps alt text at 250 characters, not 500.
  if (args.altText) form.append('alt_text', args.altText.slice(0, 250))

  // Resolve the token before entering the limiter, so a refresh cannot happen
  // inside the gated call and skew the rate window.
  const headers = await authHeaders()

  try {
    const response = await limiter.run(() =>
      request(`${ETSY_API_BASE}/shops/${args.shopId}/listings/${args.listingId}/images`, {
        method: 'POST',
        // Do not set content-type: fetch must add the multipart boundary itself.
        headers,
        body: form,
        // Not retried: an upload whose response was lost may still have landed,
        // and a retry then attaches the same photo twice. Same rule as eBay's
        // picture upload.
        maxAttempts: 1,
        onRetry: (attempt, delay, reason) =>
          log.detail(`Etsy image upload: ${reason}, retrying in ${Math.round(delay)}ms (attempt ${attempt})`),
      }),
    )
    return (await response.json()) as { listing_image_id: number }
  } catch (error) {
    return explain(error, `Uploading ${basename(args.filePath)} to Etsy`)
  }
}

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------

/**
 * Etsy's first custom variation property.
 *
 * Variations either use a taxonomy property with its fixed `value_ids`, or one
 * of the two custom slots (513/514) that take free-form names and values. The
 * custom slot is the right one here: the colour names are the seller's own
 * ("Waldgruen", "Silk Petrol"), and forcing them onto a taxonomy value list
 * would reject exactly the names that distinguish a print shop's colours.
 */
export const ETSY_CUSTOM_VARIATION_PROPERTY = 513

export interface EtsyVariationInput {
  sku: string
  colour: string
  priceEur: number
  quantity: number
}

/**
 * The inventory body for a colour-varied listing. Pure and exported, because
 * the `*_on_property` coupling is exactly the kind of contract a test should
 * pin: the update FAILS if a product's sku/price/quantity differ while the
 * matching `*_on_property` array does not name the property they differ by.
 */
export function buildVariationInventory(variants: EtsyVariationInput[], propertyName = 'Farbe'): {
  products: unknown[]
  price_on_property: number[]
  quantity_on_property: number[]
  sku_on_property: number[]
} {
  return {
    products: variants.map((v) => ({
      sku: v.sku,
      property_values: [
        {
          property_id: ETSY_CUSTOM_VARIATION_PROPERTY,
          property_name: propertyName,
          values: [v.colour],
        },
      ],
      // Price is a plain float here (amount/divisor already applied), unlike
      // the Money objects Etsy sends back.
      offerings: [{ price: v.priceEur, quantity: v.quantity, is_enabled: true }],
    })),
    price_on_property: [ETSY_CUSTOM_VARIATION_PROPERTY],
    quantity_on_property: [ETSY_CUSTOM_VARIATION_PROPERTY],
    sku_on_property: [ETSY_CUSTOM_VARIATION_PROPERTY],
  }
}

/**
 * Replaces the listing's inventory with one product per colour.
 *
 * The one JSON endpoint in the listing lifecycle, and a full replace: the
 * previous single-product inventory is superseded, which is exactly what
 * turning a plain draft into a variation listing means. Works on drafts and
 * active listings alike; on Etsy the shape switch is legal, unlike on eBay.
 */
export async function updateListingVariations(
  listingId: number,
  variants: EtsyVariationInput[],
): Promise<void> {
  try {
    await call(`/listings/${listingId}/inventory`, {
      method: 'PUT',
      json: buildVariationInventory(variants),
    })
  } catch (error) {
    return explain(error, 'Setting the Etsy colour variations')
  }
}

/**
 * Rewrites the text of an existing listing — live or draft — in place.
 *
 * PATCH semantics, so only the fields sent change. Scope is deliberately the
 * four search-relevant text fields: price and quantity live on the inventory
 * endpoint (`updateListingInventory`, the one JSON PUT) and are not touched
 * here. Editing does not reset Etsy's recency boost either way — a revise
 * improves the relevance base, not the momentum — so there is no ranking
 * reason to hesitate before calling this on an active listing.
 */
export async function updateListingContent(args: {
  shopId: number
  listingId: number
  copy: EtsyCopy
}): Promise<EtsyListing> {
  const form: Record<string, string | string[]> = {
    title: args.copy.title,
    description: args.copy.description,
  }
  // Same guard as createDraftListing: an empty array would be sent as nothing
  // and PATCH would leave the old values standing anyway.
  if (args.copy.tags.length) form['tags'] = args.copy.tags
  if (args.copy.materials.length) form['materials'] = args.copy.materials

  try {
    return await call<EtsyListing>(`/shops/${args.shopId}/listings/${args.listingId}`, {
      method: 'PATCH',
      form,
    })
  } catch (error) {
    return explain(error, 'Revising the Etsy listing')
  }
}

/**
 * Flips a draft to active, which publishes it on etsy.com.
 *
 * This is the billable moment — Etsy charges the listing fee here, not at
 * draft creation. Callers must have explicit user confirmation before calling
 * it, and must never call it inside a retry loop.
 */
export async function activateListing(shopId: number, listingId: number): Promise<EtsyListing> {
  try {
    return await call<EtsyListing>(`/shops/${shopId}/listings/${listingId}`, {
      method: 'PATCH',
      form: { state: 'active' },
      // A failed activation should surface, not be retried into multiple fees.
      maxAttempts: 1,
    })
  } catch (error) {
    return explain(error, 'Activating the Etsy listing')
  }
}

export async function getListing(listingId: number): Promise<EtsyListing> {
  try {
    return await call<EtsyListing>(`/listings/${listingId}`)
  } catch (error) {
    return explain(error, 'Fetching the Etsy listing')
  }
}

export function listingUrl(listingId: number): string {
  return `https://www.etsy.com/listing/${listingId}`
}

export const etsyConfigSummary = () => ({
  keystringSet: Boolean(process.env['ETSY_KEYSTRING']),
  redirectUri: config.etsy.redirectUri,
})
