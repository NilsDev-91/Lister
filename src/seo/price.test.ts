import { describe, it, expect } from 'vitest'
import { assessPrice, isMixed, priceHint, MIN_SAMPLE_FOR_ADVICE } from './price.js'
import type { PriceBand } from './types.js'

function band(over: Partial<PriceBand> = {}): PriceBand {
  return { count: 40, min: 6.55, p25: 8.94, median: 11.19, p75: 16.77, max: 34.9, ...over }
}

describe('assessPrice', () => {
  it('calls a price inside the middle half typical, and says nothing about it', () => {
    const verdict = assessPrice(12, band())
    expect(verdict.position).toBe('typical')
    expect(verdict.notable).toBe(false)
    expect(priceHint(verdict)).toBeUndefined()
  })

  it('flags a price in the upper quarter', () => {
    const verdict = assessPrice(20.99, band())
    expect(verdict.position).toBe('high')
    expect(verdict.notable).toBe(true)
    expect(verdict.vsMedian).toBeCloseTo(1.88, 2)
  })

  it('separates "above everyone" from merely "expensive"', () => {
    expect(assessPrice(50, band()).position).toBe('above')
    expect(assessPrice(20.99, band()).position).toBe('high')
  })

  it('flags a price under the whole market', () => {
    const verdict = assessPrice(4, band())
    expect(verdict.position).toBe('below')
    expect(priceHint(verdict)).toMatch(/margin/i)
  })

  it('stays quiet when the sample is too thin to argue with', () => {
    // Six listings should not get to dictate a price.
    const verdict = assessPrice(50, band({ count: MIN_SAMPLE_FOR_ADVICE - 1 }))
    expect(verdict.position).toBe('above')
    expect(verdict.notable).toBe(false)
  })

  it('leads with the median and the middle half, then the full range', () => {
    const summary = assessPrice(20.99, band()).summary
    expect(summary).toContain('median EUR 11.19')
    expect(summary).toContain('middle half EUR 8.94–EUR 16.77')
    expect(summary).toContain('full range EUR 6.55–EUR 34.90')
    expect(summary).toContain('40 listings')
  })

  it('warns when the extremes are describing other products', () => {
    // The live sample: dart flights at EUR 0.56 and dartboard cabinets at
    // EUR 744.94, both returned by a search for "dart".
    const wide = band({ min: 0.56, max: 744.94, median: 13.99 })
    expect(isMixed(wide)).toBe(true)
    expect(assessPrice(20.99, wide).summary).toContain('different product types')

    // A market from 6 € to 35 € around a median of 11 is just a market.
    expect(isMixed(band())).toBe(false)
  })

  it('does not divide by a zero median', () => {
    const verdict = assessPrice(10, band({ min: 0, p25: 0, median: 0, p75: 0, max: 0 }))
    expect(Number.isFinite(verdict.vsMedian)).toBe(true)
  })

  it('treats the quartile edges as inside the band', () => {
    expect(assessPrice(8.94, band()).position).toBe('typical')
    expect(assessPrice(16.77, band()).position).toBe('typical')
  })
})
