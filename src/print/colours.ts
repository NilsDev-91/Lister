/**
 * Filament hex → German colour name, for the eBay "Farbe" aspect.
 *
 * eBay colour aspects are usually SELECTION_ONLY: a hex code is invisible to
 * the filter, so the value has to be a colour *name* in the category's
 * vocabulary. This maps to the base names German categories actually use;
 * `planAspects` then reconciles spelling against the category's own list.
 * Nearest-neighbour in RGB is crude but deterministic — and the value lands
 * in an editable field, never silently in a listing.
 */

const BASE_COLOURS: [name: string, r: number, g: number, b: number][] = [
  ['Schwarz', 0, 0, 0],
  ['Weiß', 255, 255, 255],
  ['Grau', 128, 128, 128],
  ['Silber', 192, 192, 192],
  ['Rot', 200, 30, 30],
  ['Orange', 255, 140, 0],
  ['Gelb', 250, 220, 40],
  ['Grün', 40, 150, 60],
  ['Türkis', 60, 200, 200],
  ['Blau', 40, 80, 200],
  ['Lila', 130, 60, 180],
  ['Rosa', 240, 150, 190],
  ['Braun', 120, 75, 40],
  ['Beige', 225, 205, 170],
  ['Gold', 212, 175, 55],
]

/** "#898989" → "Grau". Null for anything that is not a parseable hex colour. */
export function germanColourName(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const value = parseInt(match[1]!, 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff

  let best: string | null = null
  let bestDistance = Infinity
  for (const [name, cr, cg, cb] of BASE_COLOURS) {
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}
