import { config } from '../config.js'
import { get, upsert } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import * as ebay from '../marketplaces/ebay/client.js'
import { planAspects, factsFromProduct, ASPECT_TARGET } from '../marketplaces/ebay/aspects.js'
import type { ListingRecord } from '../types.js'

/**
 * Works out which item specifics a listing should carry.
 *
 * Split from `publish` because it needs no user token, costs nothing and can be
 * run as often as you like: `suggestCategory` and the aspect metadata both go
 * over the **Taxonomy API with an application token** — a different dependency
 * from the Browse API the keyword research needs, and one that works today.
 */

export interface CategoryResolution {
  categoryId: string
  /** How it was decided, so the report can say. */
  source: 'given' | 'stored' | 'research' | 'suggested'
  name?: string | undefined
}

/**
 * One place where the eBay category is decided.
 *
 * Preflight and publish used to resolve it independently, which meant preflight
 * could validate against one category while publish listed into another.
 *
 * The research consensus outranks eBay's own suggestion on purpose: it is
 * measured from where ranked competitors actually sit, while `suggestCategory`
 * guesses from a phrase the copywriter invented.
 */
export async function resolveEbayCategory(
  listing: ListingRecord,
  override?: string | undefined,
): Promise<CategoryResolution> {
  if (override) return { categoryId: override, source: 'given' }
  if (listing.ebayCategoryId) return { categoryId: listing.ebayCategoryId, source: 'stored' }

  const consensus = listing.seo?.ebay?.categoryConsensus
  if (consensus) return { categoryId: consensus.id, source: 'research' }

  const suggestion = await ebay.suggestCategory(listing.copy.ebay.categoryHint || listing.copy.ebay.title)
  if (!suggestion) {
    throw new UserError(
      config.ebay.env === 'sandbox'
        ? 'Category lookup is unavailable in the eBay sandbox.'
        : `eBay suggested no category for "${listing.copy.ebay.categoryHint}".`,
      'Pass --category-id <id> once; it is stored on the listing and reused everywhere after that.',
    )
  }
  return { categoryId: suggestion.categoryId, source: 'suggested', name: suggestion.categoryName }
}

export interface AspectsOptions {
  id: string
  categoryId?: string | undefined
  refresh?: boolean
  io?: Io
}

export async function aspectsCommand(options: AspectsOptions): Promise<ListingRecord> {
  const io = options.io ?? terminalIo
  const listing = get(options.id)
  if (!listing) throw new UserError(`No listing with the id "${options.id}".`)

  const resolved = await resolveEbayCategory(listing, options.categoryId)
  io.step(`Category ${resolved.categoryId}${resolved.name ? ` — ${resolved.name}` : ''} (${resolved.source})`)

  const fetch = await ebay.getAspectSpecs(resolved.categoryId, { refresh: options.refresh ?? false })
  if (!fetch.specs.length) {
    throw new UserError(
      `Category ${resolved.categoryId} defines no item specifics.`,
      'It is probably not a leaf category. Pass a deeper one with --category-id.',
    )
  }
  io.detail(
    `${fetch.specs.length} item specific(s) defined, ${fetch.specs.filter((s) => s.required).length} required` +
      (fetch.stale ? ' — from a stale cache, eBay was unreachable' : ''),
  )

  const plan = planAspects({
    specs: fetch.specs,
    current: listing.copy.ebay.aspects,
    facets: listing.seo?.ebay?.aspectFacets,
    facts: factsFromProduct(listing.product),
    now: new Date(),
  })

  // Remember the category even when nothing else changes: resolving it is the
  // expensive part, and preflight and publish should not repeat the guess.
  let updated = listing
  if (listing.ebayCategoryId !== resolved.categoryId) {
    updated = { ...listing, ebayCategoryId: resolved.categoryId, updatedAt: new Date().toISOString() }
    upsert(updated)
  }

  io.step(`${plan.filled} item specific(s) planned (eBay's target is ${ASPECT_TARGET})`)
  for (const [name, values] of Object.entries(plan.aspects)) {
    io.info(`  ${name}: ${values.join(', ')}`)
  }

  const blockers = plan.findings.filter((f) => f.severity === 'blocker')
  const warnings = plan.findings.filter((f) => f.severity === 'warning')

  for (const finding of blockers) io.warn(`MISSING  ${finding.aspect} — ${finding.detail}`)
  for (const finding of warnings) io.warn(`${finding.aspect || 'Overall'} — ${finding.detail}`)
  for (const finding of plan.findings.filter((f) => f.severity === 'info')) {
    io.detail(`${finding.aspect} — ${finding.detail}`)
  }

  if (plan.suggestions.length) {
    io.step('Worth filling, most valuable first')
    for (const suggestion of plan.suggestions.slice(0, 12)) {
      const options_ = suggestion.options.slice(0, 6).map((o) => o.value).join(' · ')
      const searches = suggestion.searchCount ? `${suggestion.searchCount.toLocaleString('en-US')} searches` : 'no search data'
      io.info(
        `  ${suggestion.required ? '[required] ' : ''}${suggestion.name} (${searches})` +
          (options_ ? `\n      ${options_}` : ''),
      )
    }
  }

  io.info('Edit them in the web editor; publish sends the planned values, not the stored ones.')
  return updated
}
