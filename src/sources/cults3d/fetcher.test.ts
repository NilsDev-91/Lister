import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseModelUrl, parseCreation } from './fetcher.js'
import { normaliseLicense } from '../license.js'

/**
 * Offline tests against pinned real API responses.
 *
 * Both fixtures are verbatim captures from https://cults3d.com/graphql
 * (2026-08-18): `creation-flexi-turtle.json` is the adapter's own query for a
 * real model, `licenses.json` is the platform's full licence catalog. Testing
 * against them keeps the suite offline while still exercising the shapes the
 * live API actually sends — a test that needs the network is a bug in the test.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

describe('parseModelUrl', () => {
  it('accepts every locale shape the API itself links to', () => {
    // The exact URLs Cults3D returned for url(locale: …) on one real model.
    for (const url of [
      'https://cults3d.com/en/3d-model/gadget/flexi-turtle',
      'https://cults3d.com/de/modell-3d/gadget/flexi-turtle',
      'https://cults3d.com/fr/mod%C3%A8le-3d/gadget/flexi-turtle',
      'https://cults3d.com/es/modelo-3d/artilugios/flexi-turtle',
      'https://cults3d.com/it/modello-3d/gadget/flexi-turtle',
      'https://cults3d.com/pt/modelo-3d/gadget/flexi-turtle',
      'https://cults3d.com/ja/3d-moderu/gajetto/flexi-turtle',
      'https://cults3d.com/ru/3d-model/gadzhet/flexi-turtle',
      'https://cults3d.com/zh/3d-m%C3%B3x%C3%ADng/xi%C7%8Eog%C5%8Dng-j%C3%B9/flexi-turtle',
      'https://cults3d.com/tr/3d-model/gadget/flexi-turtle',
      'https://www.cults3d.com/en/3d-model/gadget/flexi-turtle?utm_source=x#section',
    ]) {
      expect(parseModelUrl(url).externalId, url).toBe('flexi-turtle')
    }
  })

  it('strips query and fragment from the normalised URL', () => {
    expect(parseModelUrl('https://cults3d.com/en/3d-model/gadget/flexi-turtle?a=1#b').normalised).toBe(
      'https://cults3d.com/en/3d-model/gadget/flexi-turtle',
    )
  })

  it('rejects what is not a model page', () => {
    for (const url of [
      'https://cults3d.com/en/users/kendofuji/creations', // profile, also 4 segments
      'https://cults3d.com/:337322', // short link — no slug to query by
      'https://cults3d.com/en/api/keys',
      'https://makerworld.com/en/models/1029890',
      'not a url',
    ]) {
      expect(() => parseModelUrl(url), url).toThrow()
    }
  })
})

describe('parseCreation (real API response)', () => {
  const payload = (fixture('creation-flexi-turtle.json') as { data: { creation: unknown } }).data.creation

  it('maps the creation onto the shared source-model shape', () => {
    const model = parseCreation(payload, 'https://cults3d.com/de/modell-3d/gadget/flexi-turtle')
    expect(model.platform).toBe('CULTS3D')
    expect(model.externalId).toBe('flexi-turtle')
    expect(model.title).toBe('flexi turtle')
    expect(model.designer).toBe('kendofuji')
    expect(model.tags).toContain('print-in-place')
    expect(model.description).toContain('PRINT-IN-PLACE')
  })

  it('canonicalises sourceUrl to the API\'s English URL, whatever locale was pasted', () => {
    // The duplicate warning keys on sourceUrl; one model must map to one URL.
    const model = parseCreation(payload, 'https://cults3d.com/de/modell-3d/gadget/flexi-turtle')
    expect(model.sourceUrl).toBe('https://cults3d.com/en/3d-model/gadget/flexi-turtle')
  })

  it('orders the gallery by position and re-ranks from zero', () => {
    const model = parseCreation(payload, 'x://ignored')
    expect(model.images).toHaveLength(12)
    expect(model.images.map((i) => i.rank)).toEqual([...model.images.keys()])
    expect(model.images[0]?.url).toMatch(/^https:\/\//)
  })

  it('resolves the Private Use licence to a hard no', () => {
    const model = parseCreation(payload, 'x://ignored')
    expect(model.license.code).toBe('LicenseRef-Cults-PU')
    expect(model.license.commercialUse).toBe('no')
  })

  it('refuses a payload in an unexpected shape rather than guessing', () => {
    expect(() => parseCreation({ slug: 'x' }, 'x://ignored')).toThrow(/unexpected shape/)
  })
})

describe('the licence catalog (real API response)', () => {
  const catalog = (
    fixture('licenses.json') as {
      data: { licenses: { code: string; name: string; spdxId: string | null; allowsCommercialUse: boolean }[] }
    }
  ).data.licenses

  it('covers every licence the platform can emit — none falls through to "Unrecognised"', () => {
    for (const entry of catalog) {
      for (const raw of [entry.name, entry.code]) {
        const info = normaliseLicense(raw, 'CULTS3D')
        expect(info.reason, `${raw} must resolve via the table`).not.toMatch(/Unrecognised/)
        expect(info.code, `${raw} must carry a code`).not.toBeNull()
      }
    }
  })

  it('agrees with the platform\'s own spdxId for every entry', () => {
    for (const entry of catalog.filter((e) => e.spdxId)) {
      expect(normaliseLicense(entry.name, 'CULTS3D').code, entry.name).toBe(entry.spdxId)
    }
  })

  it('pins the verdicts, including the two deliberate divergences', () => {
    expect(normaliseLicense('CULTS CU - Commercial Use', 'CULTS3D').commercialUse).toBe('yes')
    expect(normaliseLicense('CULTS PU - Private Use', 'CULTS3D').commercialUse).toBe('no')
    expect(normaliseLicense('CC BY-NC - Attribution - Non commercial', 'CULTS3D').commercialUse).toBe('no')
    // Cults3D flags CC0 non-commercial; CC0-1.0's own text governs → yes.
    expect(normaliseLicense('CC0 - Creative Commons public domain', 'CULTS3D').commercialUse).toBe('yes')
    // GPL-family: text permits commerce with conditions, platform flag says
    // no, print coverage unsettled → the prompt decides, not the code.
    expect(normaliseLicense('GNU GPL - GNU General Public License 3.0', 'CULTS3D').commercialUse).toBe('unknown')
    expect(normaliseLicense('CERN OHL - CERN Open Hardware Licence 1.2', 'CULTS3D').commercialUse).toBe('unknown')
  })
})
