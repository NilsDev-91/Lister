import { config } from '../../config.js'
import { log, UserError } from '../../util/log.js'
import { request, explain, ApiError } from '../../util/http.js'
import { getUserToken, getAppToken, apiBase } from './auth.js'
import { parseAspectSpecs, type AspectSpec } from './aspect-spec.js'
import { cacheKey, readAspectCache, readStaleAspectCache, writeAspectCache } from './aspect-cache.js'
import type { EbayCopy, ProductInput } from '../../types.js'

/**
 * eBay Sell Inventory API client.
 *
 * Contract details that are easy to get wrong and produce opaque 400s:
 *  - `Content-Language` is mandatory on inventory-item and offer writes. For
 *    ebay.de it must be `de-DE`.
 *  - The SKU is a path parameter only; the InventoryItem body has no `sku` key.
 *  - `pricingSummary.price.value` is a *string*, while weights and VAT are numbers.
 *  - The marketplace comes from `offer.marketplaceId`, not from a header.
 *  - `createOrReplaceInventoryItem` is a full replace: omitting `availability`
 *    on an update silently zeroes the quantity.
 */

type TokenKind = 'user' | 'app'

interface CallOptions {
  method?: string
  body?: unknown
  token?: TokenKind
  /** Sets Content-Language; required on inventory item and offer writes. */
  contentLanguage?: string
  /** Statuses to treat as success rather than throwing, e.g. 409 on create-location. */
  tolerate?: number[]
  maxAttempts?: number
}

async function call<T>(path: string, options: CallOptions = {}): Promise<T | undefined> {
  const { method = 'GET', body, token = 'user', contentLanguage, tolerate = [], maxAttempts } = options

  const accessToken = token === 'user' ? await getUserToken() : await getAppToken()
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (contentLanguage) {
    headers['content-language'] = contentLanguage
    // Accept-Language is required too, even though eBay's own reference lists
    // only Content-Type and Content-Language. Omitting it fails the call with
    // `25709 Invalid value for header Accept-Language.` — verified against the
    // live API; the documentation is wrong on this point.
    headers['accept-language'] = contentLanguage
  }

  try {
    const response = await request(`${apiBase()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      maxAttempts,
      onRetry: (attempt, delay, reason) =>
        log.detail(`eBay ${path}: ${reason}, retrying in ${Math.round(delay)}ms (attempt ${attempt})`),
    })

    if (response.status === 204) return undefined
    const text = await response.text()
    return text ? (JSON.parse(text) as T) : undefined
  } catch (error) {
    if (error instanceof ApiError && tolerate.includes(error.status)) return undefined
    throw error
  }
}

/** eBay nests real diagnostics inside an `errors` array; surface them. */
function ebayErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  try {
    const parsed = JSON.parse(error.body) as {
      errors?: { message?: string; longMessage?: string; parameters?: { name: string; value: string }[] }[]
    }
    if (!parsed.errors?.length) return undefined
    return parsed.errors
      .map((e) => {
        const params = e.parameters?.map((p) => `${p.name}=${p.value}`).join(', ')
        return `${e.longMessage ?? e.message ?? 'unknown error'}${params ? ` (${params})` : ''}`
      })
      .join('\n')
  } catch {
    return undefined
  }
}

function fail(error: unknown, context: string): never {
  const detail = ebayErrorDetail(error)
  if (detail) throw new UserError(`${context}:\n${detail}`)
  return explain(error, context)
}

// ---------------------------------------------------------------------------
// Seller onboarding
// ---------------------------------------------------------------------------

/**
 * Business policies must be switched on before the Inventory API will publish.
 * Without the opt-in, the policy endpoints return an error rather than a list.
 */
export async function ensureBusinessPoliciesOptIn(): Promise<void> {
  try {
    const opted = await call<{ programs?: { programType: string }[] }>(
      '/sell/account/v1/program/get_opted_in_programs',
    )
    const already = opted?.programs?.some((p) => p.programType === 'SELLING_POLICY_MANAGEMENT')
    if (already) return

    log.step('Opting your eBay account into business policy management…')
    await call('/sell/account/v1/program/opt_in', {
      method: 'POST',
      body: { programType: 'SELLING_POLICY_MANAGEMENT' },
      tolerate: [409],
    })
  } catch (error) {
    fail(error, 'Checking eBay business-policy opt-in')
  }
}

export interface BusinessPolicies {
  fulfillmentPolicyId: string
  paymentPolicyId: string
  returnPolicyId: string
}

interface PolicyList<K extends string> {
  total?: number
  [key: string]: unknown
}

async function firstPolicyId(
  path: string,
  collection: string,
  idField: string,
  label: string,
): Promise<string> {
  const marketplaceId = config.ebay.marketplaceId
  const result = await call<PolicyList<string>>(`${path}?marketplace_id=${marketplaceId}`)
  const list = (result?.[collection] as Record<string, unknown>[] | undefined) ?? []
  const first = list[0]
  const id = first?.[idField]

  if (typeof id !== 'string') {
    throw new UserError(
      `No ${label} found for ${marketplaceId}.`,
      `Create one in eBay's seller settings (Business Policies), then re-run. This tool reads existing policies rather than inventing shipping and returns terms for you.`,
    )
  }
  return id
}

/**
 * Reads the seller's existing business policies.
 *
 * Deliberately read-only: shipping cost, handling time and return terms are
 * commercial decisions with legal weight, so the tool uses what the seller has
 * already configured rather than creating policies on their behalf.
 */
export async function resolveBusinessPolicies(): Promise<BusinessPolicies> {
  try {
    const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] = await Promise.all([
      firstPolicyId('/sell/account/v1/fulfillment_policy', 'fulfillmentPolicies', 'fulfillmentPolicyId', 'fulfillment (shipping) policy'),
      firstPolicyId('/sell/account/v1/payment_policy', 'paymentPolicies', 'paymentPolicyId', 'payment policy'),
      firstPolicyId('/sell/account/v1/return_policy', 'returnPolicies', 'returnPolicyId', 'return policy'),
    ])
    return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId }
  } catch (error) {
    fail(error, 'Reading your eBay business policies')
  }
}

/**
 * Creates the inventory location if it is missing. 409 means it already exists.
 *
 * A postal code is required alongside the country — a country on its own is
 * rejected with a bare `25802 Input error`, which says nothing about the cause.
 * The address comes from the SELLER_* configuration when present, since that is
 * the address goods actually ship from.
 */
export async function ensureInventoryLocation(merchantLocationKey: string): Promise<void> {
  const seller = config.seller.manufacturer
  const address: Record<string, string> = seller
    ? stripUndefined({
        addressLine1: seller.addressLine1,
        city: seller.city,
        stateOrProvince: seller.stateOrProvince,
        postalCode: seller.postalCode,
        country: seller.country,
      }) as Record<string, string>
    : { postalCode: process.env['EBAY_LOCATION_POSTAL_CODE'] ?? '10115', country: 'DE' }

  if (!address['postalCode']) {
    throw new UserError(
      'eBay needs a postal code for the inventory location.',
      'Set SELLER_POSTAL_CODE in .env, or EBAY_LOCATION_POSTAL_CODE if you would rather not fill in the full seller block.',
    )
  }

  const path = `/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`

  // Check first rather than create-and-tolerate. An existing key comes back as
  // 400 with errorId 25803, not the 409 you would expect — and tolerating 400
  // wholesale would swallow the genuine address errors this call also returns.
  try {
    const existing = await call<{ merchantLocationKey?: string }>(path, { maxAttempts: 1 })
    if (existing?.merchantLocationKey) return
  } catch {
    // Not found, or unreadable — fall through and try to create it.
  }

  try {
    await call(path, {
      method: 'POST',
      body: {
        location: { address },
        // locationTypes and merchantLocationStatus both default sensibly
        // (WAREHOUSE / ENABLED), so they are left off.
        name: merchantLocationKey,
      },
    })
  } catch (error) {
    // Lost a race with another run; the location is there, which is all we need.
    if (error instanceof ApiError && error.body.includes('25803')) return
    fail(error, `Creating eBay inventory location "${merchantLocationKey}"`)
  }
}

// ---------------------------------------------------------------------------
// Taxonomy — category and aspect discovery (application token, no consent)
// ---------------------------------------------------------------------------

let categoryTreeIdCache: string | undefined

export async function getCategoryTreeId(): Promise<string> {
  if (categoryTreeIdCache) return categoryTreeIdCache
  try {
    const result = await call<{ categoryTreeId: string }>(
      `/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${config.ebay.marketplaceId}`,
      { token: 'app' },
    )
    if (!result?.categoryTreeId) throw new UserError('eBay returned no category tree id.')
    categoryTreeIdCache = result.categoryTreeId
    return categoryTreeIdCache
  } catch (error) {
    fail(error, 'Fetching the eBay category tree id')
  }
}

export interface CategorySuggestion {
  categoryId: string
  categoryName: string
}

/**
 * Asks eBay which leaf category best matches a German title or category phrase.
 *
 * Returns `undefined` in the sandbox rather than a suggestion. eBay documents
 * that this method "is not supported in the Sandbox environment. It will return
 * a response payload in which the categoryName fields contain random or
 * boilerplate text regardless of the query submitted" — note it *succeeds* and
 * returns nonsense rather than erroring, so there is no exception to catch and
 * a caller that trusts the response would publish under a random category.
 */
export async function suggestCategory(query: string): Promise<CategorySuggestion | undefined> {
  if (config.ebay.env === 'sandbox') {
    log.warn('eBay sandbox returns boilerplate category suggestions, so this lookup is skipped.')
    log.detail('Pass --category-id <id> to publish in the sandbox.')
    return undefined
  }

  const treeId = await getCategoryTreeId()
  try {
    const result = await call<{
      categorySuggestions?: { category: { categoryId: string; categoryName: string } }[]
    }>(
      `/commerce/taxonomy/v1/category_tree/${treeId}/get_category_suggestions?q=${encodeURIComponent(query)}`,
      { token: 'app' },
    )
    const top = result?.categorySuggestions?.[0]?.category
    return top ? { categoryId: top.categoryId, categoryName: top.categoryName } : undefined
  } catch (error) {
    fail(error, `Looking up an eBay category for "${query}"`)
  }
}

export interface AspectFetch {
  specs: AspectSpec[]
  /**
   * True when eBay could not be reached and an expired cache entry was used.
   * Callers must downgrade blockers to warnings — a metadata outage is not
   * evidence that a listing is wrong.
   */
  stale: boolean
  /** When the metadata was fetched, so a stale verdict can name its age. */
  fetchedAt: string | null
}

/**
 * Per-process memo; the disk cache underneath survives restarts.
 *
 * Entries expire after an hour: the web server is a long-running process, and
 * an unbounded memo would quietly outlive the seven-day disk TTL it sits over.
 */
const aspectMemo = new Map<string, { fetch: AspectFetch; at: number }>()
const MEMO_TTL_MS = 60 * 60 * 1000

/**
 * The item specifics eBay defines for a category.
 *
 * Three layers: a process memo, a seven-day disk cache, then the API. The
 * response is cached raw and re-parsed on every read, so `parseAspectSpecs`
 * stays the only thing that decides what a spec means.
 */
export async function getAspectSpecs(
  categoryId: string,
  options: { refresh?: boolean; now?: Date } = {},
): Promise<AspectFetch> {
  const now = options.now ?? new Date()
  const treeId = await getCategoryTreeId()
  const key = cacheKey(config.ebay.env, treeId, categoryId)

  if (!options.refresh) {
    const memo = aspectMemo.get(key)
    if (memo && now.getTime() - memo.at < MEMO_TTL_MS) return memo.fetch

    const cached = readAspectCache(key, now)
    if (cached) {
      const hit: AspectFetch = { specs: cached.specs, stale: false, fetchedAt: cached.fetchedAt }
      aspectMemo.set(key, { fetch: hit, at: now.getTime() })
      return hit
    }
  }

  try {
    const response = await call<unknown>(
      `/commerce/taxonomy/v1/category_tree/${treeId}/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
      { token: 'app' },
    )
    const specs = parseAspectSpecs(response)
    if (specs.length) writeAspectCache(key, response, now)
    const fresh: AspectFetch = { specs, stale: false, fetchedAt: now.toISOString() }
    aspectMemo.set(key, { fetch: fresh, at: now.getTime() })
    return fresh
  } catch (error) {
    // Falling back to expired metadata beats reporting "no metadata", which
    // would make every required aspect look unverifiable.
    const stale = readStaleAspectCache(key)
    if (stale) {
      log.warn(`eBay aspect metadata unreachable; using the copy from ${stale.fetchedAt}.`)
      return { specs: stale.specs, stale: true, fetchedAt: stale.fetchedAt }
    }
    fail(error, `Fetching item aspects for category ${categoryId}`)
  }
}

// ---------------------------------------------------------------------------
// Listing lifecycle
// ---------------------------------------------------------------------------

/** eBay rejects explicit nulls in the regulatory block, so drop empty keys. */
function stripUndefined(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== ''))
}

/**
 * Asks eBay whether a category actually requires the regulatory block.
 *
 * GPSR fields are conditionally required per leaf category rather than
 * blanket-required per marketplace, and this is the authoritative answer.
 */
export async function getRegulatoryRequirements(categoryId: string): Promise<{ name: string; usage: string }[]> {
  try {
    const result = await call<{
      regulatoryPolicies?: { supportedAttributes?: { name: string; usage: string }[] }[]
    }>(
      `/sell/metadata/v1/marketplace/${config.ebay.marketplaceId}/get_regulatory_policies?filter=categoryIds:{${encodeURIComponent(categoryId)}}`,
    )
    return result?.regulatoryPolicies?.[0]?.supportedAttributes ?? []
  } catch {
    // Advisory only — never block a publish because the metadata lookup failed.
    return []
  }
}

/** ebay.de writes German field values, which Content-Language must declare. */
function contentLanguageFor(marketplaceId: string): string {
  const map: Record<string, string> = {
    EBAY_DE: 'de-DE',
    EBAY_AT: 'de-AT',
    EBAY_CH: 'de-CH',
    EBAY_GB: 'en-GB',
    EBAY_US: 'en-US',
    EBAY_FR: 'fr-FR',
    EBAY_IT: 'it-IT',
    EBAY_ES: 'es-ES',
  }
  return map[marketplaceId] ?? 'en-US'
}

export interface InventoryItemArgs {
  sku: string
  copy: EbayCopy
  product: ProductInput
  /** Must be HTTPS. eBay fetches these itself; it does not accept uploads here. */
  imageUrls: string[]
}

/**
 * Reads brand and MPN out of the item specifics, falling back to the unbranded
 * defaults.
 *
 * The dedicated `product.brand`/`product.mpn` fields and the aspects both reach
 * the listing, and they used to be able to disagree: a seller who set
 * `Marke: MeineMarke` still had `brand: "Markenlos"` hardcoded next to it.
 * eBay matches aspect names case-insensitively across its German and English
 * spellings, so both are checked here.
 */
export function productIdentityFromAspects(aspects: Record<string, string[]>): { brand: string; mpn: string } {
  const value = (names: string[]): string | undefined => {
    for (const [key, values] of Object.entries(aspects)) {
      if (names.includes(key.trim().toLowerCase()) && values[0]?.trim()) return values[0].trim()
    }
    return undefined
  }
  return {
    brand: value(['marke', 'brand']) ?? 'Markenlos',
    mpn: value(['herstellernummer', 'mpn', 'manufacturer part number']) ?? 'Nicht zutreffend',
  }
}

/**
 * Creates or replaces the inventory item.
 *
 * This is a full replace, not a merge: every field the listing needs must be
 * present on every call, including `availability`.
 */
export async function putInventoryItem(args: InventoryItemArgs): Promise<void> {
  const { sku, copy, product, imageUrls } = args

  const insecure = imageUrls.filter((u) => !u.startsWith('https://'))
  if (insecure.length) {
    throw new UserError(
      `eBay only accepts HTTPS image URLs. These are not: ${insecure.join(', ')}`,
    )
  }
  if (!imageUrls.length) {
    throw new UserError(
      'eBay requires at least one image URL.',
      'Either the licence permits reusing the MakerWorld renders, or you need to host your own photos on an HTTPS URL.',
    )
  }

  const identity = productIdentityFromAspects(copy.aspects)
  const body: Record<string, unknown> = {
    availability: { shipToLocationAvailability: { quantity: product.quantity } },
    condition: 'NEW',
    product: {
      title: copy.title,
      description: copy.descriptionHtml,
      aspects: copy.aspects,
      imageUrls: imageUrls.slice(0, 24),
      brand: identity.brand,
      mpn: identity.mpn,
    },
  }

  if (product.weightGrams !== null || product.dimensionsMm !== null) {
    const pkg: Record<string, unknown> = {}
    if (product.weightGrams !== null) {
      pkg['weight'] = { value: Number((product.weightGrams / 1000).toFixed(3)), unit: 'KILOGRAM' }
    }
    if (product.dimensionsMm !== null) {
      const { length, width, height } = product.dimensionsMm
      pkg['dimensions'] = {
        length: Number((length / 10).toFixed(1)),
        width: Number((width / 10).toFixed(1)),
        height: Number((height / 10).toFixed(1)),
        unit: 'CENTIMETER',
      }
    }
    body['packageWeightAndSize'] = pkg
  }

  try {
    // The SKU travels in the path only — the InventoryItem schema has no sku field.
    await call(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'PUT',
      body,
      contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
    })
  } catch (error) {
    fail(error, `Creating the eBay inventory item for SKU ${sku}`)
  }
}

export interface OfferArgs {
  sku: string
  copy: EbayCopy
  product: ProductInput
  categoryId: string
  policies: BusinessPolicies
  merchantLocationKey: string
  /** German standard rate. Only set when the seller actually charges VAT. */
  vatPercentage?: number | undefined
}

/**
 * Builds the offer payload.
 *
 * `forUpdate` drops sku, marketplaceId and format: those three are fixed once
 * an offer exists, and eBay's update request schema has no place for them.
 */
function buildOfferBody(args: OfferArgs, forUpdate = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(forUpdate ? {} : { sku: args.sku, marketplaceId: config.ebay.marketplaceId, format: 'FIXED_PRICE' }),
    categoryId: args.categoryId,
    listingDescription: args.copy.descriptionHtml,
    // Fixed-price listings must be Good 'Til Cancelled.
    listingDuration: 'GTC',
    // Note: this *overrides* the inventory item's quantity rather than being
    // combined with it, so the two must agree. Both are set from
    // product.quantity, which keeps them in step.
    availableQuantity: args.product.quantity,
    pricingSummary: {
      // A string, deliberately: eBay rejects a JSON number here.
      price: { value: args.product.priceEur.toFixed(2), currency: 'EUR' },
    },
    listingPolicies: {
      fulfillmentPolicyId: args.policies.fulfillmentPolicyId,
      paymentPolicyId: args.policies.paymentPolicyId,
      returnPolicyId: args.policies.returnPolicyId,
    },
    merchantLocationKey: args.merchantLocationKey,
    // Keep eBay from overwriting bespoke copy with catalog data.
    includeCatalogProductDetails: false,
  }

  // VAT. `vatPercentage` is display/invoice metadata — eBay does not calculate
  // anything from it, and the price you send stays gross. It only works for
  // business sellers with a VAT ID registered at eBay.
  //
  // Note the neighbouring `applyTax` field is deliberately not set: despite the
  // name it switches on the US sales-tax table, so sending `applyTax: false`
  // from ebay.de is noise rather than a VAT exemption. Under the German
  // Kleinunternehmerregelung the correct encoding is to omit `tax` entirely,
  // which is what happens when --vat is not passed.
  if (args.vatPercentage !== undefined) {
    body['tax'] = { vatPercentage: args.vatPercentage }
  }

  // GPSR (EU 2023/988). `regulatory` sits at the root of the *offer* — there is
  // no product.regulatory and no manufacturer field on the inventory item.
  const manufacturer = config.seller.manufacturer
  if (manufacturer) {
    body['regulatory'] = {
      manufacturer: stripUndefined(manufacturer),
      // responsiblePersons is intentionally absent. It identifies an EU
      // representative for a manufacturer based outside the EU; a German maker
      // is their own responsible operator, so sending it would be wrong.
    }
  }

  return body
}

/**
 * Finds the offer eBay already holds for a SKU on this marketplace, if any.
 *
 * The recovery half of offer creation: eBay permits exactly one offer per
 * sku/marketplace/format, so "already exists" is not an error state — it means
 * a previous attempt succeeded but its response was lost, and the offerId can
 * be recovered instead of the SKU staying wedged.
 */
export async function findOfferBySku(sku: string): Promise<string | undefined> {
  try {
    const result = await call<{ offers?: { offerId?: string }[] }>(
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${config.ebay.marketplaceId}`,
      { contentLanguage: contentLanguageFor(config.ebay.marketplaceId) },
    )
    return result?.offers?.[0]?.offerId
  } catch {
    return undefined
  }
}

export async function createOffer(args: OfferArgs): Promise<string> {
  try {
    const result = await call<{ offerId: string }>('/sell/inventory/v1/offer', {
      method: 'POST',
      body: buildOfferBody(args),
      contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
      // Not retried: offer creation is not idempotent. A timeout after eBay has
      // committed the offer would make every retry fail with "already exists"
      // while the real offerId is lost — the recovery below handles that case.
      maxAttempts: 1,
    })
    if (!result?.offerId) throw new UserError('eBay created the offer but returned no offerId.')
    return result.offerId
  } catch (error) {
    // "Offer entity already exists" (25002) or a lost response: look the offer
    // up by SKU and continue with it rather than leaving the SKU wedged.
    const recovered = await findOfferBySku(args.sku)
    if (recovered) {
      log.warn(`eBay already holds offer ${recovered} for SKU ${args.sku} — reusing it.`)
      await updateOffer(recovered, args)
      return recovered
    }
    fail(error, 'Creating the eBay offer')
  }
}

/**
 * Rewrites an existing offer.
 *
 * eBay permits one offer per sku/marketplace/format, so a re-run of publish
 * updates rather than creating a second one. Like the inventory item this is a
 * full replace — the body must carry every field the listing needs.
 */
export async function updateOffer(offerId: string, args: OfferArgs): Promise<void> {
  const body = buildOfferBody(args, true)
  try {
    await call(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
      method: 'PUT',
      body,
      contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
    })
  } catch (error) {
    fail(error, `Updating eBay offer ${offerId}`)
  }
}

// ---------------------------------------------------------------------------
// Multi-variation listings
// ---------------------------------------------------------------------------

/** eBay's picture ceiling drops from 24 to 12 on variation listings. */
export const GROUP_MAX_IMAGES = 12

export interface InventoryItemGroupArgs {
  groupKey: string
  variantSkus: string[]
  title: string
  descriptionHtml: string
  /** Shared photos for the listing shell; each variant's own hang on its item. */
  imageUrls: string[]
  /**
   * The listing-level item specifics, WITHOUT the varying aspect.
   *
   * Found the hard way against the live sandbox: required aspects like
   * Produktart sat on every variant item and the group publish still failed
   * with "Das Artikelmerkmal Produktart fehlt". For a variation listing eBay
   * reads the listing-level specifics from the *group*, not from the items —
   * the items only contribute the aspect the listing varies by.
   */
  aspects: Record<string, string[]>
  /** The aspect buyers pick a variant by, with every offered value. */
  variesBy: { aspect: string; values: string[] }
}

/**
 * Creates or replaces the inventory item group — the shell of a variation
 * listing.
 *
 * The group carries what all variants share (title, description, the common
 * photos) and `variesBy`, which is what renders the buyer's dropdown. Each
 * variant remains its own inventory item with its own SKU, aspects and photos;
 * `aspectsImageVariesBy` is what makes the gallery swap when the buyer picks a
 * colour. Like the item calls, this is a full replace.
 */
export async function putInventoryItemGroup(args: InventoryItemGroupArgs): Promise<void> {
  const body: Record<string, unknown> = {
    variantSKUs: args.variantSkus,
    title: args.title,
    description: args.descriptionHtml,
    imageUrls: args.imageUrls.slice(0, GROUP_MAX_IMAGES),
    aspects: args.aspects,
    variesBy: {
      specifications: [{ name: args.variesBy.aspect, values: args.variesBy.values }],
      aspectsImageVariesBy: [args.variesBy.aspect],
    },
  }
  try {
    await call(`/sell/inventory/v1/inventory_item_group/${encodeURIComponent(args.groupKey)}`, {
      method: 'PUT',
      body,
      contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
    })
  } catch (error) {
    fail(error, `Creating the eBay inventory item group "${args.groupKey}"`)
  }
}

/**
 * Publishes the whole group as ONE listing with a variant dropdown.
 *
 * The counterpart of `publishOffer` for variations, with the same two rules:
 * never retried (this is the moment fees attach), and on an already-live group
 * it *revises* — eBay keeps the listing id, so calling it again after changing
 * items, offers or the group itself is the supported way to update a live
 * variation listing.
 */
export async function publishOfferByInventoryItemGroup(groupKey: string): Promise<string> {
  try {
    const result = await call<{ listingId: string }>(
      '/sell/inventory/v1/offer/publish_by_inventory_item_group',
      {
        method: 'POST',
        body: { inventoryItemGroupKey: groupKey, marketplaceId: config.ebay.marketplaceId },
        contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
        maxAttempts: 1,
      },
    )
    if (!result?.listingId) throw new UserError('eBay published the group but returned no listingId.')
    return result.listingId
  } catch (error) {
    fail(error, `Publishing the eBay variation listing "${groupKey}"`)
  }
}

/**
 * Publishes the offer, making it a live listing.
 *
 * Not retried: a publish that half-succeeded and is retried can produce a
 * duplicate listing, which costs the seller fees and buyer confusion.
 */
export async function publishOffer(offerId: string): Promise<string> {
  try {
    const result = await call<{ listingId: string }>(
      `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      {
        method: 'POST',
        // eBay's reference says this method takes no additional headers, but it
        // rejects the call without the language pair all the same.
        contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
        maxAttempts: 1,
      },
    )
    if (!result?.listingId) throw new UserError('eBay published the offer but returned no listingId.')
    return result.listingId
  } catch (error) {
    fail(error, 'Publishing the eBay offer')
  }
}

export interface RemoteOffer {
  offerId: string
  sku: string
  status?: string
  marketplaceId?: string
  format?: string
  categoryId?: string
  listingDuration?: string
  availableQuantity?: number
  listingDescription?: string
  merchantLocationKey?: string
  pricingSummary?: { price?: { value?: string; currency?: string } }
  listing?: { listingId?: string; listingStatus?: string }
}

export interface RemoteInventoryItem {
  sku: string
  locale?: string
  product?: { title?: string; description?: string; aspects?: Record<string, string[]>; imageUrls?: string[] }
  availability?: { shipToLocationAvailability?: { quantity?: number } }
}

/**
 * Reads back what eBay actually stored.
 *
 * The language headers are sent on these reads too: without them eBay answers
 * with an error rather than the record, the same quirk as on the writes.
 */
export async function getOffer(offerId: string): Promise<RemoteOffer | undefined> {
  try {
    return await call<RemoteOffer>(`/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
      contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
    })
  } catch (error) {
    fail(error, `Reading eBay offer ${offerId}`)
  }
}

export async function getInventoryItem(sku: string): Promise<RemoteInventoryItem | undefined> {
  try {
    return await call<RemoteInventoryItem>(`/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      contentLanguage: contentLanguageFor(config.ebay.marketplaceId),
    })
  } catch (error) {
    fail(error, `Reading eBay inventory item ${sku}`)
  }
}

/** Seller Hub, where a listing shows up once the offer has been published. */
export function sellerHubUrl(): string {
  return config.ebay.env === 'sandbox'
    ? 'https://www.sandbox.ebay.de/sh/lst/active'
    : 'https://www.ebay.de/sh/lst/active'
}

export function listingUrl(listingId: string): string {
  const host = config.ebay.env === 'sandbox' ? 'sandbox.ebay.de' : 'ebay.de'
  return `https://www.${host}/itm/${listingId}`
}
