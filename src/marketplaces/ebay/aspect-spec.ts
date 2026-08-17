/**
 * What eBay says about one item specific in one category.
 *
 * Split out of `client.ts` so the parse can be tested without mocking a network
 * call, and because the shape is what the whole aspect engine is built on.
 *
 * The single most important rule in this file: **`required` comes from
 * `aspectConstraint.aspectRequired` and from nothing else.** eBay's Taxonomy API
 * reports aspects that are effectively mandatory with `aspectUsage:
 * "RECOMMENDED"` while `aspectRequired` is true. Reading `aspectUsage` — the
 * field whose name suggests it — produces a listing eBay rejects. `usage` is
 * carried here only so the contradiction can be reported, never so it can be
 * acted on.
 */

export type AspectMode = 'FREE_TEXT' | 'SELECTION_ONLY'
export type AspectCardinality = 'SINGLE' | 'MULTI'
export type AspectDataType = 'STRING' | 'NUMBER' | 'DATE'
export type AspectUsage = 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'

export interface AspectSpec {
  /** eBay's own spelling, which is what the payload must use verbatim. */
  name: string
  /** From `aspectConstraint.aspectRequired`. The only field that decides this. */
  required: boolean
  /** Verbatim `aspectUsage`. Diagnostics only — never read for a decision. */
  usage: AspectUsage | null
  mode: AspectMode
  cardinality: AspectCardinality
  dataType: AspectDataType
  /** Character ceiling for ONE value. Null means eBay stated none. */
  maxLength: number | null
  allowedValues: string[]
  /** True when `allowedValues` was capped, so a miss is not a verdict. */
  valuesTruncated: boolean
  /** `relevanceIndicator.searchCount` — how often buyers filter on this. */
  searchCount: number | null
  /** `expectedRequiredByDate`: recommended today, required on that date. */
  requiredByDate: string | null
  /**
   * `aspectEnabledForVariations` — whether this aspect may drive a
   * multi-variation listing in this category. Tri-state on purpose: null means
   * eBay said nothing, and only an explicit `false` is grounds to refuse a
   * variation publish before eBay does it with a worse message.
   */
  enabledForVariations: boolean | null
}

/**
 * How many allowed values to keep per aspect.
 *
 * `Marke` in some categories runs to tens of thousands of entries. Keeping them
 * all would bloat the cache for no gain — but silently dropping the tail would
 * make truthful values look unlisted and get them discarded. Hence the cap is
 * paired with `valuesTruncated`, which suppresses that verdict.
 */
export const MAX_ALLOWED_VALUES = 500

interface RawAspect {
  localizedAspectName?: unknown
  aspectConstraint?: {
    aspectRequired?: unknown
    aspectUsage?: unknown
    aspectDataType?: unknown
    itemToAspectCardinality?: unknown
    aspectMode?: unknown
    aspectMaxLength?: unknown
    expectedRequiredByDate?: unknown
    aspectEnabledForVariations?: unknown
  }
  aspectValues?: unknown
  relevanceIndicator?: { searchCount?: unknown }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function asUsage(value: unknown): AspectUsage | null {
  const s = asString(value)?.toUpperCase()
  return s === 'REQUIRED' || s === 'RECOMMENDED' || s === 'OPTIONAL' ? s : null
}

/**
 * Every default here is deliberately permissive.
 *
 * Where eBay says nothing, the engine must assume the least restrictive rule:
 * guessing `SELECTION_ONLY` on a silent field would make it discard values it
 * has no basis to reject, and a discarded value is one the buyer's filter can
 * never reach. Absent is not the same as restricted — the same rule the SEO
 * evidence already applies to unmeasured numbers.
 */
function parseOne(raw: RawAspect): AspectSpec | null {
  const name = asString(raw.localizedAspectName)
  if (!name) return null

  const c = raw.aspectConstraint ?? {}

  const values: string[] = []
  if (Array.isArray(raw.aspectValues)) {
    for (const entry of raw.aspectValues) {
      const value = asString((entry as { localizedValue?: unknown })?.localizedValue)
      if (value) values.push(value)
    }
  }

  const mode = asString(c.aspectMode)?.toUpperCase() === 'SELECTION_ONLY' ? 'SELECTION_ONLY' : 'FREE_TEXT'
  const cardinality =
    asString(c.itemToAspectCardinality)?.toUpperCase() === 'SINGLE' ? 'SINGLE' : 'MULTI'
  const dataTypeRaw = asString(c.aspectDataType)?.toUpperCase()
  const dataType: AspectDataType =
    dataTypeRaw === 'NUMBER' ? 'NUMBER' : dataTypeRaw === 'DATE' ? 'DATE' : 'STRING'

  return {
    name,
    required: c.aspectRequired === true,
    usage: asUsage(c.aspectUsage),
    mode,
    cardinality,
    dataType,
    maxLength: asPositiveInt(c.aspectMaxLength),
    allowedValues: values.slice(0, MAX_ALLOWED_VALUES),
    valuesTruncated: values.length > MAX_ALLOWED_VALUES,
    searchCount: asPositiveInt(raw.relevanceIndicator?.searchCount),
    requiredByDate: asString(c.expectedRequiredByDate),
    enabledForVariations:
      c.aspectEnabledForVariations === true ? true : c.aspectEnabledForVariations === false ? false : null,
  }
}

/**
 * Reads a `get_item_aspects_for_category` response.
 *
 * Never throws. A malformed or unexpected body yields an empty list, which the
 * caller treats as "no metadata" and degrades to warnings — the alternative,
 * an exception, would turn a taxonomy hiccup into a failed publish.
 */
export function parseAspectSpecs(response: unknown): AspectSpec[] {
  const aspects = (response as { aspects?: unknown } | null | undefined)?.aspects
  if (!Array.isArray(aspects)) return []

  const out: AspectSpec[] = []
  for (const raw of aspects) {
    if (!raw || typeof raw !== 'object') continue
    const spec = parseOne(raw as RawAspect)
    if (spec) out.push(spec)
  }
  return out
}
