import type { CommercialUse, LicenseInfo, Platform } from '../types.js'

/**
 * Licence normalisation for source-platform models.
 *
 * Two things are being decided here, and they are not the same question:
 *
 *   1. May I sell physical prints of this model?
 *   2. May I reuse the designer's renders and description text in my listing?
 *
 * A Creative Commons licence covers the model *and* the page's media, so in
 * practice they move together — but (2) is the one that decides whether this
 * tool downloads the MakerWorld images or asks you for your own photos.
 *
 * This module is deliberately conservative. It reports `unknown` whenever it
 * cannot recognise the licence string, which routes to a prompt rather than to
 * a silent yes. It is a routing aid, not legal advice.
 */

/**
 * Creative Commons appears on MakerWorld in two spellings — the abbreviation
 * chain ("CC BY-NC-SA 4.0") and the spelled-out name ("Attribution-NonCommercial-
 * ShareAlike"). Both are parsed into the same three flags.
 */
interface CcFlags {
  nonCommercial: boolean
  shareAlike: boolean
  noDerivatives: boolean
}

interface LicenseEntry {
  code: string
  commercial: CommercialUse
  note: string
}

/**
 * MakerWorld's own licence enumeration, taken from the values that appear
 * literally in `design.license`.
 *
 * Note the Creative Commons values are BARE — the field says `BY-NC`, not
 * `CC BY-NC` — so exact matching has to come before any "CC"-anchored regex,
 * which would otherwise miss every one of them.
 */
const MAKERWORLD_LICENSES: Record<string, LicenseEntry> = {
  cc0: { code: 'CC0-1.0', commercial: 'yes', note: 'Public domain: commercial use is permitted and no attribution is required.' },
  by: { code: 'CC-BY-4.0', commercial: 'yes', note: 'Attribution required.' },
  'by-sa': { code: 'CC-BY-SA-4.0', commercial: 'yes', note: 'Attribution required. ShareAlike governs derivative models, not the sale of a print.' },
  'by-nd': { code: 'CC-BY-ND-4.0', commercial: 'yes', note: 'Attribution required. You may sell prints of the model as published, but not of a modified version.' },
  'by-nc': { code: 'CC-BY-NC-4.0', commercial: 'no', note: 'The NonCommercial term forbids selling prints.' },
  'by-nc-sa': { code: 'CC-BY-NC-SA-4.0', commercial: 'no', note: 'The NonCommercial term forbids selling prints.' },
  'by-nc-nd': { code: 'CC-BY-NC-ND-4.0', commercial: 'no', note: 'The NonCommercial term forbids selling prints.' },
  'standard digital file license': {
    code: 'BAMBU-SDFL',
    commercial: 'no',
    note: "Bambu's Standard Digital File License is personal-use only.",
  },
  'standard digital file license - community use': {
    code: 'BAMBU-SDFL-COMMUNITY',
    commercial: 'no',
    note: 'The Community Use variant still does not grant the right to sell prints.',
  },
  'standard digital file license - platform print only (sdfl-ppo)': {
    code: 'BAMBU-SDFL-PPO',
    commercial: 'no',
    note: 'Platform Print Only: prints may be made through MakerWorld itself, not sold independently.',
  },
  'makerworld exclusive license': {
    code: 'MAKERWORLD-EXCLUSIVE',
    commercial: 'no',
    note: 'The MakerWorld Exclusive License does not permit selling prints elsewhere.',
  },
}

/**
 * Cults3D's licence catalog, verified against the live `licenses` query on
 * 2026-08-18 — `code`, `name` and `spdxId` below are the platform's own values
 * (fixture: cults3d/__fixtures__/licenses.json). Keyed by both the code and
 * the English display name, because the adapter passes the readable name and
 * the code is the stable fallback.
 *
 * The verdicts follow the licence terms, cross-checked against the platform's
 * `allowsCommercialUse` flag. Two places disagree, and the entries say which
 * side wins:
 *
 *  - Cults3D flags CC0 as non-commercial. CC0-1.0 waives all rights — the
 *    licence text governs, so it stays `yes`, same as everywhere else.
 *  - It flags GPL/LGPL/CERN-OHL as non-commercial although their texts permit
 *    commercial use with conditions. Whether those conditions reach a
 *    *printed object* at all is unsettled, so they stay `unknown` and route
 *    to the prompt — the state for "the user may know more than the page".
 */
function cults3dLicenses(): Record<string, LicenseEntry> {
  const entries: [code: string, name: string, entry: LicenseEntry][] = [
    ['cults_pu', 'CULTS PU - Private Use', {
      code: 'LicenseRef-Cults-PU',
      commercial: 'no',
      note: "Cults3D's default Private Use licence is personal-use only.",
    }],
    ['cults_cu', 'CULTS CU - Commercial Use', {
      code: 'LicenseRef-Cults-CU',
      commercial: 'yes',
      note: "Cults3D's Commercial Use licence permits selling prints.",
    }],
    ['cults_cu_nd', 'CULTS CU-ND - Commercial Use - No Derivative', {
      code: 'LicenseRef-Cults-CU-ND',
      commercial: 'yes',
      note: 'Commercial use of the design as published — derivatives are not covered.',
    }],
    ['cc_by', 'CC BY - Attribution', {
      code: 'CC-BY-4.0',
      commercial: 'yes',
      note: 'Attribution required.',
    }],
    ['cc_by_sa', 'CC BY-SA - Attribution - Share alike', {
      code: 'CC-BY-SA-4.0',
      commercial: 'yes',
      note: 'Attribution required. ShareAlike governs derivative models, not the sale of a print.',
    }],
    ['cc_by_nd', 'CC BY-ND - Attribution - No derivatives', {
      code: 'CC-BY-ND-4.0',
      commercial: 'yes',
      note: 'Attribution required. You may sell prints of the model as published, but not of a modified version.',
    }],
    ['cc_by_nc', 'CC BY-NC - Attribution - Non commercial', {
      code: 'CC-BY-NC-4.0',
      commercial: 'no',
      note: 'The NonCommercial term forbids selling prints.',
    }],
    ['cc_by_nc_sa', 'CC BY-NC-SA - Attribution - Non commercial - Share alike', {
      code: 'CC-BY-NC-SA-4.0',
      commercial: 'no',
      note: 'The NonCommercial term forbids selling prints.',
    }],
    ['cc_by_nc_nd', 'CC BY-NC-ND - Attribution - Non commercial - No derivatives', {
      code: 'CC-BY-NC-ND-4.0',
      commercial: 'no',
      note: 'The NonCommercial term forbids selling prints.',
    }],
    ['cc_pddc', 'CC0 - Creative Commons public domain', {
      code: 'CC0-1.0',
      commercial: 'yes',
      note: 'Public domain: commercial use is permitted and no attribution is required. (Cults3D\'s own filter flag says otherwise; the licence text governs.)',
    }],
    ['mit', 'MIT License', {
      code: 'MIT',
      commercial: 'yes',
      note: 'The MIT License permits commercial use; keep the licence notice with the design files.',
    }],
    ['gpl', 'GNU GPL - GNU General Public License 3.0', {
      code: 'GPL-3.0-or-later',
      commercial: 'unknown',
      note: 'The GPL permits commercial use of the files under copyleft conditions, but whether those conditions bind a printed object is unsettled — and Cults3D itself flags this licence as non-commercial. Decide deliberately.',
    }],
    ['lgpl', 'GNU LGPL - GNU Lesser General Public License 3.0', {
      code: 'LGPL-3.0-or-later',
      commercial: 'unknown',
      note: 'The LGPL permits commercial use of the files under copyleft conditions, but whether those conditions bind a printed object is unsettled — and Cults3D itself flags this licence as non-commercial. Decide deliberately.',
    }],
    ['cern_ohl', 'CERN OHL - CERN Open Hardware Licence 1.2', {
      code: 'CERN-OHL-1.2',
      commercial: 'unknown',
      note: 'The CERN OHL permits commercial manufacture under documentation conditions, but Cults3D itself flags this licence as non-commercial. Decide deliberately.',
    }],
  ]

  const table: Record<string, LicenseEntry> = {}
  for (const [code, name, entry] of entries) {
    table[code] = entry
    table[name.toLowerCase()] = entry
  }
  return table
}

/**
 * Each platform speaks its own licence vocabulary, so the exact-match lookup
 * is per platform: MakerWorld's bare `BY-NC` must not be assumed to mean the
 * same thing when a different platform emits it — an unrecognised value routes
 * to `unknown`, which prompts the user instead of silently deciding.
 *
 * Entries are added only once they have been verified against a real API
 * response from that platform (see the adapters' fixtures). Until then a
 * platform's table is empty and everything it emits outside the universal
 * Creative Commons spellings resolves to `unknown` — the safe direction.
 */
const PLATFORM_LICENSES: Record<Platform, Record<string, LicenseEntry>> = {
  MAKERWORLD: MAKERWORLD_LICENSES,
  CULTS3D: cults3dLicenses(),
  PRINTABLES: {},
}

/** Matches the abbreviation form and captures whatever follows "BY". */
const CC_ABBREV = /\bcc[\s\-_]*by((?:[\s\-_]*(?:nc|sa|nd))*)\b/i
/** Matches the spelled-out form; the individual terms are detected separately. */
const CC_SPELLED = /\battribution\b/i
const CC_CONTEXT = /\bcreative\s*commons\b|\bcc\b/i

const CC0 = /\bcc0\b|\bpublic\s*domain\b|\bno\s*rights\s*reserved\b/i
const SDFL = /\bstandard\s+digital\s+file\s+license\b|\bsdfl\b/i

function detectCc(text: string): CcFlags | null {
  const abbrev = CC_ABBREV.exec(text)
  if (abbrev) {
    const suffix = (abbrev[1] ?? '').toLowerCase()
    return {
      nonCommercial: /\bnc\b|nc/.test(suffix),
      shareAlike: /sa/.test(suffix),
      noDerivatives: /nd/.test(suffix),
    }
  }

  // Spelled-out form. Require some Creative Commons context so that a stray
  // "Attribution" in prose does not get read as a licence. A compound like
  // "Attribution-NonCommercial" is its own context: no prose says that by
  // accident, and requiring a literal "CC" made this branch unreachable for
  // exactly the strings it was written for.
  const spelledCompound = /\battribution[\s\-_]*(non[\s\-_]*commercial|share[\s\-_]*alike|no[\s\-_]*deriv)/i
  if (CC_SPELLED.test(text) && (CC_CONTEXT.test(text) || spelledCompound.test(text))) {
    return {
      nonCommercial: /\bnon[\s\-_]*commercial\b/i.test(text),
      shareAlike: /\bshare[\s\-_]*alike\b/i.test(text),
      // `NoDerivatives` — the official CC 4.0 plural — must match too; with
      // `(ative|s)?` alone the trailing "s" of the plural broke the \b.
      noDerivatives: /\bno[\s\-_]*deriv(?:ative(?:s)?|s)?\b/i.test(text),
    }
  }

  return null
}

/** Builds the canonical code, e.g. { nc, sa } -> "CC-BY-NC-SA-4.0". */
function ccCode(flags: CcFlags): string {
  const parts = ['CC', 'BY']
  if (flags.nonCommercial) parts.push('NC')
  if (flags.shareAlike) parts.push('SA')
  if (flags.noDerivatives) parts.push('ND')
  return `${parts.join('-')}-4.0`
}

/**
 * `platform` is deliberately required, not defaulted. With a MakerWorld
 * default, an adapter that forgets the argument silently inherits MakerWorld's
 * table — and its bare `BY` entry would turn an unrelated platform's licence
 * string into a silent commercial-yes. Requiring it makes that mistake a
 * compile error instead.
 */
export function normaliseLicense(raw: string, platform: Platform): LicenseInfo {
  const text = raw.trim()

  if (!text) {
    return {
      raw,
      code: null,
      commercialUse: 'unknown',
      reason: 'No licence was found on the model page.',
    }
  }

  // Exact match against the platform's own vocabulary first. MakerWorld's
  // Creative Commons values are bare ("BY-NC"), which no CC-anchored regex
  // would catch. `hasOwn` guard: the licence string comes off a web page, and
  // a value like "constructor" would otherwise hit Object.prototype and
  // return a function.
  const table = PLATFORM_LICENSES[platform]
  const key = text.toLowerCase()
  const exact = Object.hasOwn(table, key) ? table[key] : undefined
  if (exact) {
    const attribution =
      exact.commercial === 'yes' && exact.code !== 'CC0-1.0'
        ? ' The tool adds the required credit line to the description.'
        : ''
    return {
      raw,
      code: exact.code,
      commercialUse: exact.commercial,
      reason: `${raw} — ${exact.note}${attribution}`,
    }
  }

  // Bambu's own licence is checked first among the fuzzy matchers: its text can
  // contain the word "license" alongside CC boilerplate on some pages, and it
  // is the stricter of the two, so it wins ties.
  if (SDFL.test(text)) {
    return {
      raw,
      code: 'BAMBU-SDFL',
      commercialUse: 'no',
      reason:
        "Bambu's Standard Digital File License is personal-use only — it permits neither selling prints nor reusing the designer's media.",
    }
  }

  if (CC0.test(text)) {
    return {
      raw,
      code: 'CC0-1.0',
      commercialUse: 'yes',
      reason: 'CC0 places the work in the public domain: commercial use is permitted and no attribution is required.',
    }
  }

  const flags = detectCc(text)
  if (flags) {
    const code = ccCode(flags)

    if (flags.nonCommercial) {
      return {
        raw,
        code,
        commercialUse: 'no',
        reason: `${code} carries the NonCommercial term, so selling prints and reusing the designer's images are both off the table.`,
      }
    }

    const notes: string[] = ["Attribution to the designer is required — the tool adds it to the description."]
    if (flags.shareAlike) {
      notes.push('ShareAlike governs derivative *models*, not the sale of a print — but it matters if you remix the file.')
    }
    if (flags.noDerivatives) {
      notes.push('NoDerivatives means you may sell prints of the model as published, but not of a modified version.')
    }

    return {
      raw,
      code,
      commercialUse: 'yes',
      reason: `${code} permits commercial use. ${notes.join(' ')}`,
    }
  }

  return {
    raw,
    code: null,
    commercialUse: 'unknown',
    reason: `Unrecognised licence "${text}". Check the model page yourself before selling prints or reusing its images.`,
  }
}

/** Does this licence require crediting the designer in the listing? */
export function requiresAttribution(license: LicenseInfo): boolean {
  if (!license.code) return true // unknown → credit anyway, it costs nothing
  return license.code !== 'CC0-1.0'
}

export interface LicenseGateDecision {
  /** May the tool download and upload the designer's renders? */
  mayReuseImages: boolean
  /** May the tool feed the designer's description text to the copywriter? */
  mayReuseText: boolean
  /** Must the user confirm before anything is published? */
  needsConfirmation: boolean
  /**
   * True when the seller asserted rights the page does not show — typically a
   * commercial licence bought separately.
   *
   * The listing copy depends on this. The licence printed on the page is then
   * *not* the one the sale runs under, so naming it in the description would
   * advertise a licence that forbids the very sale being made.
   */
  overridden: boolean
  reason: string
}

/**
 * Turns a licence into the two decisions the pipeline actually branches on.
 *
 * `allowOverride` exists because the licence on the page is not always the whole
 * story — a designer may have granted a commercial licence separately, or you
 * may be listing your own model. The override is explicit and per-run, never
 * sticky, so it cannot silently become the default.
 */
export function gate(
  license: LicenseInfo,
  allowOverride = false,
  /**
   * The seller's separate assertion that their licence also covers the
   * designer's photographs. Only consulted alongside `allowOverride`: pictures
   * cannot be licensed for a sale that is not.
   */
  sourceImagesLicensed = false,
): LicenseGateDecision {
  if (allowOverride) {
    return {
      // A separately bought licence usually covers the *model*, not the
      // designer's photos and description — those stay theirs. Reusing them is
      // a copyright question of its own and a common takedown trigger, so the
      // override alone does not unlock them; it takes the second, explicit
      // claim that the pictures are covered too.
      mayReuseImages: sourceImagesLicensed,
      mayReuseText: false,
      needsConfirmation: true,
      overridden: true,
      reason:
        `Licence gate overridden by --i-have-commercial-rights (page says: ${license.raw || 'no licence found'}). ` +
        (sourceImagesLicensed
          ? "Selling prints and using the designer's images are both on you to have covered; the description text stays off-limits."
          : "Selling prints is on you to have covered; the designer's images and text remain off-limits unless your licence explicitly includes them."),
    }
  }

  switch (license.commercialUse) {
    case 'yes': {
      // A licence can permit the sale without touching the page's media. The
      // Creative Commons family attaches to the published content as a whole,
      // photos and text included — but a sale-only licence like Cults3D's CU
      // grants "print, sell and distribute 3D prints" and says nothing about
      // the designer's photos or description (verified against
      // cults3d.com/en/licenses, 2026-08-18); MIT covers the uploaded files,
      // not the page. There the media stay the designer's unless the seller
      // separately asserts otherwise — the same second claim the override
      // path takes, and for the same reason.
      const coversPageMedia = license.code !== null && /^CC(0|-BY)/.test(license.code)
      return {
        mayReuseImages: coversPageMedia || sourceImagesLicensed,
        mayReuseText: coversPageMedia,
        needsConfirmation: false,
        overridden: false,
        reason: coversPageMedia
          ? license.reason
          : `${license.reason} The licence covers selling prints; the designer's photos and description are not shown to be included.`,
      }
    }
    case 'no':
    case 'unknown':
      return {
        mayReuseImages: false,
        mayReuseText: false,
        needsConfirmation: true,
        overridden: false,
        reason: license.reason,
      }
  }
}
