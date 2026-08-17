import { describe, it, expect } from 'vitest'
import { parseAspectSpecs, MAX_ALLOWED_VALUES } from './aspect-spec.js'

/**
 * The trap this file exists for: eBay reports effectively-mandatory aspects
 * with `aspectUsage: RECOMMENDED` while `aspectRequired` is true. Reading the
 * field whose name suggests it produces a listing eBay rejects.
 */

function response(aspects: unknown[]): unknown {
  return { aspects }
}

function aspect(name: string, constraint: Record<string, unknown> = {}, values: string[] = []): unknown {
  return {
    localizedAspectName: name,
    aspectConstraint: constraint,
    aspectValues: values.map((localizedValue) => ({ localizedValue })),
  }
}

describe('the aspectUsage trap', () => {
  it('treats RECOMMENDED + aspectRequired:true as required', () => {
    const [spec] = parseAspectSpecs(
      response([aspect('Marke', { aspectUsage: 'RECOMMENDED', aspectRequired: true })]),
    )
    expect(spec?.required).toBe(true)
    expect(spec?.usage).toBe('RECOMMENDED')
  })

  it('treats REQUIRED + aspectRequired:false as NOT required', () => {
    // The mirror image, and the reason `usage` may never drive a decision.
    const [spec] = parseAspectSpecs(
      response([aspect('Farbe', { aspectUsage: 'REQUIRED', aspectRequired: false })]),
    )
    expect(spec?.required).toBe(false)
    expect(spec?.usage).toBe('REQUIRED')
  })

  it('does not accept a truthy non-true value as required', () => {
    const [spec] = parseAspectSpecs(response([aspect('Material', { aspectRequired: 'true' })]))
    expect(spec?.required).toBe(false)
  })
})

describe('permissive defaults', () => {
  it('assumes the least restrictive rule when eBay says nothing', () => {
    // Guessing SELECTION_ONLY here would discard truthful values the engine has
    // no basis to reject.
    const [spec] = parseAspectSpecs(response([{ localizedAspectName: 'Motiv' }]))
    expect(spec).toMatchObject({
      required: false,
      mode: 'FREE_TEXT',
      cardinality: 'MULTI',
      dataType: 'STRING',
      maxLength: null,
      allowedValues: [],
      valuesTruncated: false,
      usage: null,
      searchCount: null,
      requiredByDate: null,
    })
  })

  it('reads the restrictive settings when they are stated', () => {
    const [spec] = parseAspectSpecs(
      response([
        aspect(
          'Material',
          {
            aspectMode: 'SELECTION_ONLY',
            itemToAspectCardinality: 'SINGLE',
            aspectDataType: 'NUMBER',
            aspectMaxLength: 25,
            expectedRequiredByDate: '2027-01-01',
          },
          ['PLA'],
        ),
      ]),
    )
    expect(spec).toMatchObject({
      mode: 'SELECTION_ONLY',
      cardinality: 'SINGLE',
      dataType: 'NUMBER',
      maxLength: 25,
      requiredByDate: '2027-01-01',
    })
  })

  it('ignores a zero or negative maxLength rather than forbidding every value', () => {
    const [zero] = parseAspectSpecs(response([aspect('A', { aspectMaxLength: 0 })]))
    const [negative] = parseAspectSpecs(response([aspect('B', { aspectMaxLength: -5 })]))
    expect(zero?.maxLength).toBeNull()
    expect(negative?.maxLength).toBeNull()
  })
})

describe('robustness', () => {
  it('never throws, whatever it is handed', () => {
    for (const input of [undefined, null, {}, '<html>', 42, [], { aspects: 'nope' }, { aspects: [null, 7] }]) {
      expect(() => parseAspectSpecs(input)).not.toThrow()
      expect(parseAspectSpecs(input)).toEqual([])
    }
  })

  it('skips an aspect with no usable name instead of failing the batch', () => {
    const specs = parseAspectSpecs(
      response([{ localizedAspectName: '   ' }, aspect('Farbe'), { localizedAspectName: 42 }]),
    )
    expect(specs.map((s) => s.name)).toEqual(['Farbe'])
  })

  it('drops empty values but keeps the aspect', () => {
    const [spec] = parseAspectSpecs(
      response([{ localizedAspectName: 'Farbe', aspectValues: [{ localizedValue: '' }, { localizedValue: 'Rot' }] }]),
    )
    expect(spec?.allowedValues).toEqual(['Rot'])
  })
})

describe('value list capping', () => {
  it('caps the list and says so, so a miss is not mistaken for a verdict', () => {
    // Marke runs to tens of thousands. A silent cap would make truthful values
    // look unlisted and get them discarded.
    const many = Array.from({ length: MAX_ALLOWED_VALUES + 10 }, (_, i) => `Wert ${i}`)
    const [spec] = parseAspectSpecs(response([aspect('Marke', {}, many)]))
    expect(spec?.allowedValues).toHaveLength(MAX_ALLOWED_VALUES)
    expect(spec?.valuesTruncated).toBe(true)
  })

  it('does not flag truncation when the list fits', () => {
    const [spec] = parseAspectSpecs(response([aspect('Farbe', {}, ['Rot', 'Blau'])]))
    expect(spec?.valuesTruncated).toBe(false)
  })
})

describe('relevance', () => {
  it('keeps the search count and leaves it null when absent', () => {
    const withCount = parseAspectSpecs(
      response([{ localizedAspectName: 'Farbe', relevanceIndicator: { searchCount: 8400 } }]),
    )
    expect(withCount[0]?.searchCount).toBe(8400)
    // Null, not zero: unmeasured is not "nobody searches for it".
    expect(parseAspectSpecs(response([aspect('Farbe')]))[0]?.searchCount).toBeNull()
  })

  it('reads aspectEnabledForVariations as a tri-state', () => {
    // Only an explicit false refuses a variation publish; silence means eBay
    // gets to decide. Collapsing "not stated" into false would block variants
    // in every category whose metadata simply omits the field.
    expect(
      parseAspectSpecs(response([aspect('Farbe', { aspectEnabledForVariations: true })]))[0]?.enabledForVariations,
    ).toBe(true)
    expect(
      parseAspectSpecs(response([aspect('Farbe', { aspectEnabledForVariations: false })]))[0]?.enabledForVariations,
    ).toBe(false)
    expect(parseAspectSpecs(response([aspect('Farbe')]))[0]?.enabledForVariations).toBeNull()
  })
})
