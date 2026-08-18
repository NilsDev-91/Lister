import { describe, it, expect } from 'vitest'
import { aspectRows, formatValues, parseAspectFields, splitValues } from './aspect-fields.js'

/**
 * The per-aspect editor exists to make two accidents impossible: emptying a
 * value without noticing, and forgetting an aspect eBay requires. Both halves
 * are pinned here, plus the round trip through the form field names.
 */

/** The fields a browser would post for these rows, as the server sees them. */
function submit(rows: ReturnType<typeof aspectRows>, edits: Record<number, Partial<{ name: string; value: string; drop: boolean }>> = {}) {
  const fields: Record<string, string> = {}
  rows.forEach((row, index) => {
    const edit = edits[index] ?? {}
    fields[`aspectName${index}`] = edit.name ?? row.name
    fields[`aspectValue${index}`] = edit.value ?? row.value
    // Mirrors the view: a box we labelled but left empty carries the marker.
    if (row.name && !row.locked) fields[`aspectHint${index}`] = '1'
    if (edit.drop) fields[`aspectDrop${index}`] = '1'
  })
  return fields
}

describe('aspectRows', () => {
  it('locks every stored aspect, so its value cannot be emptied by accident', () => {
    const rows = aspectRows({ Marke: ['Markenlos'], Material: ['PLA', 'PETG'] }, [], 0)
    expect(rows).toEqual([
      { name: 'Marke', value: 'Markenlos', requiredByEbay: false, locked: true },
      { name: 'Material', value: 'PLA, PETG', requiredByEbay: false, locked: true },
    ])
  })

  it('quotes a value that carries a comma, so the round trip keeps it whole', () => {
    const rows = aspectRows({ 'Höhe': ['1,5 cm'] }, [], 0)
    expect(rows[0]!.value).toBe('"1,5 cm"')
  })

  it('shows an aspect eBay requires even when it has no value yet', () => {
    const rows = aspectRows({ Marke: ['Markenlos'] }, ['Marke', 'Produktart'], 0)
    expect(rows.map((r) => [r.name, r.requiredByEbay, r.locked])).toEqual([
      ['Marke', true, true],
      ['Produktart', true, false],
    ])
  })

  it('does not lock a required-but-empty box — that would block every save', () => {
    // Preflight and the publish gate already refuse a listing without it; a
    // browser-level block here would stop the seller fixing a typo elsewhere.
    const rows = aspectRows({}, ['Produktart'], 0)
    expect(rows[0]!.locked).toBe(false)
  })

  it('matches a required name case-insensitively rather than showing it twice', () => {
    const rows = aspectRows({ marke: ['Markenlos'] }, ['Marke'], 0)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.requiredByEbay).toBe(true)
  })

  it('appends blank rows, because a generated form must still be able to ADD', () => {
    const rows = aspectRows({ Marke: ['Markenlos'] }, [], 2)
    expect(rows.slice(1)).toEqual([
      { name: '', value: '', requiredByEbay: false, locked: false },
      { name: '', value: '', requiredByEbay: false, locked: false },
    ])
  })
})

describe('parseAspectFields', () => {
  it('reads the indexed fields back into aspects', () => {
    const parsed = parseAspectFields({
      aspectName0: 'Marke',
      aspectValue0: 'Markenlos',
      aspectName1: 'Material',
      aspectValue1: 'PLA, PETG',
    })
    expect(parsed.present).toBe(true)
    expect(parsed.errors).toEqual([])
    expect(parsed.aspects).toEqual({ Marke: ['Markenlos'], Material: ['PLA', 'PETG'] })
  })

  it('survives the full round trip, quoted commas included', () => {
    const aspects = { Marke: ['Markenlos'], 'Höhe': ['1,5 cm'], Material: ['PLA', 'PETG'] }
    const parsed = parseAspectFields(submit(aspectRows(aspects, [], 2)))
    expect(parsed.aspects).toEqual(aspects)
    expect(parsed.errors).toEqual([])
  })

  it('drops only what the tick marks, and keeps the rest', () => {
    const rows = aspectRows({ Marke: ['Markenlos'], Material: ['PLA'] }, [], 0)
    const parsed = parseAspectFields(submit(rows, { 1: { drop: true } }))
    expect(parsed.aspects).toEqual({ Marke: ['Markenlos'] })
    expect(parsed.errors).toEqual([])
  })

  it('refuses a name whose value was emptied instead of losing it silently', () => {
    const rows = aspectRows({ Marke: ['Markenlos'] }, [], 0)
    const parsed = parseAspectFields(submit(rows, { 0: { value: '' } }))
    expect(parsed.aspects).toEqual({})
    expect(parsed.errors[0]).toMatch(/"Marke" hat keinen Wert/)
  })

  it('refuses a value typed without a name', () => {
    const parsed = parseAspectFields({ aspectName0: '   ', aspectValue0: 'PETG' })
    expect(parsed.errors[0]).toMatch(/ohne Namen/)
    expect(parsed.aspects).toEqual({})
  })

  it('ignores an untouched blank row', () => {
    const parsed = parseAspectFields({ aspectName0: '', aspectValue0: '' })
    expect(parsed).toEqual({ aspects: {}, errors: [], present: true })
  })

  it('skips a required-but-empty box without complaining', () => {
    // It is shown as a reminder, not as an edit in progress.
    const parsed = parseAspectFields(submit(aspectRows({}, ['Produktart'], 0)))
    expect(parsed.errors).toEqual([])
    expect(parsed.aspects).toEqual({})
  })

  it('merges a repeated name rather than dropping the first', () => {
    const parsed = parseAspectFields({
      aspectName0: 'Farbe',
      aspectValue0: 'Schwarz',
      aspectName1: 'Farbe',
      aspectValue1: 'Rot',
    })
    expect(parsed.aspects).toEqual({ Farbe: ['Schwarz', 'Rot'] })
  })

  it('reports "no aspect fields" rather than an empty set — silence is not a delete', () => {
    // A page from before this editor, or a hand-built POST. The caller keeps
    // what is stored; reading this as "remove everything" is the exact
    // accident the editor exists to prevent.
    expect(parseAspectFields({ ebayTitle: 'x' })).toEqual({ aspects: {}, errors: [], present: false })
  })

  it('reads rows in numeric order, not string order', () => {
    const parsed = parseAspectFields({
      aspectName10: 'Zehn',
      aspectValue10: 'b',
      aspectName2: 'Zwei',
      aspectValue2: 'a',
    })
    expect(Object.keys(parsed.aspects)).toEqual(['Zwei', 'Zehn'])
  })
})

describe('value quoting (moved here with the helpers from aspect-text.ts)', () => {
  it('keeps a value that carries the separator whole', () => {
    // Real eBay values carry commas — "Höhe 1,5 cm" — and the round trip used
    // to split them into two values.
    const values = ['Höhe 1,5 cm', 'Breite 3 cm']
    expect(splitValues(formatValues(values))).toEqual(values)
  })

  it('keeps a bare quote — the inch mark is not a quoting toggle', () => {
    const values = ['5" Zoll', 'klein']
    expect(splitValues(formatValues(values))).toEqual(values)
  })

  it('keeps a value that is only a trailing quote', () => {
    expect(splitValues(formatValues(['12"']))).toEqual(['12"'])
  })

  it('escapes an embedded quote by doubling, CSV-style', () => {
    const values = ['Modell "Drache", Version 2']
    expect(formatValues(values)).toBe('"Modell ""Drache"", Version 2"')
    expect(splitValues(formatValues(values))).toEqual(values)
  })

  it('leaves an ordinary value unquoted and handles the empty case', () => {
    expect(formatValues(['PLA', 'PETG'])).toBe('PLA, PETG')
    expect(formatValues([])).toBe('')
    expect(splitValues('')).toEqual([])
    expect(splitValues('  ,  ')).toEqual([])
  })
})
