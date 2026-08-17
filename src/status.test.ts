import { describe, it, expect, afterEach } from 'vitest'
import { appStatus } from './status.js'
import { config } from './config.js'

/**
 * Two properties matter here, and both have already been broken once.
 *
 * The first is that the variable names this page checks are the ones
 * `config.ts` actually reads — a status page reporting "fehlt" for a variable
 * that is set is worse than none at all.
 *
 * The second is that no credential value ever reaches the output. The page is
 * rendered into HTML and sent to a browser; a leak here ends up in history,
 * screenshots and logs.
 */

const GPSR_ENV = {
  SELLER_COMPANY_NAME: 'Muster Manufaktur',
  SELLER_ADDRESS_LINE1: 'Musterweg 1',
  SELLER_ADDRESS_LINE2: 'Hinterhof',
  SELLER_CITY: 'Musterstadt',
  SELLER_STATE: 'NRW',
  SELLER_POSTAL_CODE: '12345',
  SELLER_COUNTRY: 'DE',
  SELLER_EMAIL: 'kontakt@example.com',
  SELLER_PHONE: '+49 100 200',
  SELLER_CONTACT_URL: 'https://example.com/kontakt',
}

const touched: string[] = []

function setEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    touched.push(key)
    process.env[key] = value
  }
}

afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key]
})

function rows() {
  return appStatus().flatMap((g) => g.rows)
}

describe('GPSR variable names', () => {
  it('checks exactly the variables config.ts reads', () => {
    setEnv(GPSR_ENV)

    // If the names drifted, config would build an identity while the status
    // page still reported missing fields — the failure that shipped once.
    expect(config.seller.manufacturer).toBeDefined()

    const gpsr = appStatus().find((g) => g.title.includes('GPSR'))!
    const missing = gpsr.rows.filter((r) => r.value === 'fehlt').map((r) => r.label)
    expect(missing).toEqual([])
    expect(gpsr.rows.find((r) => r.label === 'Status')?.ok).toBe(true)
  })

  it('does not invent an underscore before a trailing digit', () => {
    const labels = appStatus()
      .find((g) => g.title.includes('GPSR'))!
      .rows.map((r) => r.label)
    expect(labels).toContain('SELLER_ADDRESS_LINE1')
    expect(labels).not.toContain('SELLER_ADDRESS_LINE_1')
    // `stateOrProvince` is read as plain SELLER_STATE; no rule derives that.
    expect(labels).toContain('SELLER_STATE')
    expect(labels).not.toContain('SELLER_STATE_OR_PROVINCE')
  })

  it('calls the block unmaintained when only the defaulted country is present', () => {
    setEnv({ SELLER_COUNTRY: 'DE' })
    const status = appStatus()
      .find((g) => g.title.includes('GPSR'))!
      .rows.find((r) => r.label === 'Status')
    expect(status?.value).toBe('nicht gepflegt')
    // Neither pass nor fail: nothing was attempted.
    expect(status?.ok).toBeNull()
  })

  it('names what is still missing rather than only complaining', () => {
    setEnv({ SELLER_COMPANY_NAME: 'Muster Manufaktur', SELLER_CITY: 'Musterstadt' })
    const status = appStatus()
      .find((g) => g.title.includes('GPSR'))!
      .rows.find((r) => r.label === 'Status')
    expect(status?.ok).toBe(false)
    expect(status?.hint).toContain('SELLER_EMAIL')
  })
})

describe('credential safety', () => {
  it('never puts a secret value in the output', () => {
    const secrets = {
      ANTHROPIC_API_KEY: 'sk-ant-SECRETVALUE-anthropic',
      EBAY_CLIENT_ID: 'SECRETVALUE-ebay-client',
      EBAY_CLIENT_SECRET: 'SECRETVALUE-ebay-secret',
      EBAY_RUNAME: 'SECRETVALUE-runame',
      ETSY_KEYSTRING: 'SECRETVALUE-etsy-key',
      ETSY_SHARED_SECRET: 'SECRETVALUE-etsy-secret',
    }
    setEnv(secrets)

    const serialised = JSON.stringify(appStatus())
    for (const value of Object.values(secrets)) {
      expect(serialised).not.toContain(value)
    }
    // "SECRETVALUE" alone would catch a partial or truncated leak too.
    expect(serialised).not.toContain('SECRETVALUE')
  })

  it('still reports those credentials as present', () => {
    setEnv({ ETSY_KEYSTRING: 'abc', ETSY_SHARED_SECRET: 'def' })
    const keystring = rows().find((r) => r.label === 'ETSY_KEYSTRING')
    expect(keystring?.ok).toBe(true)
    expect(keystring?.value).toBe('gesetzt')
  })

  it('reports a missing credential without throwing', () => {
    // The config getters throw a UserError on a missing value; the status page
    // must read the environment directly, or it crashes on the very case it
    // exists to report.
    delete process.env['ANTHROPIC_API_KEY']
    touched.push('ANTHROPIC_API_KEY')
    expect(() => appStatus()).not.toThrow()
    expect(rows().find((r) => r.label === 'ANTHROPIC_API_KEY')?.ok).toBe(false)
  })

  it('does not crash on an invalid EBAY_ENV', () => {
    setEnv({ EBAY_ENV: 'staging' })
    const env = rows().find((r) => r.label === 'Umgebung')
    expect(env?.ok).toBe(false)
    expect(env?.value).toContain('staging')
  })
})
