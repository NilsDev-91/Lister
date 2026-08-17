import { describe, it, expect } from 'vitest'
import { isLive, splitListings } from './views.js'
import { ListingRecordSchema, type ListingRecord, type MarketplaceRecord } from '../types.js'

/**
 * What counts as "live" in the overview.
 *
 * The regression this pins is real and was found on a live record: a re-publish
 * that failed on a category lookup set the eBay row to `failed` while the
 * listing stayed online, and the overview moved it back to drafts.
 */

const NOW = '2026-08-16T00:00:00.000Z'

function marketplace(over: Partial<MarketplaceRecord> = {}): MarketplaceRecord {
  return {
    marketplace: 'ebay',
    state: 'draft',
    remoteId: null,
    liveId: null,
    url: null,
    error: null,
    updatedAt: NOW,
    ...over,
  }
}

function listing(marketplaces: MarketplaceRecord[]): ListingRecord {
  return ListingRecordSchema.parse({
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
      fetchedAt: NOW,
    },
    product: {
      priceEur: 20.99,
      quantity: 1,
      material: 'PLA',
      colour: null,
      dimensionsMm: null,
      weightGrams: null,
      processingDays: 3,
      notes: '',
    },
    copy: {
      ebay: { title: 'Dartshalter', descriptionHtml: '<p>x</p>', categoryHint: 'Deko', aspects: {} },
      etsy: { title: 'Dart Holder', description: 'x', tags: [], materials: [], taxonomyHint: 'Home Decor' },
    },
    imagePaths: [],
    imageUrls: [],
    marketplaces,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('isLive', () => {
  it('stays live when a later publish attempt failed', () => {
    // The record that exposed this: online on eBay, but the last run died on a
    // sandbox category lookup and set the row to `failed`.
    expect(
      isLive(listing([marketplace({ state: 'failed', remoteId: '114', liveId: '110590188642' })])),
    ).toBe(true)
  })

  it('counts a published row as live', () => {
    expect(isLive(listing([marketplace({ state: 'published', liveId: '110590188642' })]))).toBe(true)
  })

  it('does not count an offer that only reached the marketplace as a draft', () => {
    // eBay assigns the offer id before anything is published.
    expect(isLive(listing([marketplace({ state: 'draft', remoteId: '11438356010', liveId: null })]))).toBe(false)
  })

  it('does not count a listing that never left the machine', () => {
    expect(isLive(listing([marketplace()]))).toBe(false)
  })

  it('is live when any one marketplace is', () => {
    expect(
      isLive(
        listing([
          marketplace({ marketplace: 'ebay', state: 'draft' }),
          marketplace({ marketplace: 'etsy', state: 'published', liveId: '999' }),
        ]),
      ),
    ).toBe(true)
  })
})

describe('splitListings', () => {
  it('puts each listing on exactly one side', () => {
    const live = listing([marketplace({ liveId: '1' })])
    const draft = listing([marketplace()])
    const split = splitListings([live, draft])
    expect(split.live).toHaveLength(1)
    expect(split.drafts).toHaveLength(1)
  })

  it('handles a listing with no marketplaces at all', () => {
    // What a third-party design gets now that Etsy is gated out.
    const split = splitListings([listing([])])
    expect(split.live).toHaveLength(0)
    expect(split.drafts).toHaveLength(1)
  })
})
