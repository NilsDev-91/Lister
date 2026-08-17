import { EbayVariantsSchema, type EbayVariant } from '../types.js'

/**
 * eBay colour variants as editable text, one per line:
 *
 *     SKU; Farbe; Preis; Menge
 *
 * The same textarea approach as the aspect editor, and for the same reason: a
 * generated form row per variant cannot add a variant, and adding is the whole
 * point. Semicolons separate the fields because the prices are German — a
 * comma-separated format would split "19,90" in the middle of the number.
 *
 * Both directions live here so they cannot drift apart, and the parse reports
 * errors per line rather than rejecting the lot: a typo in row three should
 * not cost rows one and two.
 */

export function formatVariants(variants: EbayVariant[]): string {
  return variants
    .map((v) => `${v.sku}; ${v.colour}; ${v.priceEur.toFixed(2).replace('.', ',')}; ${v.quantity}`)
    .join('\n')
}

export interface ParsedVariants {
  variants: EbayVariant[]
  /** Human-readable, one entry per unusable line or list-level rule breach. */
  errors: string[]
}

/** Accepts both decimal separators; the seller thinks in commas, eBay in dots. */
function parseEuro(raw: string): number | null {
  const normalised = raw.trim().replace(',', '.')
  const value = Number(normalised)
  return normalised && Number.isFinite(value) ? value : null
}

export function parseVariants(input: string): ParsedVariants {
  const variants: EbayVariant[] = []
  const errors: string[] = []

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line) continue

    const parts = line.split(';').map((p) => p.trim())
    if (parts.length !== 4) {
      errors.push(`Zeile ${index + 1}: erwartet "SKU; Farbe; Preis; Menge", gefunden ${parts.length} Feld(er)`)
      continue
    }

    const [sku, colour, priceRaw, quantityRaw] = parts as [string, string, string, string]
    const priceEur = parseEuro(priceRaw)
    const quantity = parseEuro(quantityRaw)

    if (priceEur === null) {
      errors.push(`Zeile ${index + 1}: "${priceRaw}" ist kein Preis`)
      continue
    }
    if (quantity === null || !Number.isInteger(quantity)) {
      errors.push(`Zeile ${index + 1}: "${quantityRaw}" ist keine Stückzahl`)
      continue
    }

    variants.push({ sku, colour, priceEur, quantity, imageUrls: [] })
  }

  if (!variants.length) return { variants, errors }

  // The schema is the single authority on field rules and the two uniqueness
  // constraints; the line parser above only decides what a line *is*.
  const validated = EbayVariantsSchema.safeParse(variants)
  if (!validated.success) {
    for (const issue of validated.error.issues) errors.push(issue.message)
    return { variants: [], errors }
  }

  return { variants: validated.data, errors }
}
