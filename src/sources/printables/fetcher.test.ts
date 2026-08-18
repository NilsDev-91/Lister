import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseModelUrl, parsePrint } from './fetcher.js'
import { normaliseLicense } from '../license.js'

/**
 * Offline tests against pinned real API responses (2026-08-18):
 * `print-3161-benchy.json` is the adapter's own query for a real model,
 * `licenses.json` the platform's full licence catalog. The endpoint is
 * undocumented, so the fixtures are the contract we verified — a test that
 * needs the network is a bug in the test.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

describe('parseModelUrl', () => {
  it('accepts the shapes buyers paste, with and without slug and locale', () => {
    for (const url of [
      'https://www.printables.com/model/3161-3d-benchy',
      'https://printables.com/model/3161',
      'https://www.printables.com/de/model/3161-3d-benchy',
      'https://www.printables.com/cs/model/3161-3d-benchy#comments',
      'https://www.printables.com/model/3161-3d-benchy?lang=de',
    ]) {
      expect(parseModelUrl(url).externalId, url).toBe('3161')
    }
  })

  it('normalises to one locale- and slug-free URL for the duplicate warning', () => {
    expect(parseModelUrl('https://www.printables.com/de/model/3161-3d-benchy').normalised).toBe(
      'https://www.printables.com/model/3161',
    )
  })

  it('rejects what is not a model page', () => {
    for (const url of [
      'https://www.printables.com/@PrusaResearch',
      'https://www.printables.com/model/not-a-number',
      'https://makerworld.com/en/models/3161',
      'not a url',
    ]) {
      expect(() => parseModelUrl(url), url).toThrow()
    }
  })
})

describe('parsePrint (real API response)', () => {
  const payload = (fixture('print-3161-benchy.json') as { data: { print: unknown } }).data.print

  it('maps the print onto the shared source-model shape', () => {
    const model = parsePrint(payload)
    expect(model.platform).toBe('PRINTABLES')
    expect(model.externalId).toBe('3161')
    expect(model.title).toBe('3D BENCHY')
    expect(model.designer).toBe('Prusa Research')
    expect(model.tags).toContain('benchy')
    expect(model.sourceUrl).toBe('https://www.printables.com/model/3161')
  })

  it('turns the HTML description into prose for the copywriter', () => {
    const model = parsePrint(payload)
    expect(model.description).toContain('benchmarking 3D printers')
    expect(model.description).not.toMatch(/<[a-z]/i)
  })

  it('resolves image paths against the media host', () => {
    const model = parsePrint(payload)
    expect(model.images).toHaveLength(2)
    expect(model.images[0]?.url).toMatch(/^https:\/\/media\.printables\.com\/media\/prints\/3161\//)
    expect(model.images.map((i) => i.rank)).toEqual([0, 1])
  })

  it("reads the licence through Printables' own vocabulary", () => {
    const model = parsePrint(payload)
    expect(model.license.raw).toBe('Creative Commons — Public Domain')
    expect(model.license.code).toBe('CC0-1.0')
    expect(model.license.commercialUse).toBe('yes')
  })

  it('refuses a payload in an unexpected shape rather than guessing', () => {
    expect(() => parsePrint({ id: '1' })).toThrow(/unexpected shape/)
  })
})

describe('the licence catalog (real API response)', () => {
  const catalog = (fixture('licenses.json') as { data: { licenses: { id: string; name: string }[] } }).data.licenses

  it('covers every licence the platform can emit — none falls through to "Unrecognised"', () => {
    for (const entry of catalog) {
      const info = normaliseLicense(entry.name, 'PRINTABLES')
      expect(info.reason, `${entry.name} must resolve via the table`).not.toMatch(/Unrecognised/)
      expect(info.code, `${entry.name} must carry a code`).not.toBeNull()
    }
  })

  it('pins the verdicts', () => {
    expect(normaliseLicense('Creative Commons — Attribution', 'PRINTABLES').commercialUse).toBe('yes')
    expect(normaliseLicense('Creative Commons — Attribution  — Noncommercial', 'PRINTABLES').commercialUse).toBe('no')
    expect(normaliseLicense('Commercial Use', 'PRINTABLES').commercialUse).toBe('yes')
    expect(normaliseLicense('Standard Digital File License', 'PRINTABLES').commercialUse).toBe('no')
    // Prusa's OCL family and the copyleft licences route to the prompt: their
    // coverage of a *printed copy* is contested, and guessing either way would
    // be wrong in one direction or the other.
    expect(normaliseLicense('Open Community License v1.1 + Micro Business v1', 'PRINTABLES').commercialUse).toBe('unknown')
    expect(normaliseLicense('GNU General Public License v3.0', 'PRINTABLES').commercialUse).toBe('unknown')
  })

  it('keeps the sale-only Commercial Use licences off the designer-media path', () => {
    // Same rule as Cults3D CU: the sale is licensed, the page media are not.
    const cu = normaliseLicense('Commercial Use', 'PRINTABLES')
    expect(cu.code).toBe('PRINTABLES-CU')
    expect(/^CC(0|-BY)/.test(cu.code ?? '')).toBe(false)
  })
})
