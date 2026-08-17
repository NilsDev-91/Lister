import type { AspectCardinality, AspectMode, AspectSpec } from './aspect-spec.js'

/**
 * Turns whatever aspects a listing carries into a payload eBay will accept and
 * a buyer's filter will actually reach.
 *
 * Pure: no network, no config, no clock beyond what is passed in. That is what
 * makes it testable against saved taxonomy responses, and this is a module
 * where being wrong is expensive — a missing item specific does not rank the
 * listing lower, it removes it from the filtered result set entirely.
 *
 * Two rules run through everything here:
 *
 *   1. **Never assert something that was not stated.** The engine fills aspects
 *      only from facts the seller gave, through an explicit table. Everything
 *      else becomes a suggestion for a human.
 *   2. **Never silently repair.** Values are dropped, not truncated, and every
 *      drop and every fill produces a finding. A shortened value is both untrue
 *      and unfilterable, which is worse than an absent one.
 */

/** Structurally satisfied by both `BrowseFacet` and the stored `AspectFacet`. */
export interface FacetCount {
  name: string
  value: string
  count: number
}

/** What the tool may state about the item without asking anyone. */
export interface AspectFacts {
  material: string
  colour: string | null
  dimensionsMm: { length: number; width: number; height: number } | null
  weightGrams: number | null
  /** Everything this tool lists is printed by the seller. */
  handmade: boolean
  countryOfManufacture: string
  brandFallback: string
}

/**
 * Builds the fact set from a listing's product input.
 *
 * The parameter is structural rather than the imported `ProductInput` so this
 * module keeps its only dependency on `aspect-spec.js` — the property is what
 * makes it testable with a two-line literal.
 *
 * `handmade` and the country are constants here because they are constants for
 * this tool: everything it lists is printed by the seller, in Germany.
 */
export function factsFromProduct(product: {
  material: string
  colour: string | null
  dimensionsMm: { length: number; width: number; height: number } | null
  weightGrams: number | null
}): AspectFacts {
  return {
    material: product.material,
    colour: product.colour,
    dimensionsMm: product.dimensionsMm,
    weightGrams: product.weightGrams,
    handmade: true,
    countryOfManufacture: 'Deutschland',
    brandFallback: 'Markenlos',
  }
}

export type AspectFindingCode =
  | 'missing-required'
  | 'value-not-allowed'
  | 'value-too-long'
  | 'cardinality-trimmed'
  | 'unknown-aspect'
  | 'below-target'
  | 'required-soon'
  | 'filled-from-facts'
  | 'usage-mismatch'

export interface AspectFinding {
  severity: 'blocker' | 'warning' | 'info'
  code: AspectFindingCode
  aspect: string
  detail: string
  value?: string
}

/** An aspect worth filling that nothing could fill truthfully. */
export interface AspectSuggestion {
  name: string
  required: boolean
  mode: AspectMode
  /** Best-supported values first. Empty for a free-text aspect with no list. */
  options: { value: string; facetCount: number | null }[]
  searchCount: number | null
}

export interface AspectPlanArgs {
  specs: AspectSpec[]
  current: Record<string, string[]>
  facets?: FacetCount[] | undefined
  facts: AspectFacts
  /** eBay's own guidance is "fill at least 10". */
  target?: number
  /** Only supplied so `required-soon` can be judged; omitted skips that check. */
  now?: Date | undefined
}

export interface AspectPlan {
  /** Exactly what goes into `product.aspects`, in eBay's own spelling. */
  aspects: Record<string, string[]>
  findings: AspectFinding[]
  missingRequired: string[]
  /** Aspects carrying at least one value — the number the target counts. */
  filled: number
  suggestions: AspectSuggestion[]
}

/** eBay UK guidance: "fill in at least 10 recommended item specifics". */
export const ASPECT_TARGET = 10
/** Where eBay's measured >2x performance step sits. */
export const ASPECT_FLOOR = 7
/** How soon a `requiredByDate` is worth mentioning. */
const REQUIRED_SOON_DAYS = 30
/** Suggestion lists are for prompts and forms, not for dumping a taxonomy. */
const MAX_SUGGESTION_OPTIONS = 25

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Case- and diacritic-insensitive, so "höhe", "Hohe" and "HÖHE" all compare equal. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
}

/**
 * Rewrites an aspect name to eBay's exact spelling, or returns null.
 *
 * eBay matches aspect names literally: `material` is not `Material`. A name
 * with no counterpart is deliberately *not* resolved here — the caller keeps it
 * rather than dropping it, because eBay accepts custom item specifics and
 * discarding seller-entered data to satisfy a taxonomy is the wrong trade.
 */
export function canonicaliseName(name: string, specs: AspectSpec[]): string | null {
  const folded = fold(name)
  return specs.find((s) => fold(s.name) === folded)?.name ?? null
}

/**
 * Snaps a value to eBay's spelling, or reports that it is not on the list.
 *
 * Snapping matters as much as matching: a value that differs only in case still
 * lands outside the buyer's filter bucket, so `pla` has to become `PLA` to be
 * worth anything. Returns the value unchanged when there is no list to check.
 */
export function matchAllowedValue(value: string, spec: AspectSpec): string | null {
  if (!spec.allowedValues.length) return value
  const folded = fold(value)
  return spec.allowedValues.find((v) => fold(v) === folded) ?? null
}

// ---------------------------------------------------------------------------
// Filling from the seller's own facts
// ---------------------------------------------------------------------------

interface FactRule {
  /** Folded fragments; the first spec whose folded name contains one wins. */
  match: string[]
  value: (facts: AspectFacts, spec: AspectSpec) => string | null
}

/**
 * Dimensions and weight carry no unit field on an eBay aspect, so the unit has
 * to live in the value for a text aspect and be implied for a numeric one.
 *
 * NOTE: not yet verified against a live German category. If eBay turns out to
 * expect millimetres, or a separate "Maßeinheit" aspect, this is where it
 * changes — the values are otherwise honest either way.
 */
function measurement(valueMm: number, spec: AspectSpec, unitSuffix: string): string {
  const cm = valueMm / 10
  const rounded = Number.isInteger(cm) ? String(cm) : cm.toFixed(1)
  return spec.dataType === 'NUMBER' ? rounded : `${rounded} ${unitSuffix}`
}

/**
 * The only aspects the tool fills unasked — because these ARE the seller's
 * stated facts, not inferences about the object.
 *
 * Anything outside this table can at most become a suggestion. That line is the
 * difference between a tool that completes a form and one that makes claims on
 * someone else's behalf.
 */
const FROM_FACTS: FactRule[] = [
  { match: ['marke', 'brand'], value: (f) => f.brandFallback },
  { match: ['material'], value: (f) => f.material },
  { match: ['farbe', 'colour', 'color'], value: (f) => f.colour },
  {
    // eBay spells this differently per category — "Herstellungsland und
    // -region" in some, plain "Ursprungsland" in others. Verified live: the
    // dart-accessories category uses "Ursprungsland", which a table built only
    // from the German dimension names would have missed entirely.
    match: ['herstellungsland', 'ursprungsland', 'country of manufacture', 'country/region of manufacture'],
    value: (f) => f.countryOfManufacture,
  },
  {
    // The manufacturer part number. For something printed to order there is no
    // catalogue number, and eBay's accepted answer for that is this exact
    // string — the same convention as EAN.
    match: ['herstellernummer', 'mpn', 'manufacturer part number'],
    value: () => 'Nicht zutreffend',
  },
  { match: ['handgefertigt', 'handmade'], value: (f) => (f.handmade ? 'Ja' : null) },
  {
    match: ['hohe', 'height'],
    value: (f, s) => (f.dimensionsMm ? measurement(f.dimensionsMm.height, s, 'cm') : null),
  },
  {
    match: ['breite', 'width'],
    value: (f, s) => (f.dimensionsMm ? measurement(f.dimensionsMm.width, s, 'cm') : null),
  },
  {
    match: ['tiefe', 'lange', 'depth', 'length'],
    value: (f, s) => (f.dimensionsMm ? measurement(f.dimensionsMm.length, s, 'cm') : null),
  },
  {
    match: ['gewicht', 'weight'],
    value: (f, s) =>
      f.weightGrams === null ? null : s.dataType === 'NUMBER' ? String(f.weightGrams) : `${f.weightGrams} g`,
  },
  { match: ['ean', 'gtin'], value: () => 'Nicht zutreffend' },
]

function factFor(spec: AspectSpec, facts: AspectFacts): string | null {
  const folded = fold(spec.name)
  // Whole-word containment, not substring: "Kabellänge" must not receive the
  // item's own length just because "lange" occurs inside it — that would state
  // a fact about the wrong measurement. "Herstellungsland und -region" still
  // matches, because there "herstellungsland" is a word of its own.
  const rule = FROM_FACTS.find((r) =>
    r.match.some((fragment) => new RegExp(`(^|[^\\p{L}\\p{Nd}])${fragment}([^\\p{L}\\p{Nd}]|$)`, 'u').test(folded)),
  )
  return rule ? rule.value(facts, spec) : null
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function facetCount(facets: FacetCount[] | undefined, aspect: string, value: string): number | null {
  if (!facets?.length) return null
  const folded = { aspect: fold(aspect), value: fold(value) }
  const hit = facets.find((f) => fold(f.name) === folded.aspect && fold(f.value) === folded.value)
  return hit ? hit.count : null
}

const SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 } as const

export function planAspects(args: AspectPlanArgs): AspectPlan {
  const { specs, current, facets, facts } = args
  const target = args.target ?? ASPECT_TARGET
  const findings: AspectFinding[] = []

  // Group the incoming values under eBay's spelling. A key that matches no spec
  // is kept under its own name — see `canonicaliseName`.
  const byName = new Map<string, string[]>()
  const unknownNames: string[] = []
  for (const [rawName, rawValues] of Object.entries(current)) {
    const canonical = canonicaliseName(rawName, specs)
    if (!canonical) {
      unknownNames.push(rawName)
      findings.push({
        severity: 'info',
        code: 'unknown-aspect',
        aspect: rawName,
        detail: 'Not part of this category. eBay accepts custom item specifics, so it is kept as written.',
      })
    }
    const key = canonical ?? rawName
    const existing = byName.get(key) ?? []
    byName.set(
      key,
      existing.concat((rawValues ?? []).map((v) => String(v).trim()).filter(Boolean)),
    )
  }

  const aspects: Record<string, string[]> = {}
  const missingRequired: string[] = []
  const suggestions: AspectSuggestion[] = []

  for (const spec of specs) {
    if (spec.usage === 'REQUIRED' && !spec.required) {
      findings.push({
        severity: 'info',
        code: 'usage-mismatch',
        aspect: spec.name,
        detail: 'eBay lists this as REQUIRED usage but not as a required aspect. Only aspectRequired decides.',
      })
    }

    if (spec.requiredByDate && args.now) {
      const due = Date.parse(spec.requiredByDate)
      const days = (due - args.now.getTime()) / 86_400_000
      // A date already behind us matters *more*, not less: cached metadata can
      // lag, and "became required last week" was previously the one case that
      // produced no finding at all.
      if (Number.isFinite(days) && days <= REQUIRED_SOON_DAYS) {
        findings.push({
          severity: 'warning',
          code: 'required-soon',
          aspect: spec.name,
          detail:
            days < 0
              ? `eBay made this required on ${spec.requiredByDate} — the cached metadata may predate the change.`
              : `eBay makes this required on ${spec.requiredByDate}.`,
        })
      }
    }

    let values = dedupe(byName.get(spec.name) ?? [])
    byName.delete(spec.name)

    values = normaliseValues(values, spec, findings)

    // Only fill what the seller actually stated, and only where it survives the
    // category's own rules — a proposed value eBay's *closed* list cannot hold
    // is silently skipped, because the tool proposed it, not the seller.
    if (!values.length) {
      const proposed = factFor(spec, facts)
      if (proposed !== null) {
        // Same acceptance rule the seller's own values get in `normaliseValues`:
        // an off-list value only disqualifies where the list is closed and
        // complete. Requiring list membership for FREE_TEXT aspects — as this
        // once did — dropped true facts like a colour eBay's suggestions did
        // not happen to include.
        const fits = spec.maxLength === null || proposed.length <= spec.maxLength
        const matched = fits
          ? (matchAllowedValue(proposed, spec) ??
            (spec.mode === 'FREE_TEXT' || spec.valuesTruncated ? proposed : null))
          : null
        if (matched !== null) {
          values = [matched]
          findings.push({
            severity: 'info',
            code: 'filled-from-facts',
            aspect: spec.name,
            value: matched,
            detail: 'Filled from the facts you entered for this item.',
          })
        }
      }
    }

    values = applyCardinality(values, spec, facets, findings)

    if (values.length) {
      aspects[spec.name] = values
    } else {
      if (spec.required) {
        missingRequired.push(spec.name)
        findings.push({
          severity: 'blocker',
          code: 'missing-required',
          aspect: spec.name,
          detail: 'eBay requires this item specific for this category and will reject the listing without it.',
        })
      }
      suggestions.push({
        name: spec.name,
        required: spec.required,
        mode: spec.mode,
        searchCount: spec.searchCount,
        options: spec.allowedValues
          .map((value) => ({ value, facetCount: facetCount(facets, spec.name, value) }))
          .sort((a, b) => (b.facetCount ?? -1) - (a.facetCount ?? -1) || a.value.localeCompare(b.value))
          .slice(0, MAX_SUGGESTION_OPTIONS),
      })
    }
  }

  // Whatever is left had no spec at all; keep it verbatim, in input order.
  for (const name of unknownNames) {
    const values = dedupe(byName.get(name) ?? [])
    if (values.length) aspects[name] = values
  }

  const filled = Object.values(aspects).filter((v) => v.length > 0).length

  if (filled < ASPECT_FLOOR) {
    findings.push({
      severity: 'warning',
      code: 'below-target',
      aspect: '',
      detail:
        `Only ${filled} item specifics. eBay measures listings with at least ${ASPECT_FLOOR} performing more than ` +
        `twice as well as those with one; aim for ${target}.`,
    })
  } else if (filled < target) {
    findings.push({
      severity: 'warning',
      code: 'below-target',
      aspect: '',
      detail: `${filled} item specifics. eBay's own guidance is to fill at least ${target}.`,
    })
  }

  suggestions.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      (b.searchCount ?? -1) - (a.searchCount ?? -1) ||
      (b.options[0]?.facetCount ?? -1) - (a.options[0]?.facetCount ?? -1) ||
      a.name.localeCompare(b.name),
  )

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.aspect.localeCompare(b.aspect) ||
      a.code.localeCompare(b.code),
  )

  return { aspects, findings, missingRequired, filled, suggestions }
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = fold(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * Drops what eBay cannot accept, and snaps what it can.
 *
 * Over-length values are dropped rather than truncated on purpose: cutting
 * "Handgefertigt aus schwarzem PLA" to fit a 20-character ceiling produces a
 * string that is neither true nor matched by any filter.
 */
function normaliseValues(values: string[], spec: AspectSpec, findings: AspectFinding[]): string[] {
  const out: string[] = []

  for (const value of values) {
    if (spec.maxLength !== null && value.length > spec.maxLength) {
      findings.push({
        severity: 'warning',
        code: 'value-too-long',
        aspect: spec.name,
        value,
        detail: `Dropped: ${value.length} characters, eBay allows ${spec.maxLength} here. Shortening it would make it untrue.`,
      })
      continue
    }

    const matched = matchAllowedValue(value, spec)
    if (matched !== null) {
      out.push(matched)
      continue
    }

    // A closed list we know to be complete is the only case where an unmatched
    // value is genuinely unusable — it can never appear in the filter it exists
    // for. With a truncated list, a miss says nothing.
    if (spec.mode === 'SELECTION_ONLY' && !spec.valuesTruncated) {
      findings.push({
        severity: 'warning',
        code: 'value-not-allowed',
        aspect: spec.name,
        value,
        detail: 'Dropped: eBay only accepts listed values for this item specific, and buyers can only filter on those.',
      })
      continue
    }

    out.push(value)
  }

  return out
}

function applyCardinality(
  values: string[],
  spec: AspectSpec,
  facets: FacetCount[] | undefined,
  findings: AspectFinding[],
): string[] {
  if (spec.cardinality !== ('SINGLE' satisfies AspectCardinality) || values.length <= 1) return values

  // Every value here was asserted true, so keeping the one buyers filter on most
  // costs no honesty. With no facet data the first wins, which keeps it
  // deterministic rather than arbitrary.
  const best = values.reduce((winner, candidate) =>
    (facetCount(facets, spec.name, candidate) ?? -1) > (facetCount(facets, spec.name, winner) ?? -1)
      ? candidate
      : winner,
  )

  findings.push({
    severity: 'warning',
    code: 'cardinality-trimmed',
    aspect: spec.name,
    value: best,
    detail: `eBay accepts one value here; kept "${best}" and dropped ${values.length - 1} other(s).`,
  })

  return [best]
}
