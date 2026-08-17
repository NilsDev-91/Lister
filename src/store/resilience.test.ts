import { describe, it, expect } from 'vitest'
import { ListingRecordSchema } from '../types.js'

/**
 * How a stored record survives a schema change.
 *
 * This is a regression guard for a real incident: `priceBandEur` gained three
 * required fields, a saved record still carried the old three-field shape, and
 * the store's validation guard moved the user's entire listings.json aside —
 * losing access to the listing, its images and its marketplace state over a
 * derived statistic that one command would have rebuilt.
 *
 * The rule that came out of it: derived fields degrade to null, authored fields
 * fail loudly. Both halves are pinned here, because a `.catch()` applied one
 * field too far would silently discard work that cannot be recovered.
 */

const now = '2026-08-14T00:00:00.000Z'

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mw-1-abc',
    sourceUrl: 'https://makerworld.com/en/models/1',
    source: {
      sourceUrl: 'https://makerworld.com/en/models/1',
      designId: '1',
      title: 'Dart Holder',
      description: '',
      designer: 'OMMO',
      tags: [],
      images: [],
      license: { raw: 'CC BY 4.0', code: 'CC-BY-4.0', commercialUse: 'yes', reason: 'ok' },
      fetchedAt: now,
    },
    product: {
      priceEur: 20.99,
      quantity: 1,
      material: 'PLA',
      colour: 'black',
      dimensionsMm: null,
      weightGrams: null,
      processingDays: 3,
      notes: '',
    },
    copy: {
      ebay: { title: 'Dartshalter', descriptionHtml: '<p>x</p>', categoryHint: 'Deko', aspects: {} },
      etsy: {
        title: 'Dart Holder',
        description: 'x',
        tags: [],
        materials: [],
        taxonomyHint: 'Home Decor',
      },
    },
    imagePaths: ['/tmp/a.jpg'],
    imageUrls: ['https://cdn.example.com/a.jpg'],
    licenseOverridden: false,
    marketplaces: [
      { marketplace: 'ebay', state: 'published', remoteId: '1', liveId: '2', url: null, error: null, updatedAt: now },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('a stored listing meeting a newer schema', () => {
  it('parses a record written before the derived fields existed', () => {
    const parsed = ListingRecordSchema.parse(record())
    expect(parsed.seo).toBeNull()
    expect(parsed.proposal).toBeNull()
    expect(parsed.titleOptions).toBeNull()
  })

  it('drops research in an outdated shape instead of failing', () => {
    // The exact shape that caused the incident: a price band from before
    // `count`, `min` and `max` were added.
    const stale = {
      etsy: {
        marketplace: 'etsy',
        language: 'en',
        generatedAt: now,
        queries: ['dart holder'],
        sampleSize: 300,
        candidates: [],
        categoryConsensus: null,
        priceBandEur: { p25: 8.94, median: 11.19, p75: 16.77 },
        aspectFacets: [],
        notes: [],
      },
      ebay: null,
    }

    const parsed = ListingRecordSchema.parse(record({ seo: stale }))
    expect(parsed.seo).toBeNull()
    // Everything the seller actually owns survives intact.
    expect(parsed.copy.etsy.title).toBe('Dart Holder')
    expect(parsed.imagePaths).toEqual(['/tmp/a.jpg'])
    expect(parsed.marketplaces[0]?.liveId).toBe('2')
  })

  it('drops a malformed pending rewrite and malformed title options', () => {
    const parsed = ListingRecordSchema.parse(
      record({ proposal: { copy: 'not a copy object' }, titleOptions: { ebay: 'not an array' } }),
    )
    expect(parsed.proposal).toBeNull()
    expect(parsed.titleOptions).toBeNull()
  })

  it('still refuses a record whose authored copy is broken', () => {
    // The leniency must not reach the fields that cannot be regenerated. An
    // Etsy title over 140 characters is corruption worth stopping for.
    const broken = record({
      copy: { ...(record().copy as object), etsy: { ...(record().copy as { etsy: object }).etsy, title: 'x'.repeat(200) } },
    })
    expect(ListingRecordSchema.safeParse(broken).success).toBe(false)
  })

  it('still refuses a record with no product facts', () => {
    expect(ListingRecordSchema.safeParse(record({ product: undefined })).success).toBe(false)
  })
})
