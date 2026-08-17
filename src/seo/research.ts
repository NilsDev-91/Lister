import type { ListingRecord, Marketplace } from '../types.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import { lastRateLimit } from '../marketplaces/etsy/client.js'
import { searchEtsy } from './etsy-source.js'
import { searchEbay } from './ebay-source.js'
import { mine } from './mine.js'
import { followUpQueries, seedQueries } from './seed.js'
import type { KeywordEvidence, SearchResult } from './types.js'

/**
 * Runs keyword research for one listing on one marketplace.
 *
 * Two rounds, and the second one is not "more of the first". Round one asks
 * what the listings that already rank have in common. Round two takes the
 * strongest of those phrases and searches *them*, which is the only way to
 * learn how crowded each one is — `totalMatches` belongs to a query, not to a
 * phrase. Without round two every score rests on a neutral competition guess.
 *
 * Queries run one at a time on purpose. The rate limiters serialise them
 * anyway, and sequential progress is something a user can watch and interrupt.
 */

export interface ResearchArgs {
  listing: ListingRecord
  marketplace: Marketplace
  io?: Io
  /** Competitor listings sampled per query. */
  perQuery?: number
  /** 1 skips the competition round; scores then rest on the neutral default. */
  rounds?: number
  /**
   * Restrict Etsy results to shops delivering to this country.
   *
   * Off by default: Etsy copy here is English and aimed at an international
   * audience, so narrowing to one destination would mine the wrong market.
   */
  buyerCountry?: string | undefined
  /** Injected so a test can pin the clock; `daysListed` depends on it. */
  now?: Date
}

export async function researchKeywords(args: ResearchArgs): Promise<KeywordEvidence> {
  const io = args.io ?? terminalIo
  const { listing, marketplace } = args
  const now = args.now ?? new Date()
  const perQuery = args.perQuery ?? 50
  const rounds = args.rounds ?? 2

  const seeds = seedQueries({ listing, marketplace })
  if (!seeds.length) {
    throw new UserError(
      `Nothing to search for on ${marketplace}.`,
      'The draft copy has no multi-word phrase to seed from. Write a title first, then research.',
    )
  }

  const notes: string[] = []
  const results: SearchResult[] = []

  io.step(`Researching ${marketplace} keywords (${seeds.length} seed searches)`)

  for (const query of seeds) {
    const result = await runQuery({ query, marketplace, perQuery, now, notes, args })
    if (result) {
      results.push(result)
      io.detail(`"${query}" — ${result.listings.length} listings, ${formatCount(result.totalMatches)} competing`)
    } else {
      io.warn(`"${query}" — search failed, skipped`)
    }
  }

  if (!results.length) {
    throw new UserError(
      `Every ${marketplace} search failed.`,
      marketplace === 'ebay'
        ? 'The Browse API needs a production keyset; sandbox credentials return 403.'
        : 'Check ETSY_KEYSTRING and ETSY_SHARED_SECRET in .env.',
    )
  }

  const language = marketplace === 'ebay' ? 'de' : 'en'
  let evidence = mine({
    marketplace,
    language,
    results,
    generatedAt: now.toISOString(),
    notes,
  })

  if (rounds >= 2) {
    const followUps = followUpQueries(evidence.candidates, seeds)
    if (followUps.length) {
      io.step(`Measuring competition for ${followUps.length} candidate phrase(s)`)
      for (const query of followUps) {
        const result = await runQuery({ query, marketplace, perQuery, now, notes, args })
        if (result) {
          results.push(result)
          io.detail(`"${query}" — ${formatCount(result.totalMatches)} competing`)
        } else {
          io.warn(`"${query}" — search failed, competition unmeasured`)
        }
      }
      evidence = mine({
        marketplace,
        language,
        results,
        generatedAt: now.toISOString(),
        notes,
      })
    } else {
      notes.push('No follow-up searches ran; competition figures cover the seed queries only.')
    }
  }

  reportQuota(marketplace, io)

  const measured = evidence.candidates.filter((c) => c.competition !== null).length
  io.ok(
    `${evidence.candidates.length} candidates from ${evidence.sampleSize} listings ` +
      `(${measured} with a measured competition figure).`,
  )
  for (const note of evidence.notes) io.detail(note)

  return evidence
}

interface QueryArgs {
  query: string
  marketplace: Marketplace
  perQuery: number
  now: Date
  notes: string[]
  args: ResearchArgs
}

/**
 * One search, with failure contained.
 *
 * A single bad query — a phrase the marketplace rejects, a transient 500 — must
 * not discard the queries that already succeeded. It is recorded and skipped.
 */
async function runQuery(q: QueryArgs): Promise<SearchResult | null> {
  try {
    if (q.marketplace === 'etsy') {
      return await searchEtsy({
        query: q.query,
        limit: q.perQuery,
        buyerCountry: q.args.buyerCountry,
        nowMs: q.now.getTime(),
        notes: q.notes,
      })
    }
    return await searchEbay({ query: q.query, limit: q.perQuery })
  } catch (error) {
    q.notes.push(`Search for "${q.query}" failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function formatCount(total: number | null): string {
  return total === null ? 'an unknown number of' : total.toLocaleString('en-US')
}

/**
 * Reports what the run cost against the daily quota.
 *
 * Etsy's day is a sliding 24-hour window rather than a calendar day, so a
 * remaining count is a live figure and worth showing — it is what tells you
 * whether another research run is affordable right now.
 */
function reportQuota(marketplace: Marketplace, io: Io): void {
  if (marketplace !== 'etsy') return
  const limits = lastRateLimit()
  if (limits.remainingToday === null) return
  io.detail(`Etsy quota: ${limits.remainingToday}${limits.perDay ? `/${limits.perDay}` : ''} calls left today.`)
}
