import * as etsy from '../marketplaces/etsy/client.js'
import { matchTaxonomy } from './publish.js'
import { get, upsert } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import type { ListingRecord, Marketplace } from '../types.js'

/**
 * Takes one of the categories the research measured.
 *
 * Suggesting and taking are two steps for the same reason drafting and
 * publishing are: the category decides fees and required item specifics on
 * eBay, and where a listing is findable at all on Etsy. The research ranks;
 * the seller picks.
 *
 * The two marketplaces store the answer in different places, and neither is
 * new — eBay in `ebayCategoryId`, which preflight and publish already read,
 * Etsy in `copy.etsy.taxonomyHint`, which the publish path resolves through
 * `matchTaxonomy`. Nothing here invents a second way to say the same thing.
 */

export interface CategoryOptions {
  id: string
  marketplace: Marketplace
  /** 1-based position in the ranking the research produced. */
  use: number
  io?: Io
}

export async function categoryCommand(options: CategoryOptions): Promise<ListingRecord> {
  const io = options.io ?? terminalIo
  const listing = get(options.id)
  if (!listing) throw new UserError(`No listing with the id "${options.id}".`)

  const candidates = listing.seo?.[options.marketplace]?.categoryCandidates ?? []
  if (!candidates.length) {
    throw new UserError(
      `No researched categories for ${options.marketplace}.`,
      `Run: lister keywords ${options.id} -M ${options.marketplace}`,
    )
  }

  const chosen = candidates[options.use - 1]
  if (!chosen) {
    throw new UserError(
      `There is no option ${options.use} — the research offers ${candidates.length}.`,
      `Pick between 1 and ${candidates.length}.`,
    )
  }

  const updated =
    options.marketplace === 'ebay'
      ? takeForEbay(listing, chosen, io)
      : await takeForEtsy(listing, chosen, io)

  upsert(updated)
  return updated
}

type Candidate = { id: string; name: string | null; count: number; share: number }

function takeForEbay(listing: ListingRecord, chosen: Candidate, io: Io): ListingRecord {
  io.ok(`eBay category ${chosen.id}${chosen.name ? ` — ${chosen.name}` : ''}`)
  // Every category defines its own required item specifics, so the plan made
  // for the old one says nothing about this one. Preflight would catch it, but
  // only after the seller believed they were finished.
  io.warn(`Item specifics belong to a category — re-plan them: lister aspects ${listing.id}`)
  return { ...listing, ebayCategoryId: chosen.id, updatedAt: new Date().toISOString() }
}

/**
 * Etsy is stored as a name, not an id — and the name has to survive the trip.
 *
 * `taxonomyHint` is free text that `matchTaxonomy` resolves at publish time,
 * so writing a leaf name is only safe if that name resolves back to the node
 * it came from. Two categories can share a leaf name ("Ornaments" lives under
 * more than one root), and a silent mismatch here would list the item
 * somewhere the seller never chose. So: resolve it back immediately, and say
 * plainly when it lands somewhere else.
 */
async function takeForEtsy(listing: ListingRecord, chosen: Candidate, io: Io): Promise<ListingRecord> {
  const nodes = await etsy.listTaxonomyNodes()
  const node = nodes.find((n) => String(n.id) === chosen.id)
  if (!node) {
    throw new UserError(
      `Etsy no longer knows taxonomy ${chosen.id}.`,
      'Research the listing again; the taxonomy has moved since that run.',
    )
  }

  const hint = node.name
  const resolved = matchTaxonomy(nodes, hint)
  if (!resolved || resolved.id !== node.id) {
    throw new UserError(
      `"${hint}" does not resolve back to the category you picked (${node.path.join(' > ')}).`,
      resolved
        ? `It resolves to ${resolved.path.join(' > ')} instead. Set the category by editing the Etsy category hint by hand.`
        : 'Set the category by editing the Etsy category hint by hand.',
    )
  }

  io.ok(`Etsy category: ${node.path.join(' > ')}`)
  if (!node.leaf) {
    io.warn('This category has sub-categories. Etsy rewards the most specific one; a deeper pick ranks better.')
  }

  return {
    ...listing,
    copy: { ...listing.copy, etsy: { ...listing.copy.etsy, taxonomyHint: hint } },
    updatedAt: new Date().toISOString(),
  }
}
