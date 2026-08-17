import { describe, it, expect } from 'vitest'
import { formatVariants, parseVariants } from './variant-text.js'
import { EbayVariantsSchema } from '../types.js'

/**
 * The variant table is hand-edited text, and every rule pinned here is one
 * that would otherwise surface as an opaque eBay 400 at publish: duplicate
 * SKUs, duplicate colours, a comma-price split in half by the field separator.
 */

describe('variant text round-trip', () => {
  it('survives a round trip, German decimal comma included', () => {
    const text = 'WW-DART-SW; Schwarz; 19,90; 3\nWW-DART-PT; Petrol; 21,00; 2'
    const parsed = parseVariants(text)
    expect(parsed.errors).toEqual([])
    expect(parsed.variants).toEqual([
      { sku: 'WW-DART-SW', colour: 'Schwarz', priceEur: 19.9, quantity: 3, imageUrls: [] },
      { sku: 'WW-DART-PT', colour: 'Petrol', priceEur: 21, quantity: 2, imageUrls: [] },
    ])
    expect(parseVariants(formatVariants(parsed.variants)).variants).toEqual(parsed.variants)
  })

  it('accepts a dot as decimal separator too', () => {
    expect(parseVariants('A-1; Rot; 12.50; 1').variants[0]?.priceEur).toBe(12.5)
  })

  it('reports the broken line by number and keeps parsing the rest readable', () => {
    const parsed = parseVariants('A-1; Rot; 12,50; 1\nkaputt ohne semikolons\nA-2; Blau; abc; 1')
    expect(parsed.errors).toHaveLength(2)
    expect(parsed.errors[0]).toContain('Zeile 2')
    expect(parsed.errors[1]).toContain('Zeile 3')
  })

  it('rejects duplicate SKUs and duplicate colours through the schema', () => {
    const dupSku = parseVariants('A-1; Rot; 10,00; 1\nA-1; Blau; 10,00; 1')
    expect(dupSku.variants).toEqual([])
    expect(dupSku.errors.join(' ')).toMatch(/Duplicate SKU/)

    const dupColour = parseVariants('A-1; Rot; 10,00; 1\nA-2; rot; 10,00; 1')
    expect(dupColour.errors.join(' ')).toMatch(/Duplicate colour/)
  })

  it('rejects a SKU with a space — eBay does', () => {
    const parsed = parseVariants('A 1; Rot; 10,00; 1')
    expect(parsed.variants).toEqual([])
    expect(parsed.errors.join(' ')).toMatch(/letters, digits/)
  })

  it('rejects a fractional quantity', () => {
    expect(parseVariants('A-1; Rot; 10,00; 1,5').errors.join(' ')).toMatch(/keine Stückzahl/)
  })

  it('treats empty input as no variants, not as an error', () => {
    expect(parseVariants('')).toEqual({ variants: [], errors: [] })
    expect(parseVariants('\n  \n')).toEqual({ variants: [], errors: [] })
  })
})

describe('EbayVariantsSchema', () => {
  it('keeps the 50-character SKU ceiling', () => {
    const long = { sku: 'x'.repeat(51), colour: 'Rot', priceEur: 10, quantity: 1, imageUrls: [] }
    expect(EbayVariantsSchema.safeParse([long]).success).toBe(false)
  })
})
