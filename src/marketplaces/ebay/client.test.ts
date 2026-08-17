import { describe, it, expect } from 'vitest'
import { productIdentityFromAspects } from './client.js'

/**
 * The dedicated brand/mpn fields and the aspects both reach the listing, and
 * the regression pinned here is that they could disagree: `Marke: MeineMarke`
 * in the aspects, `brand: "Markenlos"` hardcoded beside it.
 */

describe('productIdentityFromAspects', () => {
  it('falls back to the unbranded defaults', () => {
    expect(productIdentityFromAspects({})).toEqual({ brand: 'Markenlos', mpn: 'Nicht zutreffend' })
  })

  it('takes the seller-set brand from the Marke aspect', () => {
    expect(productIdentityFromAspects({ Marke: ['Nils Prints'] }).brand).toBe('Nils Prints')
  })

  it('matches the English spellings and ignores case', () => {
    expect(productIdentityFromAspects({ BRAND: ['Nils Prints'] }).brand).toBe('Nils Prints')
    expect(productIdentityFromAspects({ Herstellernummer: ['NP-001'] }).mpn).toBe('NP-001')
    expect(productIdentityFromAspects({ MPN: ['NP-001'] }).mpn).toBe('NP-001')
  })

  it('ignores an empty value rather than sending an empty brand', () => {
    expect(productIdentityFromAspects({ Marke: [' '] }).brand).toBe('Markenlos')
  })
})
