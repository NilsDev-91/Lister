import { describe, it, expect } from 'vitest'
import { formatAspects, parseAspects } from './aspect-text.js'

describe('aspect text round-trip', () => {
  it('survives a round trip unchanged', () => {
    const aspects = { Marke: ['Markenlos'], Farbe: ['Schwarz', 'Rot'], Produktart: ['Dartpfeilhalter'] }
    expect(parseAspects(formatAspects(aspects))).toEqual(aspects)
  })

  it('handles an empty set both ways', () => {
    expect(formatAspects({})).toBe('')
    expect(parseAspects('')).toEqual({})
  })

  it('survives values that contain the separator', () => {
    // Real eBay values carry commas — "Höhe 1,5 cm" — and the round trip used
    // to split them into two values. Quoting is what keeps them whole.
    const aspects = { Maße: ['Höhe 1,5 cm', 'Breite 3 cm'], Farbe: ['Rot, matt'] }
    expect(parseAspects(formatAspects(aspects))).toEqual(aspects)
  })

  it('survives values that contain quotes', () => {
    const aspects = { Hinweis: ['Modell "Drache", Version 2'] }
    expect(parseAspects(formatAspects(aspects))).toEqual(aspects)
  })
})

describe('parseAspects', () => {
  it('trims whitespace around names and values', () => {
    expect(parseAspects('  Farbe :  Schwarz ,  Rot  ')).toEqual({ Farbe: ['Schwarz', 'Rot'] })
  })

  it('keeps a colon inside the value', () => {
    // Only the first colon separates; the rest belongs to the value.
    expect(parseAspects('Hinweis: Achtung: heiß')).toEqual({ Hinweis: ['Achtung: heiß'] })
  })

  it('skips a line with no colon rather than inventing an aspect', () => {
    // "Farbe Schwarz" as an aspect name with no value is worse than nothing,
    // because eBay would accept it.
    expect(parseAspects('Farbe Schwarz\nMarke: Markenlos')).toEqual({ Marke: ['Markenlos'] })
  })

  it('skips a line with a name but no values', () => {
    expect(parseAspects('Farbe:\nFarbe:   ,  ')).toEqual({})
  })

  it('skips blank lines', () => {
    expect(parseAspects('\n\nMarke: Markenlos\n\n')).toEqual({ Marke: ['Markenlos'] })
  })

  it('merges a repeated name instead of dropping the first', () => {
    expect(parseAspects('Farbe: Schwarz\nFarbe: Rot')).toEqual({ Farbe: ['Schwarz', 'Rot'] })
  })

  it('accepts Windows line endings', () => {
    expect(parseAspects('Marke: Markenlos\r\nFarbe: Schwarz')).toEqual({
      Marke: ['Markenlos'],
      Farbe: ['Schwarz'],
    })
  })
})

describe('roundtrip corruption regressions (Review 18.08.)', () => {
  it('keeps a bare quote in a value — the inch mark is not a quoting toggle', () => {
    const aspects = { Groesse: ['5" Zoll', 'klein'] }
    expect(parseAspects(formatAspects(aspects))).toEqual(aspects)
  })

  it('keeps a trailing-quote-only value intact', () => {
    const aspects = { Breite: ['12"'] }
    expect(parseAspects(formatAspects(aspects))).toEqual(aspects)
  })

  it('keeps an aspect name that contains scale-notation colons', () => {
    const aspects = { 'Massstab 1:87': ['H0'] }
    expect(parseAspects(formatAspects(aspects))).toEqual(aspects)
  })

  it('still parses a hand-typed line without a space after the colon', () => {
    expect(parseAspects('Farbe:Rot')).toEqual({ Farbe: ['Rot'] })
  })
})
