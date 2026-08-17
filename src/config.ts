import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from './util/log.js'

/**
 * Minimal .env loader. Node 20.6+ has `--env-file`, but relying on it would
 * force every invocation through a flag; reading the file ourselves keeps
 * `npx lister` working.
 */
function loadDotEnv(): void {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) return
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (key in process.env) continue // real env wins over the file
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadDotEnv()

export type EbayEnv = 'sandbox' | 'production'

/**
 * eBay's GPSR contact block. Field lengths are eBay's, and it rejects anything
 * longer, so they are enforced before the request rather than after.
 */
export interface ManufacturerIdentity {
  companyName: string
  addressLine1: string
  addressLine2?: string | undefined
  city: string
  stateOrProvince?: string | undefined
  postalCode: string
  /** ISO 3166-1 alpha-2. */
  country: string
  email?: string | undefined
  phone?: string | undefined
  contactUrl?: string | undefined
}

export const MANUFACTURER_MAX_LENGTHS: Record<keyof ManufacturerIdentity, number> = {
  companyName: 100,
  addressLine1: 180,
  addressLine2: 180,
  city: 64,
  stateOrProvince: 64,
  // Nine characters, which is tighter than it looks — eBay's limit, not a typo.
  postalCode: 9,
  country: 2,
  email: 180,
  phone: 64,
  contactUrl: 250,
}

function required(name: string, hint: string): string {
  const value = process.env[name]
  if (!value) throw new UserError(`Missing ${name}`, hint)
  return value
}

export const config = {
  anthropic: {
    get apiKey(): string {
      return required('ANTHROPIC_API_KEY', 'Get a key at https://console.anthropic.com and put it in .env')
    },
    model: process.env.LISTER_MODEL ?? 'claude-opus-5',
  },

  ebay: {
    get env(): EbayEnv {
      const v = process.env.EBAY_ENV ?? 'sandbox'
      if (v !== 'sandbox' && v !== 'production') {
        throw new UserError(`EBAY_ENV must be "sandbox" or "production", got "${v}"`)
      }
      return v
    },
    get clientId(): string {
      return required('EBAY_CLIENT_ID', 'Create a keyset at https://developer.ebay.com/my/keys')
    },
    get clientSecret(): string {
      return required('EBAY_CLIENT_SECRET', 'Create a keyset at https://developer.ebay.com/my/keys')
    },
    get ruName(): string {
      return required(
        'EBAY_RUNAME',
        'eBay identifies your redirect by a RuName, not a URL. Create one under your keyset in the developer portal.',
      )
    },
    marketplaceId: process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_DE',
  },

  /**
   * Your identity as the manufacturer, for EU product-safety law.
   *
   * Under GPSR (EU 2023/988) Art. 3, someone who makes a product and sells it
   * under their own name *is* the manufacturer. Because you are established in
   * the EU you are also your own responsible economic operator, so eBay wants
   * `regulatory.manufacturer` filled in and `responsiblePersons` left off —
   * that array is for manufacturers based outside the EU.
   *
   * Optional here: eBay only requires it for certain categories, and the tool
   * checks which. Filling it in is still the safer default.
   */
  seller: {
    get manufacturer(): ManufacturerIdentity | undefined {
      const companyName = process.env['SELLER_COMPANY_NAME']
      if (!companyName) return undefined

      const identity: ManufacturerIdentity = {
        companyName,
        addressLine1: required('SELLER_ADDRESS_LINE1', 'GPSR needs a full postal address for the manufacturer.'),
        addressLine2: process.env['SELLER_ADDRESS_LINE2'] || undefined,
        city: required('SELLER_CITY', 'GPSR needs a full postal address for the manufacturer.'),
        stateOrProvince: process.env['SELLER_STATE'] || undefined,
        postalCode: required('SELLER_POSTAL_CODE', 'GPSR needs a full postal address for the manufacturer.'),
        country: process.env['SELLER_COUNTRY'] ?? 'DE',
        email: process.env['SELLER_EMAIL'] || undefined,
        phone: process.env['SELLER_PHONE'] || undefined,
        contactUrl: process.env['SELLER_CONTACT_URL'] || undefined,
      }

      if (!identity.email && !identity.phone && !identity.contactUrl) {
        throw new UserError(
          'GPSR requires a contact route for the manufacturer.',
          'Set at least one of SELLER_EMAIL, SELLER_PHONE or SELLER_CONTACT_URL.',
        )
      }

      // The length table exists to fail here, at configuration, rather than as
      // an opaque 400 in the middle of a publish — declaring it without ever
      // checking it enforced nothing.
      for (const [field, max] of Object.entries(MANUFACTURER_MAX_LENGTHS) as [keyof ManufacturerIdentity, number][]) {
        const value = identity[field]
        if (typeof value === 'string' && value.length > max) {
          throw new UserError(
            `SELLER ${String(field)} is ${value.length} characters; eBay allows ${max}.`,
            'Shorten the value in .env — eBay rejects the regulatory block otherwise.',
          )
        }
      }

      return identity
    },
  },

  etsy: {
    get keystring(): string {
      return required('ETSY_KEYSTRING', 'Register an app at https://www.etsy.com/developers/your-apps')
    },
    get sharedSecret(): string {
      return required('ETSY_SHARED_SECRET', 'Register an app at https://www.etsy.com/developers/your-apps')
    },
    redirectUri: process.env.ETSY_REDIRECT_URI ?? 'http://localhost:3456/callback',
  },
} as const
