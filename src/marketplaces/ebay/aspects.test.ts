import { describe, it, expect } from 'vitest'
import { planAspects, canonicaliseName, matchAllowedValue, ASPECT_TARGET, ASPECT_FLOOR } from './aspects.js'
import type { AspectFacts, FacetCount } from './aspects.js'
import type { AspectSpec } from './aspect-spec.js'

function spec(name: string, over: Partial<AspectSpec> = {}): AspectSpec {
  return {
    name,
    required: false,
    usage: null,
    mode: 'FREE_TEXT',
    cardinality: 'MULTI',
    dataType: 'STRING',
    maxLength: null,
    allowedValues: [],
    valuesTruncated: false,
    searchCount: null,
    requiredByDate: null,
    enabledForVariations: null,
    ...over,
  }
}

const FACTS: AspectFacts = {
  material: 'PLA',
  colour: 'Schwarz',
  dimensionsMm: { length: 200, width: 60, height: 40 },
  weightGrams: 90,
  handmade: true,
  countryOfManufacture: 'Deutschland',
  brandFallback: 'Markenlos',
}

function plan(specs: AspectSpec[], current: Record<string, string[]> = {}, over: Partial<Parameters<typeof planAspects>[0]> = {}) {
  return planAspects({ specs, current, facts: FACTS, ...over })
}

function codes(result: ReturnType<typeof planAspects>): string[] {
  return result.findings.map((f) => f.code)
}

describe('canonicaliseName', () => {
  it('rewrites to eBay spelling regardless of case or diacritics', () => {
    const specs = [spec('Höhe'), spec('Material')]
    expect(canonicaliseName('hohe', specs)).toBe('Höhe')
    expect(canonicaliseName('HÖHE', specs)).toBe('Höhe')
    expect(canonicaliseName('material', specs)).toBe('Material')
  })

  it('returns null for a name the category does not know', () => {
    expect(canonicaliseName('Lieblingsfarbe', [spec('Farbe')])).toBeNull()
  })
})

describe('matchAllowedValue', () => {
  it('snaps casing so the value lands in the buyer filter bucket', () => {
    expect(matchAllowedValue('pla', spec('Material', { allowedValues: ['PLA', 'PETG'] }))).toBe('PLA')
  })

  it('reports a miss against a real list', () => {
    expect(matchAllowedValue('Holz', spec('Material', { allowedValues: ['PLA'] }))).toBeNull()
  })

  it('accepts anything when there is no list to check against', () => {
    expect(matchAllowedValue('Irgendwas', spec('Motiv'))).toBe('Irgendwas')
  })
})

describe('value rules', () => {
  it('drops an unlisted value under SELECTION_ONLY but keeps it under FREE_TEXT', () => {
    // Deliberately an aspect the facts table does not cover, so the drop is
    // visible on its own — see the repair case below for the other half.
    const closed = plan([spec('Motiv', { mode: 'SELECTION_ONLY', allowedValues: ['Drache'] })], { Motiv: ['Holz'] })
    expect(closed.aspects['Motiv']).toBeUndefined()
    expect(codes(closed)).toContain('value-not-allowed')

    const open = plan([spec('Motiv', { mode: 'FREE_TEXT', allowedValues: ['Drache'] })], { Motiv: ['Holz'] })
    expect(open.aspects['Motiv']).toEqual(['Holz'])
  })

  it('repairs a rejected value from the facts when the facts fit the list', () => {
    // The copywriter wrote something the category rejects, while the seller's
    // own stated material is on the list. Dropping and refilling is the right
    // outcome, and both halves must be reported.
    const result = plan([spec('Material', { mode: 'SELECTION_ONLY', allowedValues: ['PLA', 'PETG'] })], {
      Material: ['Holz'],
    })
    expect(result.aspects['Material']).toEqual(['PLA'])
    expect(codes(result)).toContain('value-not-allowed')
    expect(codes(result)).toContain('filled-from-facts')
  })

  it('snaps rather than drops a value that differs only in case', () => {
    const result = plan([spec('Material', { mode: 'SELECTION_ONLY', allowedValues: ['PLA'] })], { Material: ['pla'] })
    expect(result.aspects['Material']).toEqual(['PLA'])
    expect(codes(result)).not.toContain('value-not-allowed')
  })

  it('does not judge a miss against a truncated list', () => {
    // Marke runs to tens of thousands of entries; a capped list proves nothing.
    const result = plan(
      [spec('Marke', { mode: 'SELECTION_ONLY', allowedValues: ['Acme'], valuesTruncated: true })],
      { Marke: ['Eigenbau'] },
    )
    expect(result.aspects['Marke']).toEqual(['Eigenbau'])
    expect(codes(result)).not.toContain('value-not-allowed')
  })

  it('keeps a value exactly at the length limit and drops one over it', () => {
    const atLimit = plan([spec('Motiv', { maxLength: 5 })], { Motiv: ['12345'] })
    expect(atLimit.aspects['Motiv']).toEqual(['12345'])

    const over = plan([spec('Motiv', { maxLength: 5 })], { Motiv: ['123456'] })
    expect(over.aspects['Motiv']).toBeUndefined()
    expect(codes(over)).toContain('value-too-long')
  })

  it('never truncates — a shortened value would be untrue and unfilterable', () => {
    const result = plan([spec('Motiv', { maxLength: 10 })], { Motiv: ['Handgefertigt aus schwarzem PLA'] })
    expect(JSON.stringify(result.aspects)).not.toContain('Handgefer')
  })

  it('keeps a long value when eBay stated no limit', () => {
    const long = 'x'.repeat(200)
    expect(plan([spec('Motiv')], { Motiv: [long] }).aspects['Motiv']).toEqual([long])
  })

  it('deduplicates values that differ only in case', () => {
    expect(plan([spec('Farbe')], { Farbe: ['Schwarz', 'schwarz'] }).aspects['Farbe']).toEqual(['Schwarz'])
  })
})

describe('cardinality', () => {
  it('trims to one value under SINGLE and warns', () => {
    const result = plan([spec('Farbe', { cardinality: 'SINGLE' })], { Farbe: ['Schwarz', 'Rot'] })
    expect(result.aspects['Farbe']).toHaveLength(1)
    expect(codes(result)).toContain('cardinality-trimmed')
  })

  it('keeps both under MULTI without a warning', () => {
    const result = plan([spec('Farbe', { cardinality: 'MULTI' })], { Farbe: ['Schwarz', 'Rot'] })
    expect(result.aspects['Farbe']).toEqual(['Schwarz', 'Rot'])
    expect(codes(result)).not.toContain('cardinality-trimmed')
  })

  it('keeps the value buyers filter on most when facets are available', () => {
    const facets: FacetCount[] = [
      { name: 'Farbe', value: 'Rot', count: 900 },
      { name: 'Farbe', value: 'Schwarz', count: 40 },
    ]
    const result = plan([spec('Farbe', { cardinality: 'SINGLE' })], { Farbe: ['Schwarz', 'Rot'] }, { facets })
    expect(result.aspects['Farbe']).toEqual(['Rot'])
  })

  it('keeps the first value when no facets exist, so the choice is deterministic', () => {
    const result = plan([spec('Farbe', { cardinality: 'SINGLE' })], { Farbe: ['Schwarz', 'Rot'] })
    expect(result.aspects['Farbe']).toEqual(['Schwarz'])
  })
})

describe('required aspects', () => {
  it('blocks when a required aspect stays empty', () => {
    const result = plan([spec('Produktart', { required: true })])
    expect(result.missingRequired).toEqual(['Produktart'])
    expect(result.findings.find((f) => f.code === 'missing-required')?.severity).toBe('blocker')
  })

  it('escalates to a blocker when a drop empties a required aspect', () => {
    const result = plan(
      [spec('Material', { required: true, mode: 'SELECTION_ONLY', allowedValues: ['PETG'] })],
      { Material: ['Holz'] },
    )
    expect(result.missingRequired).toEqual(['Material'])
    expect(codes(result)).toContain('value-not-allowed')
  })

  it('leaves the same drop on an optional aspect as a warning only', () => {
    const result = plan(
      [spec('Motiv', { required: false, mode: 'SELECTION_ONLY', allowedValues: ['Drache'] })],
      { Motiv: ['Holz'] },
    )
    expect(result.missingRequired).toEqual([])
    expect(result.findings.every((f) => f.severity !== 'blocker')).toBe(true)
  })

  it('records the aspectUsage contradiction without acting on it', () => {
    const result = plan([spec('Farbe', { usage: 'REQUIRED', required: false })])
    const finding = result.findings.find((f) => f.code === 'usage-mismatch')
    expect(finding?.severity).toBe('info')
    expect(result.missingRequired).toEqual([])
  })
})

describe('filling from the seller facts', () => {
  it('fills brand, material, colour, origin and handmade', () => {
    const result = plan([
      spec('Marke'),
      spec('Material'),
      spec('Farbe'),
      spec('Herstellungsland und -region'),
      spec('Handgefertigt', { allowedValues: ['Ja', 'Nein'] }),
    ])
    expect(result.aspects).toMatchObject({
      Marke: ['Markenlos'],
      Material: ['PLA'],
      Farbe: ['Schwarz'],
      'Herstellungsland und -region': ['Deutschland'],
      Handgefertigt: ['Ja'],
    })
  })

  it('recognises the other names eBay gives the same field', () => {
    // Verified live: the dart-accessories category calls the origin field
    // "Ursprungsland", not "Herstellungsland". A table built from one category
    // silently fills nothing in the next one.
    expect(plan([spec('Ursprungsland')]).aspects['Ursprungsland']).toEqual(['Deutschland'])
    expect(plan([spec('Herstellernummer')]).aspects['Herstellernummer']).toEqual(['Nicht zutreffend'])
    expect(plan([spec('EAN')]).aspects['EAN']).toEqual(['Nicht zutreffend'])
  })

  it('reports every fill, because these are claims made on the seller behalf', () => {
    const result = plan([spec('Marke')])
    const fill = result.findings.find((f) => f.code === 'filled-from-facts')
    expect(fill).toMatchObject({ severity: 'info', aspect: 'Marke', value: 'Markenlos' })
  })

  it('never overwrites a value the seller already gave', () => {
    expect(plan([spec('Marke')], { Marke: ['Werkstatt Nord'] }).aspects['Marke']).toEqual(['Werkstatt Nord'])
  })

  it('leaves a fact out rather than guessing when it was not measured', () => {
    const sparse = { ...FACTS, colour: null, dimensionsMm: null, weightGrams: null }
    const result = planAspects({
      specs: [spec('Farbe'), spec('Höhe'), spec('Gewicht')],
      current: {},
      facts: sparse,
    })
    expect(result.aspects).toEqual({})
    expect(result.suggestions.map((s) => s.name).sort()).toEqual(['Farbe', 'Gewicht', 'Höhe'])
  })

  it('converts millimetres to centimetres and carries the unit only for text aspects', () => {
    const text = plan([spec('Höhe')])
    expect(text.aspects['Höhe']).toEqual(['4 cm'])

    const numeric = plan([spec('Höhe', { dataType: 'NUMBER' })])
    expect(numeric.aspects['Höhe']).toEqual(['4'])
  })

  it('skips a proposed fill that the category does not allow, without warning', () => {
    // The tool proposed it, not the seller, so there is nothing to report.
    const result = plan([spec('Handgefertigt', { mode: 'SELECTION_ONLY', allowedValues: ['Yes', 'No'] })])
    expect(result.aspects['Handgefertigt']).toBeUndefined()
    expect(codes(result)).not.toContain('value-not-allowed')
  })
})

describe('facets never override facts', () => {
  it('keeps the stated material even when the market overwhelmingly says otherwise', () => {
    const facets: FacetCount[] = [{ name: 'Material', value: 'PLA', count: 9999 }]
    const result = plan([spec('Material')], { Material: ['PETG'] }, { facets })
    expect(result.aspects['Material']).toEqual(['PETG'])
  })

  it('does adopt the market spelling of a value the seller already stated', () => {
    const result = plan(
      [spec('Material', { allowedValues: ['PETG'] })],
      { Material: ['petg'] },
      { facets: [{ name: 'Material', value: 'PETG', count: 12 }] },
    )
    expect(result.aspects['Material']).toEqual(['PETG'])
  })
})

describe('unknown aspects', () => {
  it('keeps a custom item specific rather than discarding seller data', () => {
    const result = plan([spec('Farbe')], { Schichthöhe: ['0,16 mm'] })
    expect(result.aspects['Schichthöhe']).toEqual(['0,16 mm'])
    expect(result.findings.find((f) => f.code === 'unknown-aspect')?.severity).toBe('info')
  })

  it('passes everything through untouched when the category returned no specs', () => {
    const result = plan([], { Material: ['PLA'], Farbe: ['Schwarz'] })
    expect(result.aspects).toEqual({ Material: ['PLA'], Farbe: ['Schwarz'] })
    expect(result.missingRequired).toEqual([])
  })
})

describe('the fill target', () => {
  function nSpecs(n: number): AspectSpec[] {
    return Array.from({ length: n }, (_, i) => spec(`Merkmal ${i}`))
  }
  function nValues(n: number): Record<string, string[]> {
    return Object.fromEntries(Array.from({ length: n }, (_, i) => [`Merkmal ${i}`, ['x']]))
  }

  it('warns below the target and stays quiet at it', () => {
    const nine = plan(nSpecs(ASPECT_TARGET), nValues(ASPECT_TARGET - 1))
    expect(nine.filled).toBe(ASPECT_TARGET - 1)
    expect(codes(nine)).toContain('below-target')

    const ten = plan(nSpecs(ASPECT_TARGET), nValues(ASPECT_TARGET))
    expect(codes(ten)).not.toContain('below-target')
  })

  it('says something stronger below the measured performance floor', () => {
    const six = plan(nSpecs(ASPECT_FLOOR), nValues(ASPECT_FLOOR - 1))
    const finding = six.findings.find((f) => f.code === 'below-target')
    expect(finding?.detail).toMatch(/twice as well/)
  })

  it('never blocks on the target — that is the seller decision', () => {
    const result = plan(nSpecs(3), nValues(1))
    expect(result.findings.every((f) => f.severity !== 'blocker')).toBe(true)
  })

  it('does not count an aspect whose values were all dropped', () => {
    const result = plan([spec('Thema', { mode: 'SELECTION_ONLY', allowedValues: ['Fantasy'] }), spec('Motiv')], {
      Thema: ['Holz'],
      Motiv: ['Drache'],
    })
    expect(result.filled).toBe(1)
  })
})

describe('purity and determinism', () => {
  it('produces identical output for identical input', () => {
    const specs = [spec('Farbe', { cardinality: 'SINGLE' }), spec('Material'), spec('Motiv', { required: true })]
    const current = { Farbe: ['Rot', 'Blau'], Material: ['PLA'] }
    expect(plan(specs, current)).toEqual(plan(specs, current))
  })

  it('does not mutate the caller input', () => {
    const current = Object.freeze({ Material: Object.freeze(['PLA']) as string[] })
    expect(() => plan([spec('Material')], current)).not.toThrow()
    expect(current).toEqual({ Material: ['PLA'] })
  })

  it('treats an absent facet list the same as an empty one', () => {
    const specs = [spec('Farbe', { cardinality: 'SINGLE' })]
    const current = { Farbe: ['Schwarz', 'Rot'] }
    expect(plan(specs, current, { facets: undefined }).aspects).toEqual(plan(specs, current, { facets: [] }).aspects)
  })

  it('orders findings blockers first', () => {
    const result = plan([spec('Produktart', { required: true }), spec('Farbe', { usage: 'REQUIRED' })])
    expect(result.findings[0]?.severity).toBe('blocker')
  })
})

describe('suggestions', () => {
  it('ranks required aspects first, then by how often buyers filter on them', () => {
    const result = plan([
      spec('Selten', { searchCount: 5 }),
      spec('Beliebt', { searchCount: 9000 }),
      spec('Pflicht', { required: true, searchCount: 1 }),
    ])
    expect(result.suggestions.map((s) => s.name)).toEqual(['Pflicht', 'Beliebt', 'Selten'])
  })

  it('orders options by real filter usage when facets exist', () => {
    const result = plan(
      [spec('Motiv', { allowedValues: ['Drache', 'Katze'] })],
      {},
      { facets: [{ name: 'Motiv', value: 'Katze', count: 500 }] },
    )
    expect(result.suggestions[0]?.options[0]?.value).toBe('Katze')
  })

  it('does not suggest an aspect that is already filled', () => {
    const result = plan([spec('Material')], { Material: ['PLA'] })
    expect(result.suggestions).toEqual([])
  })
})

describe('required-soon', () => {
  it('warns only when a date is near and a clock was supplied', () => {
    const specs = [spec('Farbe', { requiredByDate: '2026-09-01' })]
    const near = plan(specs, {}, { now: new Date('2026-08-20T00:00:00Z') })
    expect(codes(near)).toContain('required-soon')

    const far = plan(specs, {}, { now: new Date('2026-01-01T00:00:00Z') })
    expect(codes(far)).not.toContain('required-soon')

    // No clock, no judgement — keeps the function pure by default.
    expect(codes(plan(specs))).not.toContain('required-soon')
  })
})
