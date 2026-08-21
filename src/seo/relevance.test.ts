import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { anchorTerms, isComparable, phraseIsAnchored, withholdThinEvidence, MIN_COMPARABLE } from './relevance.js'
import { mine } from './mine.js'
import { SearchResultSchema, type CompetitorListing, type KeywordEvidence, type SearchResult } from './types.js'
import { ListingRecordSchema, type ListingRecord } from '../types.js'

/**
 * The run this module exists because of, replayed from its own cache files.
 *
 * `__fixtures__/etsy-dart-halter.json` is verbatim what Etsy answered the seed
 * query "dart halter" with on 2026-08-19: twelve listings, ten of them sewing
 * patterns, because "dart" is the English term for a fitted seam.
 * `etsy-sleeveless-dress.json` is the first eight of the fifty listings round
 * two then fetched — for a query mined out of those sewing patterns.
 *
 * Together they are the exact input that produced a dart holder's "market" of
 * linen dresses at a median of EUR 59.54.
 */

const FIXTURES = join(import.meta.dirname, '__fixtures__')

function fixture(name: string): SearchResult {
  return SearchResultSchema.parse(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')))
}

const NOW = '2026-08-19T12:00:00.000Z'

/** The seller's real listing, in the words the anchors are drawn from. */
function listing(): ListingRecord {
  return ListingRecordSchema.parse({
    id: 'mw-1069737-573940',
    sourceUrl: 'https://makerworld.com/en/models/1069737',
    source: {
      sourceUrl: 'https://makerworld.com/en/models/1069737',
      externalId: '1069737',
      title: 'Dart holder - slim',
      description: '',
      designer: 'OMMO',
      tags: ['dart', 'holder'],
      images: [],
      license: { raw: 'CC BY 4.0', code: 'CC-BY-4.0', commercialUse: 'yes', reason: 'ok' },
      fetchedAt: NOW,
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
        title: 'Dartshalter schlank 3D-Druck Dartpfeil Halter Ständer',
        descriptionHtml: '<p>Von mir gedruckt.</p>',
        categoryHint: 'Dart',
        aspects: {},
      },
      etsy: {
        title: 'Dartshalter schlank',
        description: 'Von mir gedruckt.',
        tags: ['dartshalter', 'dart halter', 'dartpfeile halter', '3d druck dart'],
        materials: ['PLA'],
        taxonomyHint: 'Dekoration',
      },
    },
    imagePaths: [],
    imageUrls: [],
    marketplaces: [],
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function competitor(title: string, over: Partial<CompetitorListing> = {}): CompetitorListing {
  return {
    id: 'x',
    title,
    tags: [],
    materials: [],
    priceEur: 10,
    views: null,
    favourites: null,
    daysListed: null,
    kind: 'physical',
    categoryId: null,
    url: null,
    ...over,
  }
}

const ANCHORS = anchorTerms(listing())

describe('anchorTerms', () => {
  it('collects the words the item is described in, across both marketplaces', () => {
    expect(ANCHORS).toContain('dart')
    expect(ANCHORS).toContain('dartshalter')
    expect(ANCHORS).toContain('halter')
    expect(ANCHORS).toContain('pla')
  })

  it('leaves out words that carry no search intent', () => {
    expect(ANCHORS).not.toContain('von')
    expect(ANCHORS).not.toContain('für')
  })
})

describe('isComparable', () => {
  it('keeps the one real competitor in the sample', () => {
    expect(isComparable(competitor('Dartpfeil-Halter für Akustikpaneele - Klemmt ohne Bohren'), ANCHORS)).toBe(true)
  })

  it('finds an anchor inside a German compound', () => {
    // "Dartsmount" is one token; without compound matching the only genuine
    // second competitor in the whole sample would have been thrown away.
    expect(isComparable(competitor('Dartsmount (1er Set bis 4er Sets)'), ANCHORS)).toBe(true)
  })

  it('drops a listing with nothing in common with the item', () => {
    expect(isComparable(competitor('1960s Gold Sleeveless Dress & Coat | Vintage Satin Dress Set'), ANCHORS)).toBe(false)
    expect(isComparable(competitor('Deer Plush Sewing Pattern PDF | Woodland Fawn'), ANCHORS)).toBe(false)
  })

  it('does not let a three-letter anchor match inside a longer word', () => {
    // "pla" is the material. Substring matching would find it in "display",
    // "place" and "plant" and wave through half the marketplace.
    expect(isComparable(competitor('Wall Display Case for Plants'), ANCHORS)).toBe(false)
  })

  it('lets the documented false positive through, on purpose', () => {
    // A sewing pattern that mentions both "halter" and "darts" passes: this
    // filter matches words, not meaning. Tightening it far enough to catch
    // this would also drop genuine niche competitors — the evidence floor is
    // what stops a sample like this from becoming a recommendation.
    expect(
      isComparable(competitor('vintage sewing pattern 1950s classic halter top / dart fitted'), ANCHORS),
    ).toBe(true)
  })

  it('has no opinion when the item has no vocabulary', () => {
    expect(isComparable(competitor('Anything at all'), [])).toBe(true)
  })
})

describe('phraseIsAnchored — what round two is allowed to search', () => {
  it('refuses the two queries that poisoned the real run', () => {
    expect(phraseIsAnchored('sewing pattern', ANCHORS)).toBe(false)
    expect(phraseIsAnchored('sleeveless dress', ANCHORS)).toBe(false)
  })

  it('allows a phrase that belongs to the item', () => {
    expect(phraseIsAnchored('dart display', ANCHORS)).toBe(true)
    expect(phraseIsAnchored('dartpfeil ständer', ANCHORS)).toBe(true)
  })
})

describe('the real run, replayed', () => {
  const round1 = fixture('etsy-dart-halter')
  const round2 = fixture('etsy-sleeveless-dress')

  it('used to build a market out of dresses', () => {
    // Without anchors — the behaviour as it shipped. This is not a wish list:
    // both fixtures are the cached answers of the run that stored a median of
    // EUR 59.54 for a dart holder.
    const before = mine({ marketplace: 'etsy', language: 'de', results: [round1, round2], generatedAt: NOW })

    expect(before.candidates.some((c) => c.phrase.includes('dress'))).toBe(true)
    expect(before.priceBandEur).not.toBeNull()
  })

  it('now keeps only what is comparable, and then refuses to conclude', () => {
    const after = withholdThinEvidence(
      mine({ marketplace: 'etsy', language: 'de', results: [round1, round2], anchors: ANCHORS, generatedAt: NOW }),
    )

    expect(after.relevance.kept).toBeLessThan(MIN_COMPARABLE)
    expect(after.relevance.sufficient).toBe(false)
    expect(after.candidates).toEqual([])
    expect(after.priceBandEur).toBeNull()
    expect(after.categoryConsensus).toBeNull()
    // The attempt survives in full — that is what makes "this niche is empty"
    // a usable answer rather than a silence.
    expect(after.relevance.sampled).toBeGreaterThan(after.relevance.kept)
    expect(after.notes.join(' ')).toContain('comparable')
  })

  it('keeps the genuine competitors rather than emptying the sample', () => {
    const after = mine({
      marketplace: 'etsy',
      language: 'de',
      results: [round1, round2],
      anchors: ANCHORS,
      generatedAt: NOW,
    })
    expect(after.relevance.kept).toBeGreaterThan(0)
  })
})

describe('withholdThinEvidence', () => {
  function evidence(over: Partial<KeywordEvidence> = {}): KeywordEvidence {
    return {
      marketplace: 'etsy',
      language: 'de',
      generatedAt: NOW,
      queries: ['dart halter'],
      sampleSize: 40,
      relevance: { anchors: ['dart'], sampled: 40, kept: 40, sufficient: true },
      candidates: [
        {
          phrase: 'dart holder',
          rankerCount: 20,
          rankerShare: 0.5,
          sources: ['tag'],
          competition: 1611,
          demandPerDay: 1,
          score: 1,
          usableAsTag: true,
        },
      ],
      categoryConsensus: { id: '505', share: 0.7 },
      priceBandEur: { count: 40, min: 5, p25: 10, median: 15, p75: 20, max: 40 },
      aspectFacets: [],
      notes: [],
      ...over,
    }
  }

  it('leaves a sufficient run untouched', () => {
    const input = evidence()
    expect(withholdThinEvidence(input)).toBe(input)
  })

  it('names the reason when no search returned anything on eBay', () => {
    // The state eBay has been in all along: sandbox credentials answer 403 on
    // the Browse API, and an empty table read like "no competition".
    const withheld = withholdThinEvidence(
      evidence({
        marketplace: 'ebay',
        sampleSize: 0,
        relevance: { anchors: ['dart'], sampled: 0, kept: 0, sufficient: false },
      }),
    )
    expect(withheld.notes.join(' ')).toContain('production keyset')
    expect(withheld.candidates).toEqual([])
  })
})
