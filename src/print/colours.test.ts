import { describe, it, expect } from 'vitest'
import { germanColourName } from './colours.js'

describe('germanColourName', () => {
  it('maps the filament hexes to German aspect values', () => {
    // #898989 is the real value from the user's export.
    expect(germanColourName('#898989')).toBe('Grau')
    expect(germanColourName('#000000')).toBe('Schwarz')
    expect(germanColourName('#FFFFFF')).toBe('Weiß')
    expect(germanColourName('#C41E1E')).toBe('Rot')
    expect(germanColourName('27963C')).toBe('Grün') // bare hex, no hash
  })

  it('returns null for anything that is not a hex colour', () => {
    expect(germanColourName('')).toBeNull()
    expect(germanColourName('grau')).toBeNull()
    expect(germanColourName('#12')).toBeNull()
  })
})
