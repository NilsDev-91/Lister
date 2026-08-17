import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DATA_DIR } from '../util/paths.js'
import { withFileLock, replaceFile } from '../store/file-lock.js'
import { SearchResultSchema, type SearchResult } from './types.js'

/**
 * Disk cache for marketplace search results.
 *
 * Research costs real quota — ~7 calls per marketplace per listing against
 * Etsy's 10,000/day — and most of those calls repeat: a `--rewrite` after a
 * first look, a second listing in the same niche, a run aborted halfway. The
 * market does not move between those runs, so the calls buy nothing twice.
 *
 * Two decisions are inherited from `ebay/aspect-cache.ts`, for the same
 * reasons:
 *
 * **Every read is re-validated against `SearchResultSchema`.** A cached entry
 * an older version wrote can never be misread by a newer schema — it fails
 * validation and counts as a miss, which resolves as a refetch. This is the
 * property that cost a `listings.json` on 2026-08-14.
 *
 * **A cache is never worth an outage.** Missing file, expired entry, corrupt
 * JSON, unwritable directory: all of them mean "search live", silently.
 *
 * One knowing trade: `daysListed` inside a cached result is frozen at fetch
 * time. Within the 24 h TTL the drift stays under a day, which cannot move a
 * listing across the 7-day threshold that gates the demand statistics by more
 * than the daily tabulation lag Etsy has anyway.
 */

const CACHE_DIR = join(DATA_DIR, 'research-cache')

/**
 * Market figures drift on the scale of weeks; the quota resets on a sliding
 * 24-hour window. One day keeps repeat runs free while the figures are still
 * honest, and `--fresh` exists for the moments they must be live.
 */
export const TTL_HOURS = 24

export interface CacheEntry {
  fetchedAt: string
  result: unknown
  /**
   * Sample-limitation notes the live search recorded (truncated batch, detail
   * fallback). Cached alongside the result because a repeat run that dropped
   * them would overwrite the stored evidence with a version in which a
   * shortened sample reads exactly like a complete one.
   */
  notes?: unknown
}

export interface CachedSearch {
  result: SearchResult
  notes: string[]
  fetchedAt: string
}

/** Pure, so freshness can be tested without a clock or a filesystem. */
export function isFresh(entry: { fetchedAt: string }, now: Date, ttlHours = TTL_HOURS): boolean {
  const at = Date.parse(entry.fetchedAt)
  if (!Number.isFinite(at)) return false
  const ageHours = (now.getTime() - at) / 3_600_000
  // A negative age means a clock jump, not freshness worth trusting.
  return ageHours >= 0 && ageHours < ttlHours
}

/**
 * The key carries every parameter that changes what a search returns —
 * including the eBay marketplace id, which the Browse API selects via the
 * `X-EBAY-C-MARKETPLACE-ID` header: without it in the key, switching
 * `EBAY_MARKETPLACE_ID` would serve German totals as evidence for another
 * market, indistinguishable from a live answer.
 *
 * The query text goes in twice: once sanitised for a human scanning the cache
 * directory, once hashed so "dart holder" and "dart-holder" — identical after
 * sanitising — cannot collide into one file.
 */
export function cacheKey(args: {
  marketplace: string
  query: string
  limit: number
  buyerCountry?: string | undefined
  /** eBay only: the marketplace the Browse header selects. */
  marketplaceId?: string | undefined
}): string {
  const canonical = JSON.stringify([
    args.marketplace,
    args.query,
    args.limit,
    args.buyerCountry ?? '',
    args.marketplaceId ?? '',
  ])
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  const slug = args.query.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
  return `${args.marketplace}-${slug}-${hash}`
}

function pathFor(key: string): string {
  return join(CACHE_DIR, `${key}.json`)
}

/** Returns null for a miss, an expired entry, or anything unreadable. */
export function readSearchCache(key: string, now: Date, ttlHours = TTL_HOURS): CachedSearch | null {
  const path = pathFor(key)
  if (!existsSync(path)) return null

  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry
    if (typeof entry?.fetchedAt !== 'string') return null
    if (!isFresh(entry, now, ttlHours)) return null

    const notes = Array.isArray(entry.notes) ? entry.notes.filter((n): n is string => typeof n === 'string') : []
    return { result: SearchResultSchema.parse(entry.result), notes, fetchedAt: entry.fetchedAt }
  } catch {
    return null
  }
}

/** Best effort. A cache that cannot be written must not fail the research. */
export function writeSearchCache(key: string, result: SearchResult, now: Date, notes: string[] = []): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
    const path = pathFor(key)
    const entry: CacheEntry = { fetchedAt: now.toISOString(), result, notes }
    // Locked and rename-replaced like every other write here: the CLI and the
    // web server run at the same time.
    withFileLock(path, () => {
      const tmp = `${path}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 })
      replaceFile(tmp, path)
    })
  } catch {
    // Ignored on purpose.
  }
}
