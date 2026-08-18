import { gate } from '../makerworld/license.js'
import { proposeTitleOptions } from '../ai/composer.js'
import { get, upsert } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import { EbayCopySchema, EtsyCopySchema, type ListingRecord, type Marketplace } from '../types.js'

/**
 * Offers several titles and applies the one the seller picks.
 *
 * Applied directly rather than through the proposal state, and that is not an
 * inconsistency: a proposal is a rewrite the seller has not seen, while picking
 * option three is the decision itself. Routing an explicit choice through a
 * second confirmation would be ceremony.
 */

export interface TitlesOptions {
  id: string
  /** 1-based index into the stored options. Omitted means "generate and show". */
  use?: number | undefined
  /** Which marketplace the pick applies to. Required with `use`. */
  marketplace?: Marketplace | undefined
  credit: boolean
  io?: Io
}

export async function titlesCommand(options: TitlesOptions): Promise<ListingRecord> {
  const io = options.io ?? terminalIo
  const listing = get(options.id)
  if (!listing) throw new UserError(`No listing with the id "${options.id}".`)

  if (options.use !== undefined) return applyChoice(listing, options, io)

  io.step('Asking Claude for title options…')
  const result = await proposeTitleOptions({
    model: listing.source,
    product: listing.product,
    gate: gate(listing.source.license, listing.licenseOverridden),
    credit: options.credit,
    evidence: listing.seo,
    current: { ebay: listing.copy.ebay.title, etsy: listing.copy.etsy.title },
  })

  if (!result.ebay.length && !result.etsy.length) {
    throw new UserError(
      'Claude returned no usable titles.',
      result.rejected ? `${result.rejected} broke a marketplace rule and were dropped.` : undefined,
    )
  }

  // Re-read before writing: the Claude call above held the snapshot for half
  // a minute, and upserting it whole would silently revert anything the web
  // UI saved meanwhile.
  const updated: ListingRecord = {
    ...(get(options.id) ?? listing),
    titleOptions: { ebay: result.ebay, etsy: result.etsy, createdAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  }
  upsert(updated)

  show(updated, io)
  if (result.rejected) {
    io.detail(`${result.rejected} option(s) broke a marketplace rule and were dropped.`)
  }
  io.info(`Pick one with: lister titles ${options.id} --use <n> -M <ebay|etsy>`)

  return updated
}

function show(listing: ListingRecord, io: Io): void {
  for (const marketplace of ['ebay', 'etsy'] as const) {
    const options = listing.titleOptions?.[marketplace] ?? []
    const limit = marketplace === 'ebay' ? 80 : 140
    io.step(`${marketplace} — current (${listing.copy[marketplace].title.length}/${limit})`)
    io.detail(`  ${listing.copy[marketplace].title}`)
    if (!options.length) {
      io.warn('  no usable options')
      continue
    }
    for (const [index, title] of options.entries()) {
      io.info(`  ${index + 1}. (${title.length}/${limit}) ${title}`)
    }
  }
}

function applyChoice(listing: ListingRecord, options: TitlesOptions, io: Io): ListingRecord {
  const marketplace = options.marketplace
  if (!marketplace) {
    throw new UserError('--use needs a marketplace.', 'Add -M ebay or -M etsy.')
  }

  const available = listing.titleOptions?.[marketplace] ?? []
  if (!available.length) {
    throw new UserError(
      `No stored ${marketplace} title options.`,
      `Generate some with \`lister titles ${options.id}\`.`,
    )
  }

  const title = available[options.use! - 1]
  if (!title) {
    throw new UserError(`There is no option ${options.use}; ${available.length} are available.`)
  }

  // Validated through the same schema the editor and the publish path use, so a
  // stored option cannot smuggle in a title that has since become invalid.
  const copy =
    marketplace === 'ebay'
      ? { ...listing.copy, ebay: EbayCopySchema.parse({ ...listing.copy.ebay, title }) }
      : { ...listing.copy, etsy: EtsyCopySchema.parse({ ...listing.copy.etsy, title }) }

  const updated: ListingRecord = { ...listing, copy, updatedAt: new Date().toISOString() }
  upsert(updated)

  io.ok(`${marketplace} title set.`)
  io.detail(`  ${title}`)
  return updated
}
