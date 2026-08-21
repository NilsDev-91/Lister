import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { SearchResult } from './types.js'

/**
 * The data dir is read at module load, so `LISTER_DATA_DIR` has to be set
 * before the module under test is imported — hence NO static import of
 * `research-cache.js` anywhere in this file, only the dynamic ones below.
 * The first version of this file broke that rule for the pure helpers and the
 * disk tests silently wrote a fabricated "dart holder" result into the REAL
 * `~/.3d-print-lister/research-cache`, where a live keywords run would have
 * served it as market evidence. Same trap `db.corrupt.test.ts` documents.
 */

const NOW = new Date('2026-08-17T12:00:00.000Z')

type CacheModule = typeof import('./research-cache.js')

const dir = mkdtempSync(join(tmpdir(), 'lister-research-cache-'))
let cache: CacheModule

beforeAll(async () => {
  process.env['LISTER_DATA_DIR'] = dir
  cache = await import('./research-cache.js')
})

afterAll(() => {
  delete process.env['LISTER_DATA_DIR']
  rmSync(dir, { recursive: true, force: true })
})

describe('isFresh', () => {
  it('accepts an entry younger than the TTL', () => {
    expect(cache.isFresh({ fetchedAt: '2026-08-17T11:00:00.000Z' }, NOW, 24)).toBe(true)
  })

  it('rejects an entry older than the TTL', () => {
    expect(cache.isFresh({ fetchedAt: '2026-08-16T11:59:00.000Z' }, NOW, 24)).toBe(false)
  })

  it('rejects a future timestamp — a clock jump is not freshness', () => {
    expect(cache.isFresh({ fetchedAt: '2026-08-18T12:00:00.000Z' }, NOW, 24)).toBe(false)
  })

  it('rejects garbage timestamps', () => {
    expect(cache.isFresh({ fetchedAt: 'not a date' }, NOW, 24)).toBe(false)
  })
})

describe('cacheKey', () => {
  it('is stable for identical parameters', () => {
    const a = cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 50 })
    const b = cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 50 })
    expect(a).toBe(b)
  })

  it('differs when any parameter differs', () => {
    const base = cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 50 })
    expect(cache.cacheKey({ marketplace: 'ebay', query: 'dart holder', limit: 50 })).not.toBe(base)
    expect(cache.cacheKey({ marketplace: 'etsy', query: 'dart stand', limit: 50 })).not.toBe(base)
    expect(cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 25 })).not.toBe(base)
    expect(
      cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 50, buyerCountry: 'DE' }),
    ).not.toBe(base)
  })

  it('does not collide for queries that sanitise to the same slug', () => {
    const a = cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 50 })
    const b = cache.cacheKey({ marketplace: 'etsy', query: 'dart-holder', limit: 50 })
    expect(a).not.toBe(b)
  })

  it('produces a safe filename for queries with umlauts and symbols', () => {
    const key = cache.cacheKey({ marketplace: 'ebay', query: 'dartpfeilhalter für wände & türen', limit: 50 })
    expect(key).toMatch(/^[a-zA-Z0-9_-]+$/)
  })
})

describe('disk roundtrip', () => {
  const result: SearchResult = {
    query: 'dart holder',
    totalMatches: 1611,
    listings: [
      {
        id: '42',
        title: 'Dart Holder Wall Mount',
        tags: ['dart holder'],
        materials: ['PLA'],
        priceEur: 14.9,
        views: 120,
        favourites: 3,
        daysListed: 200,
        kind: 'physical',
        categoryId: '68887482',
        categoryName: 'Dart Equipment',
        url: null,
      },
    ],
    aspectFacets: [],
  }

  it('returns what was written, re-validated through the schema', async () => {
    const cache = await import('./research-cache.js')
    const key = cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 50 })
    cache.writeSearchCache(key, result, NOW)

    const hit = cache.readSearchCache(key, NOW)
    expect(hit).not.toBeNull()
    expect(hit!.result).toEqual(result)
    expect(hit!.fetchedAt).toBe(NOW.toISOString())
  })

  it('misses once the TTL has passed', async () => {
    const cache = await import('./research-cache.js')
    const key = cache.cacheKey({ marketplace: 'etsy', query: 'dart holder', limit: 50 })
    const later = new Date(NOW.getTime() + 25 * 3_600_000)
    expect(cache.readSearchCache(key, later)).toBeNull()
  })

  it('treats a corrupt file as a miss, not an error', async () => {
    const cache = await import('./research-cache.js')
    const key = cache.cacheKey({ marketplace: 'etsy', query: 'corrupt entry', limit: 50 })
    mkdirSync(join(dir, 'research-cache'), { recursive: true })
    writeFileSync(join(dir, 'research-cache', `${key}.json`), '{ not json', 'utf8')
    expect(cache.readSearchCache(key, NOW)).toBeNull()
  })

  it('treats a schema mismatch as a miss — an old shape must refetch, never misparse', async () => {
    const cache = await import('./research-cache.js')
    const key = cache.cacheKey({ marketplace: 'etsy', query: 'old shape', limit: 50 })
    writeFileSync(
      join(dir, 'research-cache', `${key}.json`),
      JSON.stringify({ fetchedAt: NOW.toISOString(), result: { query: 'old shape', listings: [{ id: 7 }] } }),
      'utf8',
    )
    expect(cache.readSearchCache(key, NOW)).toBeNull()
  })
})

describe('dead-entry sweep', () => {
  const swept: SearchResult = { query: 'x', totalMatches: 1, listings: [], aspectFacets: [] }

  it('a later write removes expired entries and key-change orphans', async () => {
    const keyOld = cache.cacheKey({ marketplace: 'etsy', query: 'orphaned entry', limit: 50 })
    cache.writeSearchCache(keyOld, swept, NOW)

    // 25 h later a different query writes — the sweep must take the stale
    // entry with it, because nothing will ever read it again.
    const later = new Date(NOW.getTime() + 25 * 3_600_000)
    const keyNew = cache.cacheKey({ marketplace: 'etsy', query: 'fresh entry', limit: 50 })
    cache.writeSearchCache(keyNew, swept, later)

    const { readdirSync } = await import('node:fs')
    const files = readdirSync(join(dir, 'research-cache'))
    expect(files.some((f) => f.includes('orphaned_entry'))).toBe(false)
    expect(files.some((f) => f.includes('fresh_entry'))).toBe(true)
    expect(cache.readSearchCache(keyNew, later)).not.toBeNull()
  })
})
