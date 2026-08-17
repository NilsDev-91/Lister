import { statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { DATA_DIR } from './util/paths.js'
import { listAll } from './store/db.js'
import { SETTINGS_PATH } from './settings.js'
import * as ebayAuth from './marketplaces/ebay/auth.js'
import * as etsyAuth from './marketplaces/etsy/auth.js'
import { lastRateLimit } from './marketplaces/etsy/client.js'

/**
 * What is configured, and what is missing.
 *
 * Its own module because `config.ts` cannot import the auth modules — they
 * import it — and because the one rule this file must never break is easier to
 * hold in one place: **no value of any credential is ever returned.** Only
 * whether it is set, when a token expires, and which scopes it carries. There
 * is no redaction step to forget, because the secrets never enter.
 */

export interface StatusRow {
  label: string
  /** null when the row is informational rather than a pass/fail. */
  ok: boolean | null
  value: string
  hint?: string
}

export interface StatusGroup {
  title: string
  rows: StatusRow[]
}

const isSet = (name: string): boolean => Boolean(process.env[name])
const setOrMissing = (name: string): StatusRow => ({
  label: name,
  ok: isSet(name),
  value: isSet(name) ? 'gesetzt' : 'fehlt',
})

function formatDate(epochMs: number | null | undefined): string {
  if (!epochMs) return '—'
  return new Date(epochMs).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Reads a stored token set without letting configuration errors escape.
 *
 * `storedTokens()` resolves the account name through `config.ebay.env`, which
 * throws on a bad value — so a typo in `EBAY_ENV` took down the entire status
 * page, the one screen whose job is to point at that typo. A diagnostic must
 * survive the thing it diagnoses.
 */
function tokenRows(label: string, read: () => ReturnType<typeof ebayAuth.storedTokens>): StatusRow[] {
  let tokens: ReturnType<typeof ebayAuth.storedTokens>
  try {
    tokens = read()
  } catch (error) {
    return [
      {
        label,
        ok: false,
        value: 'nicht lesbar',
        hint: `Die Konfiguration verhindert den Zugriff: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]
  }

  if (!tokens) {
    return [{ label, ok: false, value: 'nicht verbunden', hint: 'Über die CLI verbinden — die Einwilligung läuft im Browser.' }]
  }
  const accessLive = tokens.accessExpiresAt > Date.now()
  const refreshLive = tokens.refreshExpiresAt === null || tokens.refreshExpiresAt > Date.now()
  return [
    {
      label,
      ok: refreshLive,
      value: refreshLive ? 'verbunden' : 'Refresh-Token abgelaufen',
      ...(refreshLive ? {} : { hint: 'Neu verbinden — ohne gültigen Refresh geht kein Aufruf mehr.' }),
    },
    {
      label: `${label} · Access-Token`,
      ok: null,
      value: accessLive ? `gültig bis ${formatDate(tokens.accessExpiresAt)}` : 'abgelaufen, wird automatisch erneuert',
    },
    {
      label: `${label} · Refresh-Token`,
      ok: null,
      value: tokens.refreshExpiresAt === null ? 'läuft nicht ab' : `gültig bis ${formatDate(tokens.refreshExpiresAt)}`,
    },
    { label: `${label} · Berechtigungen`, ok: null, value: `${tokens.scopes.length} Scope(s)` },
  ]
}

function fileSize(path: string): string {
  try {
    return `${(statSync(path).size / 1024).toFixed(1)} KB`
  } catch {
    return 'noch nicht angelegt'
  }
}

export function appStatus(): StatusGroup[] {
  const groups: StatusGroup[] = []

  groups.push({
    title: 'Claude',
    rows: [
      setOrMissing('ANTHROPIC_API_KEY'),
      { label: 'Modell', ok: null, value: config.anthropic.model },
    ],
  })

  // Reading `EBAY_ENV` through the config getter would throw on a bad value,
  // and a status page that crashes on the thing it is meant to diagnose is
  // worse than useless.
  const rawEnv = process.env['EBAY_ENV'] ?? 'sandbox'
  const envValid = rawEnv === 'sandbox' || rawEnv === 'production'
  groups.push({
    title: 'eBay',
    rows: [
      {
        label: 'Umgebung',
        ok: envValid ? null : false,
        value: envValid ? rawEnv : `ungültig: "${rawEnv}"`,
        ...(envValid
          ? rawEnv === 'sandbox'
            ? { hint: 'Sandbox-Daten sind nicht echt — Kategorievorschläge und Suchtreffer dort sind wertlos.' }
            : {}
          : { hint: 'EBAY_ENV muss "sandbox" oder "production" sein.' }),
      },
      setOrMissing('EBAY_CLIENT_ID'),
      setOrMissing('EBAY_CLIENT_SECRET'),
      {
        ...setOrMissing('EBAY_RUNAME'),
        hint: 'Kein URL, sondern ein Token aus dem Portal. Nur für die Nutzer-Einwilligung nötig, nicht für die Recherche.',
      },
      { label: 'Marktplatz', ok: null, value: config.ebay.marketplaceId },
      ...tokenRows('eBay-Verbindung', () => ebayAuth.storedTokens()),
    ],
  })

  const limits = lastRateLimit()
  groups.push({
    title: 'Etsy',
    rows: [
      { ...setOrMissing('ETSY_KEYSTRING'), hint: 'Der API-Header ist keystring:shared_secret — beide werden gebraucht.' },
      setOrMissing('ETSY_SHARED_SECRET'),
      ...tokenRows('Etsy-Verbindung', () => etsyAuth.storedTokens()),
      {
        label: 'Kontingent (letzter Aufruf)',
        ok: null,
        value:
          limits.remainingToday === null
            ? 'in diesem Prozess noch kein Aufruf'
            : `${limits.remainingToday}${limits.perDay ? ` / ${limits.perDay}` : ''} heute übrig`,
      },
    ],
  })

  groups.push(gpsrGroup())

  const store = join(DATA_DIR, 'listings.json')
  groups.push({
    title: 'Ablage',
    rows: [
      { label: 'Datenverzeichnis', ok: null, value: DATA_DIR, hint: 'Bewusst außerhalb des Repos — Tokens dürfen nie in ein Commit geraten.' },
      { label: 'listings.json', ok: null, value: `${fileSize(store)} · ${countListings()}` },
      { label: 'settings.json', ok: null, value: fileSize(SETTINGS_PATH) },
      { label: 'tokens.json', ok: null, value: fileSize(join(DATA_DIR, 'tokens.json')) },
      {
        label: '.env',
        ok: existsSync(join(process.cwd(), '.env')),
        value: existsSync(join(process.cwd(), '.env')) ? 'vorhanden' : 'fehlt',
        hint: 'Enthält alle Zugangsdaten. Wird hier nie angezeigt, nur auf Vorhandensein geprüft.',
      },
    ],
  })

  return groups
}

function countListings(): string {
  // A corrupt store must not read as "0 Inserate" — reading it has just moved
  // the file to a .corrupt backup, and "0" would hide exactly that event. A
  // diagnosis page's one job is to say what happened.
  try {
    return `${listAll().length} Inserat(e)`
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0]! : String(error)
    return `beschädigt — ${message}`
  }
}

/**
 * The GPSR variable names, spelled out rather than derived.
 *
 * Deriving them from the `ManufacturerIdentity` keys looks tidier and is wrong:
 * `addressLine1` would become `SELLER_ADDRESS_LINE_1` where `config.ts` reads
 * `SELLER_ADDRESS_LINE1`, and `stateOrProvince` maps to plain `SELLER_STATE`,
 * which no rule can produce. A status page that reports "fehlt" for a variable
 * that is actually set is worse than no status page.
 *
 * Kept beside `config.ts`'s `seller.manufacturer` — change one, change both.
 */
const GPSR_VARS = [
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

/** Contact routes: eBay needs at least one, not all three. */
const GPSR_CONTACT_VARS = ['SELLER_EMAIL', 'SELLER_PHONE', 'SELLER_CONTACT_URL'] as const

function gpsrGroup(): StatusGroup {
  const set = GPSR_VARS.filter(isSet)
  const hasCompany = isSet('SELLER_COMPANY_NAME')
  const hasContact = GPSR_CONTACT_VARS.some(isSet)

  // `SELLER_COUNTRY` defaults to DE in config, so it can read as set while
  // nothing else is — "not maintained" means no company name, not zero rows.
  const untouched = !hasCompany && set.length <= 1

  const missing: string[] = []
  if (!hasCompany) missing.push('SELLER_COMPANY_NAME')
  if (!hasContact) missing.push(`eines von ${GPSR_CONTACT_VARS.join(', ')}`)

  return {
    title: 'Hersteller-Angaben (GPSR)',
    rows: [
      {
        label: 'Status',
        ok: untouched ? null : hasCompany && hasContact,
        value: untouched ? 'nicht gepflegt' : `${set.length} von ${GPSR_VARS.length} Feldern gesetzt`,
        hint: untouched
          ? 'Wer selbst druckt und unter eigenem Namen verkauft, ist Hersteller im Sinne der GPSR. eBay verlangt die Angaben je nach Kategorie.'
          : missing.length
            ? `Es fehlt noch: ${missing.join(' und ')}.`
            : 'Vollständig. Ohne Firmenname wird der ganze Block weggelassen — halb gefüllt wäre schlimmer als gar nicht.',
      },
      ...GPSR_VARS.map(setOrMissing),
    ],
  }
}
