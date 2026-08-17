import { get, upsert } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import { ListingCopySchema, type ListingRecord, type Marketplace } from '../types.js'
import { changedMarketplaces, diffCopy, mergeCopy, type CopyField } from '../proposal.js'

/**
 * Reviews, accepts or discards a stored rewrite.
 *
 * Separate from `keywords` on purpose. Generating a proposal costs an API call
 * and touches nothing; accepting one replaces text the seller may have edited
 * by hand. Those are different decisions and they should not share a flag.
 */

export interface ProposalOptions {
  id: string
  /** Marketplaces to accept. `null` shows the comparison and changes nothing. */
  accept: Marketplace[] | null
  discard: boolean
  io?: Io
}

export async function proposalCommand(options: ProposalOptions): Promise<ListingRecord> {
  const io = options.io ?? terminalIo
  const listing = get(options.id)
  if (!listing) throw new UserError(`No listing with the id "${options.id}".`)

  const proposal = listing.proposal
  if (!proposal) {
    throw new UserError(
      `Listing ${options.id} has no pending rewrite.`,
      'Produce one with `lister keywords <id> --rewrite`.',
    )
  }

  const fields = diffCopy(listing.copy, proposal.copy)

  if (options.discard) {
    const cleared: ListingRecord = { ...listing, proposal: null, updatedAt: new Date().toISOString() }
    upsert(cleared)
    io.ok('Rewrite discarded. The listing is unchanged.')
    return cleared
  }

  if (!options.accept) {
    renderProposal(fields, proposal.basedOn, io)
    io.info('Accept it with `lister proposal <id> --accept`, or drop it with --discard.')
    return listing
  }

  const touched = changedMarketplaces(fields)
  const accepting = options.accept.filter((m) => touched.includes(m))
  if (!accepting.length) {
    io.warn(
      touched.length
        ? `Nothing to accept for ${options.accept.join(' and ')}; the rewrite only changes ${touched.join(' and ')}.`
        : 'The rewrite is identical to the current copy.',
    )
    return listing
  }

  // Validated again on the way in. The proposal was checked when it was
  // generated, but it has been sitting in a file since, and the schemas are
  // what stand between a bad value and an opaque marketplace 400.
  const merged = ListingCopySchema.parse(mergeCopy(listing.copy, proposal.copy, accepting))

  // A partially accepted proposal is spent either way: what remains is the half
  // the seller declined, and keeping it would offer that rejection back.
  const updated: ListingRecord = {
    ...listing,
    copy: merged,
    proposal: null,
    updatedAt: new Date().toISOString(),
  }
  upsert(updated)

  io.ok(`Applied the rewrite for ${accepting.join(' and ')}.`)
  const declined = touched.filter((m) => !accepting.includes(m))
  if (declined.length) io.detail(`Left ${declined.join(' and ')} untouched, and dropped that half of the rewrite.`)

  return updated
}

/** Shared with `keywords --rewrite`, so both surfaces show one comparison. */
export function renderProposal(fields: CopyField[], basedOn: Marketplace[], io: Io): void {
  io.step('Pending rewrite')
  io.detail(
    basedOn.length
      ? `Written against ${basedOn.join(' and ')} research.`
      : 'Written against no research at all — the model had only the listing facts.',
  )

  for (const field of fields) {
    if (!field.changed) {
      io.detail(`${field.label}: unchanged`)
      continue
    }
    const counts = field.limit ? ` (${field.before.length} → ${field.after.length} of ${field.limit})` : ''
    io.info(`${field.label}${counts}`)
    if (field.multiline) {
      io.detail('  before:')
      for (const line of field.before.split('\n')) io.detail(`    ${line}`)
      io.detail('  after:')
      for (const line of field.after.split('\n')) io.detail(`    ${line}`)
    } else {
      io.detail(`  before: ${field.before}`)
      io.detail(`  after:  ${field.after}`)
    }
  }

  const touched = changedMarketplaces(fields)
  if (!touched.length) io.warn('The rewrite is identical to the current copy.')
}
