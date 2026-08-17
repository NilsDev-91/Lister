/**
 * eBay title hygiene — the rules that cost ranking rather than the ones that
 * cost a rejection.
 *
 * The hard rules (length, emoji, question mark) live in `EbayTitleSchema`,
 * because a listing that breaks them should never reach a marketplace. What is
 * here is measured damage: eBay reports up to **four times lower click rate**
 * for titles carrying symbols, and click rate feeds the popularity signal that
 * feeds Best Match. None of it is worth refusing to publish over.
 *
 * Pure, so the wording can be pinned without a listing or a network call.
 */

export type TitleFindingCode = 'symbols' | 'shouting' | 'repeated-word' | 'keyword-buried' | 'short'

export interface TitleFinding {
  code: TitleFindingCode
  title: string
  detail: string
}

/** How much of an eBay title a phone shows before cutting it off. */
export const MOBILE_VISIBLE = 60
export const MAX_LENGTH = 80

/** Symbols eBay names as harmful in titles. */
const HARMFUL_SYMBOLS = ['!', '*', '•', '★', '~', '|', '#', '@', '^', '+', '_']

/** Words too small or too common to count as a repeat worth reporting. */
const IGNORED_REPEATS = new Set([
  'für', 'mit', 'und', 'aus', 'der', 'die', 'das', 'den', 'dem', 'ein', 'eine',
  'for', 'with', 'and', 'the', 'from',
])

function words(title: string): string[] {
  return title.split(/[\s,.\-/|]+/u).filter(Boolean)
}

/**
 * Reports what would make an otherwise valid title perform badly.
 *
 * `keyword` is the strongest phrase the research found, when there is one. It
 * is checked against the first 60 characters rather than the whole title
 * because that is all a phone shows — eBay says word order does not affect
 * matching, but it plainly affects whether anyone clicks.
 */
export function auditEbayTitle(title: string, keyword?: string | null): TitleFinding[] {
  const findings: TitleFinding[] = []

  const found = HARMFUL_SYMBOLS.filter((symbol) => title.includes(symbol))
  if (found.length) {
    findings.push({
      code: 'symbols',
      title: 'Title contains symbols eBay penalises',
      detail: `${found.join(' ')} — eBay measures up to four times lower click rate on titles carrying these.`,
    })
  }

  // Terms that are *correctly* written in capitals — materials and common
  // sizing/technical acronyms. Without the list, every title naming PETG or
  // ASA drew a shouting warning for spelling its own material right.
  const CAPITALS_ALLOWED = new Set(['PETG', 'ASA', 'TPU', 'ABS', 'PLA', 'PVA', 'HIPS', 'XXL', 'XXXL', 'USB', 'LED', 'RGB', 'DIN'])

  // Three letters or more, so "PLA", "3D" and "XL" are not mistaken for shouting.
  const shouted = words(title).filter(
    (w) => w.length >= 4 && w === w.toUpperCase() && /\p{L}/u.test(w) && !CAPITALS_ALLOWED.has(w),
  )
  if (shouted.length) {
    findings.push({
      code: 'shouting',
      title: 'Title contains words in capitals',
      detail: `${shouted.join(', ')} — eBay states this can lower ranking.`,
    })
  }

  const seen = new Map<string, number>()
  for (const word of words(title)) {
    const key = word.toLowerCase()
    if (key.length < 3 || IGNORED_REPEATS.has(key)) continue
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  const repeats = [...seen.entries()].filter(([, n]) => n > 1).map(([w]) => w)
  if (repeats.length) {
    findings.push({
      code: 'repeated-word',
      title: 'Title repeats a keyword',
      detail: `${repeats.join(', ')} — a repeat wins nothing on eBay and spends characters that could carry a second search term.`,
    })
  }

  if (keyword) {
    const head = title.slice(0, MOBILE_VISIBLE).toLowerCase()
    if (!head.includes(keyword.toLowerCase())) {
      findings.push({
        code: 'keyword-buried',
        title: 'Strongest keyword is not visible on mobile',
        detail: `"${keyword}" does not appear in the first ${MOBILE_VISIBLE} characters, which is all a phone shows.`,
      })
    }
  }

  // Unused characters are unused reach; eBay's own advice is to fill the 80.
  if (title.length < MAX_LENGTH - 15) {
    findings.push({
      code: 'short',
      title: 'Title leaves characters unused',
      detail: `${title.length}/${MAX_LENGTH} — there is room for another search term.`,
    })
  }

  return findings
}
