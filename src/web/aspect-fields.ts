/**
 * eBay item specifics as one labelled box per aspect.
 *
 * The editor used to be a single textarea (`aspect-text.ts`), chosen because a
 * generated field per aspect cannot ADD an aspect — and adding is how a missing
 * required specific gets fixed. That constraint still holds, so this module
 * keeps blank rows and lets the seller name them; what it drops is the part
 * that made the textarea risky: a stray keystroke could empty a value, delete a
 * whole line, or break the `Name: Wert` syntax, and nothing said so until a
 * publish came back short.
 *
 * The rules that follow from that:
 *
 *  - **A value that exists is `locked`** — its input carries `required`, so the
 *    browser refuses to submit it empty. Removing it takes the explicit
 *    "entfernen" tick, which is a decision rather than a slip.
 *  - **An aspect eBay requires is shown even when it has no value yet**, so a
 *    missing one cannot be forgotten. It is NOT `required` in the HTML sense:
 *    blocking every save until it is filled would stop the seller fixing a
 *    typo in the title. The publish gate already refuses a listing without it.
 *  - **A name typed without a value is an error, never a silent drop.** Losing
 *    a half-entered row is exactly the accident this editor exists to prevent.
 *
 * Both directions live here so they cannot drift apart, same as the textarea
 * module; the comma quoting itself is imported from there so the two editors
 * cannot disagree about what a comma means.
 */

/**
 * Values inside one box are separated by a SEMICOLON, not a comma.
 *
 * German values carry decimal commas constantly — "0,16 mm", "Höhe 1,5 cm" —
 * and with a comma separator every one of them silently became two values the
 * moment it was typed. (Stored values were quoted on render and survived, so
 * the corruption only hit freshly typed text: the worst kind, because the
 * seller watched it happen and saw nothing.) The variant editor picked
 * semicolons for exactly this reason and this box now matches it.
 *
 * A value containing a semicolon or a quote is still quoted; the quote itself
 * is escaped by doubling, CSV-style. A bare quote must be quoted too, or it
 * acts as a quoting toggle when read back and swallows the next separator
 * (an inch mark, `5" Zoll`).
 */
export const VALUE_SEPARATOR = ';'

function formatValue(value: string): string {
  return value.includes(VALUE_SEPARATOR) || value.includes('"')
    ? `"${value.replace(/"/g, '""')}"`
    : value
}

/** One aspect's values as the single string its input box holds. */
export function formatValues(values: string[]): string {
  return values.map(formatValue).join('; ')
}

/** Splits a box back into values, honouring the quoting `formatValue` applies. */
export function splitValues(input: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '"') {
      // Doubled quote inside a quoted value is a literal quote.
      if (inQuotes && input[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === VALUE_SEPARATOR && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)

  return out.map((v) => v.trim()).filter(Boolean)
}

export interface AspectRow {
  /** eBay's spelling. Empty on a blank row the seller may name themselves. */
  name: string
  /** The values as one editable string, quoted where a value carries a comma. */
  value: string
  /** eBay's taxonomy marks this aspect required for the resolved category. */
  requiredByEbay: boolean
  /** Has a value today: the input gets `required` so it cannot be lost. */
  locked: boolean
}

/** How many empty rows to offer for adding aspects without touching JS. */
export const BLANK_ROWS = 2

export function aspectRows(
  aspects: Record<string, string[]>,
  requiredByEbay: string[] = [],
  blankRows = BLANK_ROWS,
): AspectRow[] {
  // Case-insensitive, because eBay's spelling of a required aspect and the
  // seller's stored one differ often enough ("Marke" vs "marke") that a match
  // by identity would show a duplicate empty box next to a filled one.
  const required = new Map(requiredByEbay.map((name) => [name.toLowerCase(), name]))

  const rows: AspectRow[] = Object.entries(aspects).map(([name, values]) => ({
    name,
    value: formatValues(values),
    requiredByEbay: required.has(name.toLowerCase()),
    locked: values.length > 0,
  }))

  const present = new Set(Object.keys(aspects).map((n) => n.toLowerCase()))
  for (const [lower, name] of required) {
    if (present.has(lower)) continue
    rows.push({ name, value: '', requiredByEbay: true, locked: false })
  }

  for (let i = 0; i < blankRows; i++) {
    rows.push({ name: '', value: '', requiredByEbay: false, locked: false })
  }

  return rows
}

export interface ParsedAspectFields {
  aspects: Record<string, string[]>
  /** Human-readable, one per unusable row. */
  errors: string[]
  /**
   * Whether the form carried aspect fields at all.
   *
   * False means "this submission says nothing about aspects" — a stale page
   * still posting the old textarea, or a hand-built request. The caller keeps
   * what is stored rather than reading the silence as "delete everything",
   * which would be the very accident this editor prevents.
   */
  present: boolean
}

/** Reads the indexed `aspectName<i>` / `aspectValue<i>` / `aspectDrop<i>` fields back. */
export function parseAspectFields(fields: Record<string, string>): ParsedAspectFields {
  const indices = new Set<number>()
  for (const key of Object.keys(fields)) {
    const match = /^aspect(?:Name|Value)(\d+)$/.exec(key)
    if (match) indices.add(Number(match[1]))
  }

  if (!indices.size) return { aspects: {}, errors: [], present: false }

  const aspects: Record<string, string[]> = {}
  const errors: string[] = []

  for (const index of [...indices].sort((a, b) => a - b)) {
    // Presence, not value: an unticked checkbox is simply absent from the post.
    if (fields[`aspectDrop${index}`] === '1') continue

    const name = (fields[`aspectName${index}`] ?? '').trim()
    const raw = (fields[`aspectValue${index}`] ?? '').trim()
    const values = splitValues(raw)

    if (!name && !values.length) continue // untouched blank row
    if (!name) {
      errors.push(`Merkmal ohne Namen: "${raw}"`)
      continue
    }
    if (!values.length) {
      // `aspectHint<i>` marks a box THIS editor labelled and left empty — the
      // reminder for an aspect eBay requires. Leaving it empty is a state, not
      // a mistake, and erroring on it would block every save until it is
      // filled. A name the SELLER typed carries no marker, and an empty value
      // there is a half-entered aspect worth stopping for.
      if (fields[`aspectHint${index}`] === '1') continue
      errors.push(`"${name}" hat keinen Wert — Wert eintragen oder „entfernen" ankreuzen`)
      continue
    }

    // A repeated name merges rather than overwrites, the same rule the textarea
    // parser follows: dropping the first silently is the kind of edit nobody
    // notices until a publish is wrong.
    aspects[name] = [...(aspects[name] ?? []), ...values]
  }

  return { aspects, errors, present: true }
}
