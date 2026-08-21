import { describe, it, expect } from 'vitest'
import { coverage, crudeStem, tagHygiene } from './coverage.js'
import type { KeywordCandidate, KeywordEvidence } from './types.js'

function candidate(phrase: string, over: Partial<KeywordCandidate> = {}): KeywordCandidate {
  return {
    phrase,
    rankerCount: 5,
    rankerShare: 0.5,
    sources: ['tag'],
    competition: null,
    demandPerDay: null,
    score: 1,
    usableAsTag: true,
    ...over,
  }
}

function evidence(candidates: KeywordCandidate[]): KeywordEvidence {
  return {
    marketplace: 'etsy',
    language: 'en',
    generatedAt: '2026-08-13T00:00:00.000Z',
    queries: ['x'],
    sampleSize: 10,
    relevance: { anchors: [], sampled: 10, kept: 10, sufficient: true },
    candidates,
    categoryConsensus: null,
    priceBandEur: null,
    aspectFacets: [],
    notes: [],
  }
}

describe('coverage', () => {
  it('finds a recommendation used in the title', () => {
    const result = coverage({
      title: 'Articulated Dragon Desk Toy, 3D Printed',
      tags: [],
      evidence: evidence([candidate('articulated dragon')]),
    })
    expect(result.used).toEqual(['articulated dragon'])
    expect(result.missed).toEqual([])
  })

  it('finds a recommendation used as a tag', () => {
    const result = coverage({
      title: 'Something Else Entirely',
      tags: ['3D Printed Dragon'],
      evidence: evidence([candidate('3d printed dragon')]),
    })
    expect(result.used).toEqual(['3d printed dragon'])
  })

  it('does not match a phrase inside a longer word', () => {
    // " dragon " must not be found in " dragonfly ".
    const result = coverage({
      title: 'Dragonfly Ornament',
      tags: [],
      evidence: evidence([candidate('dragon')]),
    })
    expect(result.used).toEqual([])
    expect(result.missed).toEqual(['dragon'])
  })

  it('reports strong recommendations that were left out', () => {
    const result = coverage({
      title: 'Dragon Figure',
      tags: [],
      evidence: evidence([candidate('dragon figure'), candidate('desk ornament')]),
    })
    expect(result.used).toEqual(['dragon figure'])
    expect(result.missed).toEqual(['desk ornament'])
  })

  it('ignores recommendations the marketplace could not accept as a tag', () => {
    const result = coverage({
      title: 'Dragon Figure',
      tags: [],
      evidence: evidence([candidate('far too long to be an etsy tag', { usableAsTag: false })]),
    })
    expect(result.missed).toEqual([])
  })

  it('lists tags the research does not support without calling them wrong', () => {
    const result = coverage({
      title: 'Dragon Figure',
      tags: ['dragon figure', 'petg print'],
      evidence: evidence([candidate('dragon figure')]),
    })
    // The seller knows the material; the sample simply never mentioned it.
    expect(result.unevidenced).toEqual(['petg print'])
  })
})

describe('crudeStem', () => {
  it('collapses the endings that make two tags cover one search', () => {
    expect(crudeStem('printed')).toBe('print')
    expect(crudeStem('printing')).toBe('print')
    expect(crudeStem('prints')).toBe('print')
    expect(crudeStem('dragons')).toBe('dragon')
  })

  it('leaves short words alone rather than mangling them', () => {
    expect(crudeStem('red')).toBe('red')
    expect(crudeStem('kid')).toBe('kid')
    expect(crudeStem('3d')).toBe('3d')
  })
})

describe('tagHygiene', () => {
  it('flags two tags built on the same word', () => {
    const { repeated } = tagHygiene(['3d printed dragon', '3d printing toy', 'desk ornament'])
    const stems = repeated.map((r) => r.stem)
    expect(stems).toContain('3d')
    expect(stems).toContain('print')
    expect(stems).not.toContain('dragon')
  })

  it('does not flag a word repeated inside a single tag', () => {
    // One tag wasting its own words is not two tags overlapping.
    expect(tagHygiene(['dragon dragon figure']).repeated).toEqual([])
  })

  it('counts the empty tag slots', () => {
    expect(tagHygiene(['one', 'two']).unusedSlots).toBe(11)
    expect(tagHygiene(Array.from({ length: 13 }, (_, i) => `tag${i}`)).unusedSlots).toBe(0)
  })

  it('reports nothing for tags that cover distinct searches', () => {
    expect(tagHygiene(['dragon figure', 'desk ornament', 'gift for him']).repeated).toEqual([])
  })
})
