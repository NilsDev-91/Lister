import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../util/paths.js'
import { withFileLock, replaceFile } from '../../store/file-lock.js'
import { parseAspectSpecs, type AspectSpec } from './aspect-spec.js'

/**
 * Disk cache for per-category aspect metadata.
 *
 * Two decisions carry this file:
 *
 * **It stores the raw API response, not the parsed specs.** `parseAspectSpecs`
 * runs again on every read, so the parser stays the single source of truth and
 * a change to `AspectSpec` can never be misread out of an older file. Caching
 * the parsed shape is how a stale sub-object takes down everything that reads
 * it — the exact failure this project has already had once.
 *
 * **A cache is never worth an outage.** A missing file, an expired entry, a
 * corrupt one and an unreadable directory all resolve the same way: refetch.
 * Same trade `loadSettings` makes.
 */

const CACHE_DIR = join(DATA_DIR, 'ebay-aspects')

/** eBay announces required-aspect changes ahead of time via `expectedRequiredByDate`, so day-scale staleness is safe. */
export const TTL_DAYS = 7

export interface CacheEntry {
  fetchedAt: string
  response: unknown
}

export interface CachedAspects {
  specs: AspectSpec[]
  fetchedAt: string
}

/** Pure, so freshness can be tested without a clock or a filesystem. */
export function isFresh(entry: { fetchedAt: string }, now: Date, ttlDays = TTL_DAYS): boolean {
  const at = Date.parse(entry.fetchedAt)
  if (!Number.isFinite(at)) return false
  const ageDays = (now.getTime() - at) / 86_400_000
  // A negative age means a clock jump, not freshness worth trusting.
  return ageDays >= 0 && ageDays < ttlDays
}

/**
 * Sandbox and production category ids collide, and a long-running web server
 * can see more than one marketplace, so the key carries both.
 */
export function cacheKey(env: string, treeId: string, categoryId: string): string {
  return [env, treeId, categoryId].map((part) => part.replace(/[^a-zA-Z0-9_-]/g, '_')).join('-')
}

function pathFor(key: string): string {
  return join(CACHE_DIR, `${key}.json`)
}

/** Returns null for a miss, an expired entry, or anything unreadable. */
export function readAspectCache(key: string, now: Date, ttlDays = TTL_DAYS): CachedAspects | null {
  const path = pathFor(key)
  if (!existsSync(path)) return null

  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry
    if (typeof entry?.fetchedAt !== 'string') return null
    if (!isFresh(entry, now, ttlDays)) return null

    const specs = parseAspectSpecs(entry.response)
    return specs.length ? { specs, fetchedAt: entry.fetchedAt } : null
  } catch {
    return null
  }
}

/**
 * Reads an expired entry anyway.
 *
 * Used when a refetch fails: stale metadata is far better than none, because
 * "none" would turn every required aspect into an unverifiable blocker. The
 * caller is expected to downgrade its verdicts and name the date.
 */
export function readStaleAspectCache(key: string): CachedAspects | null {
  const path = pathFor(key)
  if (!existsSync(path)) return null
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as CacheEntry
    if (typeof entry?.fetchedAt !== 'string') return null
    const specs = parseAspectSpecs(entry.response)
    return specs.length ? { specs, fetchedAt: entry.fetchedAt } : null
  } catch {
    return null
  }
}

/** Best effort. A cache that cannot be written must not fail the command. */
export function writeAspectCache(key: string, response: unknown, now: Date): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
    const path = pathFor(key)
    const entry: CacheEntry = { fetchedAt: now.toISOString(), response }
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
