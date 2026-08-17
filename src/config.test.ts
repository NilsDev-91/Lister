import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MANUFACTURER_MAX_LENGTHS } from './config.js'

/**
 * The manufacturer block is read from the environment at access time, so these
 * tests set env vars and re-import. The rules matter because eBay rejects the
 * whole offer if the block is malformed, and GPSR is the one part of a listing
 * with legal weight behind it.
 */

const SELLER_KEYS = [
  'SELLER_COMPANY_NAME',
  'SELLER_ADDRESS_LINE1',
  'SELLER_ADDRESS_LINE2',
  'SELLER_CITY',
  'SELLER_STATE',
  'SELLER_POSTAL_CODE',
  'SELLER_COUNTRY',
  'SELLER_EMAIL',
  'SELLER_PHONE',
  'SELLER_CONTACT_URL',
] as const

let saved: Record<string, string | undefined> = {}

async function freshConfig() {
  // The getters read process.env on access, but the module also loads .env at
  // import time — resetting modules keeps each case independent.
  vi.resetModules()
  const mod = await import('./config.js')
  return mod.config
}

beforeEach(() => {
  saved = Object.fromEntries(SELLER_KEYS.map((k) => [k, process.env[k]]))
  for (const k of SELLER_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('manufacturer identity (GPSR)', () => {
  it('is absent when no company name is configured', async () => {
    const config = await freshConfig()
    expect(config.seller.manufacturer).toBeUndefined()
  })

  it('builds the block when the address and one contact route are present', async () => {
    process.env['SELLER_COMPANY_NAME'] = '3D-Werkstatt Nils'
    process.env['SELLER_ADDRESS_LINE1'] = 'Musterstraße 12'
    process.env['SELLER_CITY'] = 'Hamburg'
    process.env['SELLER_POSTAL_CODE'] = '20095'
    process.env['SELLER_EMAIL'] = 'kontakt@example.de'

    const config = await freshConfig()
    const m = config.seller.manufacturer
    expect(m?.companyName).toBe('3D-Werkstatt Nils')
    expect(m?.country).toBe('DE') // defaulted
    expect(m?.email).toBe('kontakt@example.de')
    expect(m?.phone).toBeUndefined()
  })

  it('refuses an address with no way to contact the manufacturer', async () => {
    process.env['SELLER_COMPANY_NAME'] = '3D-Werkstatt Nils'
    process.env['SELLER_ADDRESS_LINE1'] = 'Musterstraße 12'
    process.env['SELLER_CITY'] = 'Hamburg'
    process.env['SELLER_POSTAL_CODE'] = '20095'

    const config = await freshConfig()
    expect(() => config.seller.manufacturer).toThrow(/contact route/i)
  })

  it('refuses a company name with no postal address', async () => {
    process.env['SELLER_COMPANY_NAME'] = '3D-Werkstatt Nils'
    process.env['SELLER_EMAIL'] = 'kontakt@example.de'

    const config = await freshConfig()
    expect(() => config.seller.manufacturer).toThrow(/SELLER_ADDRESS_LINE1/)
  })
})

describe("eBay's field length limits", () => {
  it('keeps the surprisingly tight postal-code limit', () => {
    // Nine characters. Long enough for a German PLZ, not for every format.
    expect(MANUFACTURER_MAX_LENGTHS.postalCode).toBe(9)
  })

  it('covers every field of the identity', () => {
    for (const key of ['companyName', 'addressLine1', 'city', 'country', 'email', 'phone', 'contactUrl'] as const) {
      expect(MANUFACTURER_MAX_LENGTHS[key], key).toBeGreaterThan(0)
    }
  })
})
