import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { ListingRecordSchema, type ListingRecord } from '../types.js'
import type { SearchResult } from './types.js'

/**
 * Pins the cache behaviour of a research run: a repeated run must not spend
 * marketplace calls again within the TTL, and `--fresh` must bypass exactly
 * that. The marketplace itself is mocked — what is under test is when it gets
 * asked, not what it answers.
 */

const searchEtsy = vi.fn()

vi.mock('./etsy-source.js', () => ({
  searchEtsy: (...args: unknown[]) => searchEtsy(...args),
}))

/**
 * The Etsy client is mocked too, and not only for tidiness: an Etsy run now
 * resolves its category ids into names through `listTaxonomyNodes`, which is a
 * real HTTP call. Without this the cache tests reached the internet — and a
 * test that needs the network is a bug in the test.
 */
vi.mock('../marketplaces/etsy/client.js', () => ({
  listTaxonomyNodes: async () => [
    { id: 1, name: 'Home & Living', path: ['Home & Living'], leaf: false, level: 0 },
    { id: 68887482, name: 'Dart Equipment', path: ['Sport', 'Dart Equipment'], leaf: true, level: 1 },
  ],
  lastRateLimit: () => ({ remainingToday: null, perDay: null }),
}))

const dir = mkdtempSync(join(tmpdir(), 'lister-research-'))

beforeAll(() => {
  process.env['LISTER_DATA_DIR'] = dir
})

afterAll(() => {
  delete process.env['LISTER_DATA_DIR']
  rmSync(dir, { recursive: true, force: true })
})

const NOW = new Date('2026-08-17T12:00:00.000Z')

/** Copy tuned so the etsy seeds are exactly one two-word query: "dart holder". */
function listing(): ListingRecord {
  const now = NOW.toISOString()
  return ListingRecordSchema.parse({
    id: 'mw-1-abc',
    sourceUrl: 'https://makerworld.com/en/models/1',
    source: {
      sourceUrl: 'https://makerworld.com/en/models/1',
      externalId: '1',
      title: 'Dart Holder',
      description: '',
      designer: 'OMMO',
      tags: [],
      images: [],
      license: { raw: 'BY', code: 'CC-BY-4.0', commercialUse: 'yes', reason: 'ok' },
      fetchedAt: now,
    },
    product: {
      priceEur: 20.99,
      quantity: 1,
      material: 'PLA',
      colour: 'Schwarz',
      dimensionsMm: null,
      weightGrams: null,
      processingDays: 3,
      notes: '',
    },
    copy: {
      ebay: {
        title: 'Dartpfeilhalter',
        descriptionHtml: '<p>Von mir gedruckt.</p>',
        categoryHint: 'Dart',
        aspects: {},
      },
      etsy: {
        title: 'Dartholder',
        description: 'Printed by me.',
        tags: ['dart holder'],
        materials: ['PLA'],
        taxonomyHint: 'Decor',
      },
    },
    imagePaths: [],
    imageUrls: [],
    licenseOverridden: false,
    marketplaces: [],
    createdAt: now,
    updatedAt: now,
  })
}

/**
 * Fourteen comparable listings, not the two this started with.
 *
 * The count is load-bearing since the relevance floor exists: below
 * MIN_COMPARABLE a run withholds its candidates. These tests are about *when
 * the marketplace gets called*, not about whether a two-listing sample may
 * carry a conclusion — that question belongs to `relevance.test.ts`.
 */
function searchAnswer(): SearchResult {
  return {
    query: 'dart holder',
    totalMatches: 1611,
    listings: Array.from({ length: 14 }, (_, i) => ({
      id: String(i + 1),
      title: i % 2 ? 'Dart Holder Stand' : 'Dart Holder Wall Mount',
      tags: ['dart holder'],
      materials: [],
      priceEur: 12.5 + i,
      views: 80 + i * 5,
      favourites: 1,
      daysListed: 90 + i,
      kind: 'physical' as const,
      categoryId: '1',
      categoryName: null,
      url: null,
    })),
    aspectFacets: [],
  }
}

describe('researchKeywords and the cache', () => {
  it('spends live calls once, then answers repeat runs from disk', async () => {
    const { researchKeywords } = await import('./research.js')
    searchEtsy.mockResolvedValue(searchAnswer())

    const first = await researchKeywords({
      listing: listing(),
      marketplace: 'etsy',
      rounds: 1,
      now: NOW,
    })
    expect(searchEtsy).toHaveBeenCalledTimes(1)
    expect(first.candidates.length).toBeGreaterThan(0)

    const second = await researchKeywords({
      listing: listing(),
      marketplace: 'etsy',
      rounds: 1,
      now: NOW,
    })
    // No new marketplace call — the answer came from disk…
    expect(searchEtsy).toHaveBeenCalledTimes(1)
    // …and says so, because a cached figure presented as live would be a lie.
    expect(second.notes.some((n) => n.includes('research cache'))).toBe(true)
    expect(second.candidates).toEqual(first.candidates)
  })

  it('bypasses the cache when fresh is set', async () => {
    const { researchKeywords } = await import('./research.js')
    searchEtsy.mockResolvedValue(searchAnswer())

    await researchKeywords({
      listing: listing(),
      marketplace: 'etsy',
      rounds: 1,
      fresh: true,
      now: NOW,
    })
    expect(searchEtsy).toHaveBeenCalledTimes(2)
  })

  it('a failed live search stays failed rather than poisoning the cache', async () => {
    const { researchKeywords } = await import('./research.js')
    searchEtsy.mockRejectedValueOnce(new Error('etsy is down'))

    // fresh:true forces the live path; the failure must not write an entry.
    await expect(
      researchKeywords({ listing: listing(), marketplace: 'etsy', rounds: 1, fresh: true, now: NOW }),
    ).rejects.toThrow(/Every etsy search failed/)

    // The next fresh run hits the marketplace again and recovers.
    searchEtsy.mockResolvedValue(searchAnswer())
    const recovered = await researchKeywords({
      listing: listing(),
      marketplace: 'etsy',
      rounds: 1,
      fresh: true,
      now: NOW,
    })
    expect(recovered.candidates.length).toBeGreaterThan(0)
  })
})
