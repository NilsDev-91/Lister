import { describe, it, expect } from 'vitest'
import { toCompetitorListing } from './etsy-source.js'
import type { PublicListing } from '../marketplaces/etsy/client.js'

/**
 * Pinned against what the live API actually returns, which differs from the
 * published schema in two ways that both silently corrupt research:
 * `converted_price` carries the currency we asked for, and the search response
 * does include `views`.
 */

const NOW = Date.parse('2026-08-13T00:00:00.000Z')

function listing(over: Partial<PublicListing> = {}): PublicListing {
  return { listing_id: 1, title: 'Articulated Dragon', ...over }
}

describe('toCompetitorListing', () => {
  it('takes the converted price, not the shop currency', () => {
    // In a live 25-result sample only two shops priced in EUR; the rest were
    // USD, AUD, MAD and GBP. Reading `price` alone discards most of the sample.
    const result = toCompetitorListing(
      listing({
        price: { amount: 1899, divisor: 100, currency_code: 'USD' },
        converted_price: { amount: 1575, divisor: 100, currency_code: 'EUR' },
      }),
      NOW,
    )
    expect(result.priceEur).toBeCloseTo(15.75)
  })

  it('uses the plain price when the shop already prices in euros', () => {
    const result = toCompetitorListing(
      listing({ price: { amount: 2670, divisor: 100, currency_code: 'EUR' } }),
      NOW,
    )
    expect(result.priceEur).toBeCloseTo(26.7)
  })

  it('refuses to guess when no euro figure is available', () => {
    // Without the `currency` parameter there is no converted_price, and an
    // invented exchange rate in a price band is worse than an absent one.
    const result = toCompetitorListing(
      listing({ price: { amount: 450, divisor: 100, currency_code: 'USD' } }),
      NOW,
    )
    expect(result.priceEur).toBeNull()
  })

  it('reads the view count the search response carries', () => {
    expect(toCompetitorListing(listing({ views: 27 }), NOW).views).toBe(27)
  })

  it('leaves views null rather than zero when the field is absent', () => {
    // Zero would be read as "measured, and nobody looked".
    expect(toCompetitorListing(listing(), NOW).views).toBeNull()
  })

  it('derives the listing age from the original creation timestamp', () => {
    const tenDaysAgo = Math.floor(NOW / 1000) - 10 * 86_400
    const result = toCompetitorListing(listing({ original_creation_timestamp: tenDaysAgo }), NOW)
    expect(result.daysListed).toBeCloseTo(10, 5)
  })

  it('falls back to creation_timestamp when the original is missing', () => {
    const fiveDaysAgo = Math.floor(NOW / 1000) - 5 * 86_400
    expect(toCompetitorListing(listing({ creation_timestamp: fiveDaysAgo }), NOW).daysListed).toBeCloseTo(5, 5)
  })

  it('keeps tags and materials, and stringifies the numeric ids', () => {
    const result = toCompetitorListing(
      listing({ listing_id: 4423489679, tags: ['dragon keychain'], materials: ['PLA'], taxonomy_id: 165 }),
      NOW,
    )
    expect(result.id).toBe('4423489679')
    expect(result.categoryId).toBe('165')
    expect(result.tags).toEqual(['dragon keychain'])
    expect(result.materials).toEqual(['PLA'])
  })
})
