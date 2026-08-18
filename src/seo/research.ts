import type { ListingRecord, Marketplace } from '../types.js'
import { config } from '../config.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import { lastRateLimit } from '../marketplaces/etsy/client.js'
import { searchEtsy } from './etsy-source.js'
import { searchEbay } from './ebay-source.js'
import { mine } from './mine.js'
import { followUpQueries, seedQueries } from './seed.js'
import { cacheKey, readSearchCache, writeSearchCache, TTL_HOURS } from './research-cache.js'
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
   * DE by default now: the shop ships within Germany only (packaging law), so
   * the competition that matters is the one a German buyer actually sees.
   * Shops that do not deliver here are not competitors. This inverts the old
   * default, which was off because the copy used to be English.
   */
  buyerCountry?: string | undefined
  /** Bypass the research cache and query the marketplaces live. */
  fresh?: boolean
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
  const stats = { cached: 0, live: 0 }

  io.step(`Researching ${marketplace} keywords (${seeds.length} seed searches)`)

  for (const query of seeds) {
    const result = await runQuery({ query, marketplace, perQuery, now, notes, stats, args })
    if (result) {
      results.push(result.result)
      const from = result.cached ? ' (cache)' : ''
      io.detail(
        `"${query}" — ${result.result.listings.length} listings, ${formatCount(result.result.totalMatches)} competing${from}`,
      )
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

  // German on both marketplaces. The seeds come from the draft copy, which is
  // German everywhere since the shop ships to Germany only — so Etsy research
  // now measures the German-language competition a German listing actually
  // faces. It is a smaller sample than the English side would give; that is
  // the correct market, not a worse one. Matches ETSY_LANGUAGE in ai/composer.
  const language = 'de'
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
        const result = await runQuery({ query, marketplace, perQuery, now, notes, stats, args })
        if (result) {
          results.push(result.result)
          const from = result.cached ? ' (cache)' : ''
          io.detail(`"${query}" — ${formatCount(result.result.totalMatches)} competing${from}`)
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
      // Appended to the evidence, not to `notes` — mine() has already copied
      // that array, so a push there silently vanished (same trap as the
      // cache note below; a limitation nobody sees reads like a complete run).
      evidence = {
        ...evidence,
        notes: [...evidence.notes, 'No follow-up searches ran; competition figures cover the seed queries only.'],
      }
    }
  }

  // Appended to the mined evidence, not to `notes`: `mine` has already copied
  // that array into the result by now, and a note pushed after the copy would
  // silently vanish. A cached figure presented as live would be a lie.
  if (stats.cached > 0) {
    evidence = {
      ...evidence,
      notes: [
        ...evidence.notes,
        `${stats.cached} of ${stats.cached + stats.live} searches came from the local research cache ` +
          `(entries live ${TTL_HOURS} h); run with --fresh for live figures.`,
      ],
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
  stats: { cached: number; live: number }
  args: ResearchArgs
}

/**
 * One search, with failure contained.
 *
 * A single bad query — a phrase the marketplace rejects, a transient 500 — must
 * not discard the queries that already succeeded. It is recorded and skipped.
 *
 * The cache sits here rather than inside the sources because this is the one
 * spot both marketplaces and both rounds pass through — and because a cached
 * answer must be indistinguishable in shape from a live one, which re-parsing
 * through `SearchResultSchema` on read guarantees.
 */
async function runQuery(q: QueryArgs): Promise<{ result: SearchResult; cached: boolean } | null> {
  const key = cacheKey({
    marketplace: q.marketplace,
    query: q.query,
    limit: q.perQuery,
    buyerCountry: q.marketplace === 'etsy' ? q.args.buyerCountry : undefined,
    marketplaceId: q.marketplace === 'ebay' ? config.ebay.marketplaceId : undefined,
  })

  if (!q.args.fresh) {
    const hit = readSearchCache(key, q.now)
    if (hit) {
      q.stats.cached++
      // Replayed, not dropped: a truncated-sample note recorded by the live
      // run still applies to the cached copy of that sample.
      q.notes.push(...hit.notes)
      return { result: hit.result, cached: true }
    }
  }

  // The sources push sample-limitation notes into `q.notes` as they run; the
  // slice of new entries belongs to this query and is cached with it.
  const notesBefore = q.notes.length
  try {
    let result: SearchResult
    if (q.marketplace === 'etsy') {
      result = await searchEtsy({
        query: q.query,
        limit: q.perQuery,
        buyerCountry: q.args.buyerCountry,
        nowMs: q.now.getTime(),
        notes: q.notes,
      })
    } else {
      result = await searchEbay({ query: q.query, limit: q.perQuery })
    }
    q.stats.live++
    writeSearchCache(key, result, q.now, q.notes.slice(notesBefore))
    return { result, cached: false }
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
