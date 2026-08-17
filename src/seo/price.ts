import type { PriceBand } from './types.js'

/**
 * Places a price inside the market the research measured.
 *
 * Deliberately not advice. A price above the market can be exactly right —
 * better material, a bigger print, faster dispatch, a seller who does not want
 * the low end — and this module has no way to know. What it can do is make sure
 * the position is a decision rather than a surprise.
 */

export type PricePosition = 'below' | 'low' | 'typical' | 'high' | 'above'

export interface PriceVerdict {
  position: PricePosition
  /** Outside the middle half of the market, i.e. worth a second look. */
  notable: boolean
  /** Multiple of the median. 2 means twice what the middle of the market asks. */
  vsMedian: number
  /** One line, ready to show. */
  summary: string
}

/**
 * Below this the band is describing a handful of shops, not a market.
 *
 * Separate from the four-listing floor that produces the band at all: a band
 * can be computable and still be too thin to argue with a seller about.
 */
export const MIN_SAMPLE_FOR_ADVICE = 8

function eur(value: number): string {
  return `EUR ${value.toFixed(2)}`
}

/**
 * Whether the extremes are so far from the middle that they describe other
 * products rather than the edges of this one's market.
 *
 * A keyword search cannot tell a dart holder from a dart flight or a dartboard
 * cabinet, and both turn up under "dart". Rather than guess a cut-off and trim
 * them away, the band says out loud that its ends are not comparable.
 */
export function isMixed(band: PriceBand): boolean {
  if (band.median <= 0) return false
  return band.max > band.median * 10 || band.min < band.median / 10
}

export function assessPrice(priceEur: number, band: PriceBand): PriceVerdict {
  const vsMedian = band.median > 0 ? priceEur / band.median : 1

  const position: PricePosition =
    priceEur < band.min
      ? 'below'
      : priceEur < band.p25
        ? 'low'
        : priceEur <= band.p75
          ? 'typical'
          : priceEur <= band.max
            ? 'high'
            : 'above'

  // The middle half leads and the extremes trail, because that is their order
  // of usefulness. A live sample ran EUR 0.56 to EUR 744.94 with a median of
  // 13.99 — those ends are real listings, but they are a dart flight and a
  // dartboard cabinet, and quoting them first makes the market look like
  // anything goes.
  const market =
    `Market across ${band.count} listings: median ${eur(band.median)}, ` +
    `middle half ${eur(band.p25)}–${eur(band.p75)}` +
    (isMixed(band) ? `, extremes ${eur(band.min)}–${eur(band.max)} (the sample still spans different product types)` : `, full range ${eur(band.min)}–${eur(band.max)}`)

  const summary =
    position === 'typical'
      ? `${eur(priceEur)} sits in the middle half of the market. ${market}.`
      : position === 'below'
        ? `${eur(priceEur)} is below every listing found. ${market}.`
        : position === 'above'
          ? `${eur(priceEur)} is above every listing found — ${vsMedian.toFixed(1)}× the median. ${market}.`
          : position === 'high'
            ? `${eur(priceEur)} is in the upper quarter — ${vsMedian.toFixed(1)}× the median. ${market}.`
            : `${eur(priceEur)} is in the lower quarter — ${vsMedian.toFixed(1)}× the median. ${market}.`

  return {
    position,
    // A thin sample can still be reported; it just must not raise a flag, or
    // six listings would start dictating a price.
    notable: position !== 'typical' && band.count >= MIN_SAMPLE_FOR_ADVICE,
    vsMedian,
    summary,
  }
}

/** What to say about it, when there is anything worth saying. */
export function priceHint(verdict: PriceVerdict): string | undefined {
  switch (verdict.position) {
    case 'above':
    case 'high':
      return (
        'Higher is not wrong — more material, a larger print, faster dispatch and better photos all justify it. ' +
        'But on a marketplace the price is visible before anything else, so it has to be a choice.'
      )
    case 'below':
    case 'low':
      return (
        'Check the margin before treating this as an advantage. Undercutting a market of made-to-order prints ' +
        'usually costs more in machine time than it wins in orders.'
      )
    default:
      return undefined
  }
}
