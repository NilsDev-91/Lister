/**
 * eBay item specifics as editable text, one per line: `Name: Wert, Wert`.
 *
 * A textarea rather than a generated field per aspect, because the set is not
 * fixed: eBay defines different specifics per category, the seller may add
 * custom ones, and a form that can only edit what already exists cannot fix a
 * missing required aspect — which was the whole reason the old read-only chips
 * were a dead end.
 *
 * Both directions live here so they cannot drift apart.
 */

/**
 * A value carrying the separator OR a quote is quoted, so it survives the
 * round trip.
 *
 * eBay values legitimately contain commas — "Höhe 1,5 cm", "Rot, matt" — and
 * without quoting, formatting then re-parsing split one value into two. The
 * quote character itself is escaped by doubling, CSV-style — and any bare
 * quote forces quoting too: an unquoted inch mark (`5" Zoll`) read back as a
 * quoting toggle, silently dropping the character and swallowing the next
 * comma split.
 */
function formatValue(value: string): string {
  return value.includes(',') || value.includes('"') ? `"${value.replace(/"/g, '""')}"` : value
}

export function formatAspects(aspects: Record<string, string[]>): string {
  return Object.entries(aspects)
    .map(([name, values]) => `${name}: ${values.map(formatValue).join(', ')}`)
    .join('\n')
}

/**
 * The inverse. Tolerant on purpose — this is hand-edited text.
 *
 * A line with no colon is skipped rather than guessed at: turning "Farbe
 * Schwarz" into an aspect named "Farbe Schwarz" with no value would be worse
 * than ignoring it, because eBay would accept the nonsense.
 */
export function parseAspects(input: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // The formatter always emits ": " between name and values, so ": " is the
    // separator of record — an aspect NAME may itself contain a bare colon
    // (scale notation like "Massstab 1:87"), and splitting at the first ":"
    // broke such names apart. Hand-typed lines without the space ("Farbe:Rot")
    // still parse via the bare-colon fallback.
    const colonSpace = trimmed.indexOf(': ')
    const colon = colonSpace !== -1 ? colonSpace : trimmed.indexOf(':')
    if (colon === -1) continue

    const name = trimmed.slice(0, colon).trim()
    if (!name) continue

    const values = splitValues(trimmed.slice(colon + 1))
    if (!values.length) continue

    // A repeated name merges rather than overwrites: losing the first line
    // silently is the kind of edit nobody notices until a publish is wrong.
    out[name] = [...(out[name] ?? []), ...values]
  }

  return out
}

/** Splits on commas, honouring the quoting `formatValue` applies. */
function splitValues(input: string): string[] {
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
    } else if (ch === ',' && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)

  return out.map((v) => v.trim()).filter(Boolean)
}
