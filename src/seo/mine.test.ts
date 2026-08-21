import { describe, it, expect } from 'vitest'
import { mine, normaliseTag, percentile, phrasesFromTitle, scoreCandidate } from './mine.js'
import { CompetitorListingSchema, type CompetitorListing, type SearchResult } from './types.js'

function listing(over: Partial<CompetitorListing> & { id: string; title: string }): CompetitorListing {
  return CompetitorListingSchema.parse(over)
}

function result(query: string, listings: CompetitorListing[], totalMatches: number | null = null): SearchResult {
  return { query, totalMatches, listings, aspectFacets: [] }
}

const AT = '2026-08-13T00:00:00.000Z'

function mined(results: SearchResult[], marketplace: 'ebay' | 'etsy' = 'etsy') {
  return mine({ marketplace, language: 'en', results, generatedAt: AT })
}

function phraseOf(results: SearchResult[], phrase: string) {
  return mined(results).candidates.find((c) => c.phrase === phrase)
}

describe('phrasesFromTitle', () => {
  it('does not build phrases across a separator', () => {
    const phrases = phrasesFromTitle('Desk Organizer | 3D Printed')
    expect(phrases).toContain('desk organizer')
    expect(phrases).toContain('3d printed')
    // Nobody wrote "organizer 3d"; it only exists if the pipe is ignored.
    expect(phrases).not.toContain('organizer 3d')
  })

  it('keeps a stopword inside a phrase but not at its edges', () => {
    const phrases = phrasesFromTitle('Gift for Mom')
    expect(phrases).toContain('gift for mom')
    expect(phrases).not.toContain('gift for')
    expect(phrases).not.toContain('for mom')
  })

  it('keeps two-letter stopwords, so "made to order" does not fuse into "made order"', () => {
    // "to" is two letters and used to fall to the junk-token filter before the
    // n-grams were built — producing a phantom phrase nobody wrote.
    const phrases = phrasesFromTitle('Dragon Made to Order')
    expect(phrases).toContain('made to order')
    expect(phrases).not.toContain('made order')
  })

  it('keeps short tokens that carry a digit and drops the ones that do not', () => {
    const phrases = phrasesFromTitle('3D Dragon 12 cm')
    expect(phrases).toContain('3d dragon')
    // "cm" is two letters and no digit — a unit, not a search term.
    expect(phrases).not.toContain('cm')
    // A bare number is not a keyword, and neither is a phrase built around one.
    expect(phrases).not.toContain('12')
    expect(phrases).not.toContain('dragon 12')
  })

  it('survives umlauts', () => {
    expect(phrasesFromTitle('Schlüsselanhänger Drache')).toContain('schlüsselanhänger drache')
  })
})

describe('normaliseTag', () => {
  it('lowercases and strips punctuation so tags and title n-grams match', () => {
    expect(normaliseTag('3D-Printed, Dragon!')).toBe('3d-printed dragon')
  })
})

describe('percentile', () => {
  it('returns null for an empty sample rather than a zero', () => {
    expect(percentile([], 50)).toBeNull()
  })

  it('uses nearest rank', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
    expect(percentile([4, 3, 2, 1], 75)).toBe(3)
  })
})

describe('scoreCandidate', () => {
  it('ranks an uncrowded long-tail phrase above a saturated head term', () => {
    // Ten times the traffic, two hundred times the competition. A shop with no
    // sales history cannot win the head term, so it must not be recommended.
    const head = scoreCandidate({ phrase: 'dart holder', rankerShare: 0.5, demandPerDay: 200, competition: 200_000 })
    const tail = scoreCandidate({ phrase: 'slim dart rack', rankerShare: 0.5, demandPerDay: 20, competition: 800 })
    expect(tail).toBeGreaterThan(head)
  })

  it('rewards measuring competition rather than leaving it unknown', () => {
    // If "unmeasured" scored as "uncontested", the cheapest way to win would be
    // to never run the second research round.
    const base = { phrase: 'dart holder', rankerShare: 0.5, demandPerDay: 30 }
    const measuredLow = scoreCandidate({ ...base, competition: 100 })
    const unmeasured = scoreCandidate({ ...base, competition: null })
    const measuredHigh = scoreCandidate({ ...base, competition: 50_000 })

    expect(measuredLow).toBeGreaterThan(unmeasured)
    expect(measuredHigh).toBeLessThan(unmeasured)
  })

  it('does not let an unmeasured single word outrank a real phrase', () => {
    // The regression a live run exposed: "dart", "holder" and "gift" filled the
    // top ten. A single word has the highest possible ranker share — every
    // longer phrase contains it — and is never seeded, so it kept the moderate
    // default for competition while really being the most crowded query there is.
    const word = scoreCandidate({ phrase: 'darts', rankerShare: 0.74, demandPerDay: 0.4, competition: null })
    const phrase = scoreCandidate({
      phrase: 'customisable dart holder',
      rankerShare: 0.04,
      demandPerDay: 3.5,
      competition: 45,
    })
    expect(phrase).toBeGreaterThan(word)
  })

  it('still lets a measured single word win if it really is uncrowded', () => {
    // The penalty is an assumption about unmeasured words, not a rule against
    // short ones. Measuring must always override it.
    const measured = scoreCandidate({ phrase: 'dartboard', rankerShare: 0.5, demandPerDay: 5, competition: 40 })
    const assumed = scoreCandidate({ phrase: 'dartboard', rankerShare: 0.5, demandPerDay: 5, competition: null })
    expect(measured).toBeGreaterThan(assumed)
  })

  it('penalises a thin phrase where views exist but treats it neutrally where they do not', () => {
    const measured = { phrase: 'dart holder', rankerShare: 0.3, demandPerDay: 0.7, competition: null }
    const thin = { phrase: 'jaxson dart', rankerShare: 0.3, demandPerDay: null, competition: null }

    // Etsy reports views. A phrase with none had too few listings to measure —
    // that is thinness, and weak-but-real demand must beat it.
    expect(scoreCandidate(measured, true)).toBeGreaterThan(scoreCandidate(thin, true))

    // eBay reports no views at all. There "unknown" is the API's silence, not
    // evidence about the phrase, so it must not be punished for it.
    expect(scoreCandidate(thin, false)).toBeGreaterThan(scoreCandidate(thin, true))
  })

  it('does not zero out a phrase whose ranked listings show no views', () => {
    // Etsy tabulates views once a day, so a genuine listing can read 0.
    expect(
      scoreCandidate({ phrase: 'dart holder', rankerShare: 1, demandPerDay: 0, competition: null }),
    ).toBeGreaterThan(0)
  })

  it('prefers a phrase more of the ranked listings agree on', () => {
    const common = scoreCandidate({ phrase: 'dart holder', rankerShare: 0.8, demandPerDay: 50, competition: 1000 })
    const rare = scoreCandidate({ phrase: 'dart holder', rankerShare: 0.1, demandPerDay: 50, competition: 1000 })
    expect(common).toBeGreaterThan(rare)
  })
})

describe('mine', () => {
  it('ignores a phrase only one listing uses', () => {
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dragon Desk Toy', tags: ['unique quirk'] }),
        listing({ id: '2', title: 'Dragon Desk Toy' }),
      ]),
    ]
    expect(phraseOf(results, 'dragon desk toy')).toBeDefined()
    expect(phraseOf(results, 'unique quirk')).toBeUndefined()
  })

  it('raises the evidence threshold as the sample grows', () => {
    // Two listings out of 150 is a coincidence, not a market signal. A live
    // search for "dart" returned t-shirts about a footballer named Jaxson Dart;
    // a fixed floor of two let them through.
    const listings = [
      ...Array.from({ length: 148 }, (_, i) => listing({ id: `d${i}`, title: 'Dart Holder Rack' })),
      listing({ id: 'x1', title: 'Jaxson Dart Shirt' }),
      listing({ id: 'x2', title: 'Jaxson Dart Shirt' }),
    ]
    const results = [result('dart', listings)]
    expect(phraseOf(results, 'dart holder')).toBeDefined()
    expect(phraseOf(results, 'jaxson dart')).toBeUndefined()
  })

  it('still accepts two listings when the sample is small', () => {
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dragon Desk Toy' }),
        listing({ id: '2', title: 'Dragon Desk Toy' }),
      ]),
    ]
    expect(phraseOf(results, 'dragon desk toy')).toBeDefined()
  })

  it('counts a listing once even when it ranks for several queries', () => {
    const shared = listing({ id: '1', title: 'Dragon Desk Toy' })
    const evidence = mined([
      result('dragon', [shared, listing({ id: '2', title: 'Dragon Desk Toy' })]),
      result('desk toy', [shared, listing({ id: '3', title: 'Dragon Desk Toy' })]),
    ])
    expect(evidence.sampleSize).toBe(3)
    expect(evidence.candidates.find((c) => c.phrase === 'dragon desk toy')?.rankerCount).toBe(3)
  })

  it('counts a repeated word in one title as one listing, not two', () => {
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dragon Dragon Dragon Figure' }),
        listing({ id: '2', title: 'Dragon Figure' }),
      ]),
    ]
    expect(phraseOf(results, 'dragon')?.rankerCount).toBe(2)
  })

  it('credits a phrase to tags when a seller chose it deliberately', () => {
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dragon Figure', tags: ['dragon figure'] }),
        listing({ id: '2', title: 'Dragon Figure' }),
      ]),
    ]
    const candidate = phraseOf(results, 'dragon figure')
    expect(candidate?.sources).toContain('tag')
    expect(candidate?.sources).toContain('title')
  })

  it('attaches a competition figure only to phrases that were searched', () => {
    const listings = [
      listing({ id: '1', title: 'Dragon Desk Toy' }),
      listing({ id: '2', title: 'Dragon Desk Toy' }),
    ]
    const results = [result('dragon desk toy', listings, 4200)]
    expect(phraseOf(results, 'dragon desk toy')?.competition).toBe(4200)
    // "desk toy" appears in the titles but was never a query, so its crowding
    // is genuinely unknown — not zero.
    expect(phraseOf(results, 'desk toy')?.competition).toBeNull()
  })

  it('ignores view rates from listings too young to have been tabulated', () => {
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dragon Figure', views: 500, daysListed: 2 }),
        listing({ id: '2', title: 'Dragon Figure', views: 500, daysListed: 3 }),
      ]),
    ]
    // 250 views/day would be implied, which no established listing matches.
    expect(phraseOf(results, 'dragon figure')?.demandPerDay).toBeNull()
  })

  it('withholds a demand figure drawn from too few listings', () => {
    // Two listings do not have a median. A live run produced 28.8 views/day
    // from a single lucky listing and showed it beside figures drawn from forty.
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dragon Figure', views: 2000, daysListed: 100 }),
        listing({ id: '2', title: 'Dragon Figure', views: 2000, daysListed: 100 }),
      ]),
    ]
    expect(phraseOf(results, 'dragon figure')?.demandPerDay).toBeNull()
  })

  it('takes the median view rate across listings old enough to count', () => {
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dragon Figure', views: 100, daysListed: 10 }),
        listing({ id: '2', title: 'Dragon Figure', views: 400, daysListed: 10 }),
        listing({ id: '3', title: 'Dragon Figure', views: 200, daysListed: 10 }),
      ]),
    ]
    expect(phraseOf(results, 'dragon figure')?.demandPerDay).toBe(20)
  })

  it('leaves demand unknown on a marketplace that reports no views', () => {
    const results = [
      result('x', [listing({ id: '1', title: 'Drachen Figur' }), listing({ id: '2', title: 'Drachen Figur' })]),
    ]
    expect(mine({ marketplace: 'ebay', language: 'de', results, generatedAt: AT }).candidates[0]?.demandPerDay).toBeNull()
  })

  it('marks an over-long phrase unusable as an Etsy tag but usable on eBay', () => {
    const long = 'articulated flexible dragon desk ornament'
    const results = [
      result('x', [listing({ id: '1', title: long }), listing({ id: '2', title: long })]),
    ]
    const asEtsy = mine({ marketplace: 'etsy', language: 'en', results, generatedAt: AT })
    const asEbay = mine({ marketplace: 'ebay', language: 'de', results, generatedAt: AT })

    // Etsy caps a tag at 20 characters; "articulated flexible" is exactly that.
    expect(asEtsy.candidates.find((c) => c.phrase === 'articulated flexible dragon')?.usableAsTag).toBe(false)
    expect(asEtsy.candidates.find((c) => c.phrase === 'articulated flexible')?.usableAsTag).toBe(true)
    // eBay has no tag field; the question is only whether it fits a title.
    expect(asEbay.candidates.find((c) => c.phrase === 'articulated flexible dragon')?.usableAsTag).toBe(true)
  })

  it('ranks the categories the sample sits in rather than crowning one', () => {
    // A plurality is not a consensus: whoever reads this has to be able to see
    // that 2 of 3 and 40 of 200 are different claims, which a lone winner hid.
    const evidence = mined([
      result('x', [
        listing({ id: '1', title: 'Dragon Figure', categoryId: '1234' }),
        listing({ id: '2', title: 'Dragon Figure', categoryId: '1234' }),
        listing({ id: '3', title: 'Dragon Figure', categoryId: '9999' }),
      ]),
    ])
    expect(evidence.categoryCandidates).toEqual([
      { id: '1234', name: null, count: 2, share: 2 / 3 },
      { id: '9999', name: null, count: 1, share: 1 / 3 },
    ])
  })

  it('names a category from the listings that carry a name, and keeps the commonest', () => {
    // eBay states the name next to the id; a single odd spelling must not
    // rename a category the rest of the sample agrees on.
    const evidence = mined([
      result('x', [
        listing({ id: '1', title: 'Dragon Figure', categoryId: '1234', categoryName: 'Figuren' }),
        listing({ id: '2', title: 'Dragon Figure', categoryId: '1234', categoryName: 'Figuren' }),
        listing({ id: '3', title: 'Dragon Figure', categoryId: '1234', categoryName: 'Figuren & Deko' }),
      ]),
    ])
    expect(evidence.categoryCandidates[0]).toEqual({ id: '1234', name: 'Figuren', count: 3, share: 1 })
  })

  it('keeps at most five categories, the busiest first', () => {
    const evidence = mined([
      result(
        'x',
        Array.from({ length: 12 }, (_, i) =>
          listing({ id: `l${i}`, title: 'Dragon Figure', categoryId: `c${i % 6}` }),
        ),
      ),
    ])
    expect(evidence.categoryCandidates).toHaveLength(5)
    expect(evidence.categoryCandidates.every((c) => c.count === 2)).toBe(true)
    // Stable order on a tie, so two runs over the same sample read the same.
    expect(evidence.categoryCandidates.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
  })

  it('excludes digital downloads and says how many it dropped', () => {
    // A live sample for "dart holder" ran from EUR 0.56 to EUR 744.94; the
    // bottom end was STL files, which drag the median under anything a printed
    // object can sell for.
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dart Holder Rack', priceEur: 18, kind: 'physical' }),
        listing({ id: '2', title: 'Dart Holder Rack', priceEur: 22, kind: 'physical' }),
        listing({ id: '3', title: 'Dart Holder STL Bundle', priceEur: 0.56, kind: 'digital' }),
      ]),
    ]
    const evidence = mined(results)
    expect(evidence.sampleSize).toBe(2)
    expect(evidence.candidates.find((c) => c.phrase === 'stl bundle')).toBeUndefined()
    expect(evidence.notes.join(' ')).toMatch(/Excluded 1 digital/)
  })

  it('keeps a listing that is sold both ways', () => {
    // "both" means the seller ships an object and offers the file; the object
    // half is a real competitor.
    const results = [
      result('x', [
        listing({ id: '1', title: 'Dart Holder Rack', kind: 'both' }),
        listing({ id: '2', title: 'Dart Holder Rack', kind: 'physical' }),
      ]),
    ]
    expect(mined(results).sampleSize).toBe(2)
  })

  it('reports the extremes and the sample size alongside the quartiles', () => {
    const prices = [5, 9, 11, 13, 40]
    const evidence = mined([
      result(
        'x',
        prices.map((p, i) => listing({ id: String(i), title: 'Dragon Figure', priceEur: p })),
      ),
    ])
    // The 5-to-40 spread is the interesting part: it says the sample is mixed,
    // which a median of 11 would hide completely.
    expect(evidence.priceBandEur).toMatchObject({ count: 5, min: 5, max: 40, median: 11 })
  })

  it('withholds a price band from a sample too small to describe one', () => {
    const evidence = mined([
      result('x', [
        listing({ id: '1', title: 'Dragon Figure', priceEur: 10 }),
        listing({ id: '2', title: 'Dragon Figure', priceEur: 20 }),
      ]),
    ])
    expect(evidence.priceBandEur).toBeNull()
  })

  it('sums aspect facets across searches', () => {
    const evidence = mine({
      marketplace: 'ebay',
      language: 'de',
      generatedAt: AT,
      results: [
        { query: 'a', totalMatches: null, listings: [], aspectFacets: [{ name: 'Material', value: 'PLA', count: 10 }] },
        { query: 'b', totalMatches: null, listings: [], aspectFacets: [{ name: 'Material', value: 'PLA', count: 5 }] },
      ],
    })
    expect(evidence.aspectFacets).toEqual([{ name: 'Material', value: 'PLA', count: 15 }])
  })

  it('says so when it truncates the candidate list instead of shortening it quietly', () => {
    const titles = Array.from({ length: 12 }, (_, i) => `Alpha${i} Beta${i} Gamma${i}`)
    const listings = titles.flatMap((title, i) => [
      listing({ id: `a${i}`, title }),
      listing({ id: `b${i}`, title }),
    ])
    const evidence = mine({
      marketplace: 'etsy',
      language: 'en',
      results: [result('x', listings)],
      generatedAt: AT,
      maxCandidates: 5,
    })
    expect(evidence.candidates).toHaveLength(5)
    expect(evidence.notes.join(' ')).toMatch(/keeping the top 5/)
  })

  it('produces a stable order for candidates that score identically', () => {
    const results = [
      result('x', [
        listing({ id: '1', title: 'Alpha Thing, Beta Thing' }),
        listing({ id: '2', title: 'Alpha Thing, Beta Thing' }),
      ]),
    ]
    const first = mined(results).candidates.map((c) => c.phrase)
    const second = mined(results).candidates.map((c) => c.phrase)
    expect(first).toEqual(second)
  })
})
