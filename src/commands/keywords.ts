import { gate } from '../makerworld/license.js'
import { composeListingCopy } from '../ai/composer.js'
import { researchKeywords } from '../seo/research.js'
import { coverage, tagHygiene } from '../seo/coverage.js'
import { assessPrice, priceHint } from '../seo/price.js'
import { loadSettings } from '../settings.js'
import type { KeywordEvidence, SeoEvidence } from '../seo/types.js'
import { get, upsert } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import { diffCopy } from '../proposal.js'
import { renderProposal } from './proposal.js'
import type { ListingRecord, Marketplace } from '../types.js'

/**
 * Researches what buyers search for, then optionally rewrites the copy to match.
 *
 * Split from `create` on purpose. Research costs marketplace calls and depends
 * on credentials that may not exist yet, while creating a draft must keep
 * working offline from a saved page. Keeping them apart also means research can
 * be re-run on an old listing without regenerating everything about it.
 *
 * `--apply` is the only part that changes the copy, and it always shows the
 * before-and-after first. Silently rewriting a title the seller edited by hand
 * would be the wrong default.
 */

export interface KeywordsOptions {
  id: string
  marketplaces: Marketplace[]
  /**
   * Draft new copy against the fresh research.
   *
   * The draft is stored as a pending proposal, never applied here — see
   * `proposalCommand` for the accept-or-discard half.
   */
  rewrite: boolean
  /** Keep the designer credit line, as `create` does. */
  credit: boolean
  /** Bypass the research cache and query the marketplaces live. */
  fresh?: boolean
  io?: Io
}

export async function keywordsCommand(options: KeywordsOptions): Promise<ListingRecord> {
  const io = options.io ?? terminalIo
  const listing = get(options.id)
  if (!listing) throw new UserError(`No listing with the id "${options.id}".`)

  const evidence: SeoEvidence = { ebay: listing.seo?.ebay ?? null, etsy: listing.seo?.etsy ?? null }

  // One marketplace failing must not discard the other's results. eBay's Browse
  // API needs a production keyset and answers 403 without one, which is the
  // ordinary state of this project right now — and no reason to throw away a
  // completed Etsy run.
  const settings = loadSettings()
  const failures: string[] = []
  for (const marketplace of options.marketplaces) {
    try {
      evidence[marketplace] = await researchKeywords({
        listing,
        marketplace,
        io,
        perQuery: settings.researchSampleSize,
        buyerCountry: settings.etsyBuyerCountry || undefined,
        fresh: options.fresh,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const hint = error instanceof UserError && error.hint ? ` ${error.hint}` : ''
      failures.push(marketplace)
      io.warn(`${marketplace} research failed: ${message}${hint}`)
    }
  }

  if (failures.length === options.marketplaces.length && options.marketplaces.length > 0) {
    if (!evidence.ebay && !evidence.etsy) {
      throw new UserError(
        `Keyword research failed on ${failures.join(' and ')}.`,
        'Nothing was saved. The messages above say which credential each marketplace was missing.',
      )
    }
    io.warn('Keeping the previously saved research; nothing new was gathered.')
  }

  // Saved before any rewrite, so a failed or declined `--apply` still leaves
  // the research on the record rather than throwing away calls already spent.
  // Re-read first: the searches above run for minutes, and an upsert of the
  // stale snapshot would silently revert anything saved meanwhile (the same
  // lost update the web UI's image upload once had).
  let updated: ListingRecord = { ...(get(options.id) ?? listing), seo: evidence, updatedAt: new Date().toISOString() }
  upsert(updated)

  for (const marketplace of options.marketplaces) {
    reportMarketplace(updated, marketplace, evidence[marketplace], io)
  }

  if (!options.rewrite) {
    io.info('Draft new copy against this research with --rewrite.')
    return updated
  }

  io.step('Drafting new copy with Claude…')
  const decision = gate(updated.source.license, updated.licenseOverridden)
  const copy = await composeListingCopy({
    model: updated.source,
    product: updated.product,
    gate: decision,
    credit: options.credit,
    evidence,
  })

  const basedOn = (['ebay', 'etsy'] as const).filter((m) => evidence[m] !== null)

  // Stored, not applied. The seller decides in a separate step, and that step
  // applies this exact text rather than asking the model again. Re-read again:
  // the Claude call above holds the snapshot for half a minute.
  updated = {
    ...(get(options.id) ?? updated),
    proposal: { copy, createdAt: new Date().toISOString(), basedOn: [...basedOn] },
    updatedAt: new Date().toISOString(),
  }
  upsert(updated)

  io.info('')
  renderProposal(diffCopy(updated.copy, copy), [...basedOn], io)

  io.ok('Saved as a pending rewrite. Nothing has been changed yet.')
  io.info(`Accept it:  lister proposal ${options.id} --accept`)
  io.info(`Discard it: lister proposal ${options.id} --discard`)

  return updated
}

function reportMarketplace(
  listing: ListingRecord,
  marketplace: Marketplace,
  evidence: KeywordEvidence | null,
  io: Io,
): void {
  if (!evidence) return

  io.step(`${marketplace} — top phrases by opportunity`)
  for (const candidate of evidence.candidates.slice(0, 10)) {
    const competition = candidate.competition === null ? 'unmeasured' : `${candidate.competition.toLocaleString('en-US')} competing`
    const demand =
      candidate.demandPerDay === null ? 'no view data' : `${candidate.demandPerDay.toFixed(1)} views/day`
    const flag = candidate.usableAsTag ? '' : ' [too long for a tag]'
    io.info(`  ${candidate.phrase} — ${Math.round(candidate.rankerShare * 100)}% of rankers, ${competition}, ${demand}${flag}`)
  }

  if (evidence.categoryConsensus) {
    io.detail(
      `Most ranked listings sit in category ${evidence.categoryConsensus.id} ` +
        `(${Math.round(evidence.categoryConsensus.share * 100)}% of the sample).`,
    )
  }
  if (evidence.priceBandEur) {
    const verdict = assessPrice(listing.product.priceEur, evidence.priceBandEur)
    const say = verdict.notable ? io.warn : io.detail
    say(verdict.summary)
    const hint = priceHint(verdict)
    if (hint && verdict.notable) io.detail(hint)
  }
  for (const facet of evidence.aspectFacets.slice(0, 6)) {
    io.detail(`Buyers filter on ${facet.name}=${facet.value} (${facet.count.toLocaleString('en-US')} items).`)
  }

  reportCoverage(listing, marketplace, evidence, io)
}

/**
 * Compares the copy against the research it was supposed to use.
 *
 * Measured from the finished text rather than reported by the copywriter: a
 * model that ignored the research cannot claim otherwise here.
 */
function reportCoverage(
  listing: ListingRecord,
  marketplace: Marketplace,
  evidence: KeywordEvidence | null,
  io: Io,
): void {
  if (!evidence) return

  const isEtsy = marketplace === 'etsy'
  const title = isEtsy ? listing.copy.etsy.title : listing.copy.ebay.title
  const tags = isEtsy ? listing.copy.etsy.tags : []
  const result = coverage({ title, tags, evidence })

  io.detail(`${marketplace}: ${result.used.length} of the top recommendations are in the copy.`)
  if (result.missed.length) {
    io.detail(`Not used: ${result.missed.slice(0, 6).join(', ')}`)
  }

  if (!isEtsy) return

  const hygiene = tagHygiene(tags)
  if (hygiene.unusedSlots) {
    io.warn(`${hygiene.unusedSlots} of 13 Etsy tag slots are empty — unused reach, and they cost nothing.`)
  }
  // Capped: a listing whose tags all orbit one word produces a wall of these,
  // and the wall is harder to act on than the first few lines of it.
  for (const repeat of hygiene.repeated.slice(0, 3)) {
    io.warn(`${repeat.tags.length} tags share "${repeat.stem}": ${repeat.tags.slice(0, 5).join(', ')}`)
  }
  if (hygiene.repeated.length > 3) {
    io.detail(`…and ${hygiene.repeated.length - 3} more overlapping word(s).`)
  }
}

