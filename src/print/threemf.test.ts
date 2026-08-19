import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { parse3mf, parseGcodeDuration, PARSER_VERSION } from './threemf.js'

/**
 * Fixtures are the user's two real Bambu Studio exports (02.06.00.51,
 * 2026-08-19), trimmed for the repo: G-code entries cut to their header
 * block — the only part the parser reads — and image blobs stubbed to one
 * byte with their names intact. Every metadata file the parser touches is
 * byte-identical to the real export. The edge cases the real files cannot
 * show (colour variants, skipped objects, multi-filament) are built here by
 * mutating those fixtures in memory, each labelled as synthetic.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)))

/** Unzip → mutate entries → rezip, for the synthetic cases. */
function mutate(archive: Uint8Array, change: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(archive)
  change(files)
  return zipSync(files)
}

describe('parse3mf on the real single-plate export', () => {
  const spec = parse3mf(load('single-plate.gcode.3mf'))

  it('reads weight and times from slice_info and the G-code header', () => {
    expect(spec.plates).toHaveLength(1)
    const plate = spec.plates[0]!
    // The values Bambu Studio displayed, confirmed by the user.
    expect(plate.weightG).toBe(60.78)
    expect(plate.printTimeSec).toBe(9163) // total estimated ("prediction")
    expect(plate.modelPrintTimeSec).toBe(8787) // "2h 26m 27s"
    expect(plate.totalLayers).toBe(750)
  })

  it('takes height from max_z_height and width/depth from the plate bbox', () => {
    // 120.04 matched the printed 120 mm variant to a tenth of a millimetre;
    // bbox_all is the full X/Y projection (user-confirmed against the scale
    // display), not the first-layer footprint.
    expect(spec.heightMm).toBe(120.04)
    expect(spec.widthMm).toBe(90.75)
    expect(spec.depthMm).toBe(104.32)
    expect(spec.dimensionSource).toBe('PLATE_JSON_GCODE')
    expect(spec.needsReview).toBe(false)
  })

  it('captures the filament and the printed objects', () => {
    const plate = spec.plates[0]!
    expect(plate.filaments).toEqual([{ id: '1', type: 'PLA', colorHex: '#898989', usedG: 60.78, usedM: 20.38 }])
    expect(plate.objectNames).toEqual(['Body1.stl'])
    expect(spec.colourVariants).toBe(false)
  })

  it('records the provenance the export itself carries', () => {
    // The geometry-less root model still names the source: enough to
    // cross-check an upload against the listing later.
    expect(spec.provenance.designer).toBe('Makerspace.Online')
    expect(spec.provenance.licenseRaw).toBe('Standard Digital File License')
    expect(spec.provenance.slicerVersion).toContain('BambuStudio')
    expect(spec.unitDeclared).toBe('millimeter')
  })

  it('lists the designer pictures without extracting them', () => {
    expect(spec.auxiliaryPictures.length).toBeGreaterThanOrEqual(5)
    expect(spec.auxiliaryPictures.every((n) => n.startsWith('Auxiliaries/Model Pictures/'))).toBe(true)
  })

  it('stamps the audit fields', () => {
    expect(spec.fileSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(spec.parserVersion).toBe(PARSER_VERSION)
  })
})

describe('the plate policy', () => {
  it('rejects plates that are different parts — assemblies stay manual', () => {
    // The real two-plate export: a 120 mm and a 150 mm variant. Different
    // heights, different filament use — not colour variants of one part.
    expect(() => parse3mf(load('two-plates-different.gcode.3mf'))).toThrow(/unterschiedliche Druckplatten/)
  })

  it('accepts several plates when only the filament differs (synthetic)', () => {
    // Built from the real export: plate 2 becomes a byte-level clone of
    // plate 1 — same part, same G-code header, same bbox — with only the
    // filament colour changed. That is the one multi-plate case the user
    // accepts: colour variants of the same part.
    const archive = mutate(load('two-plates-different.gcode.3mf'), (files) => {
      const info = strFromU8(files['Metadata/slice_info.config']!)
      const plates = info.split('<plate>')
      const head = plates[0]!
      const plate1 = plates[1]!
      const plate2 = plate1
        .replace('key="index" value="1"', 'key="index" value="2"')
        .replace('color="#898989"', 'color="#FFFFFF"')
      files['Metadata/slice_info.config'] = strToU8(head + '<plate>' + plate1 + '<plate>' + plate2)
      files['Metadata/plate_2.gcode'] = files['Metadata/plate_1.gcode']!
      files['Metadata/plate_2.json'] = files['Metadata/plate_1.json']!
    })

    const spec = parse3mf(archive)
    expect(spec.colourVariants).toBe(true)
    expect(spec.plates).toHaveLength(2)
    expect(spec.plates.map((p) => p.filaments[0]?.colorHex)).toEqual(['#898989', '#FFFFFF'])
    // Dimensions are shared by construction — one part, two colours.
    expect(spec.heightMm).toBe(120.04)
  })
})

describe('slice_info details', () => {
  it('does not count skipped objects (synthetic)', () => {
    const archive = mutate(load('single-plate.gcode.3mf'), (files) => {
      const info = strFromU8(files['Metadata/slice_info.config']!)
      files['Metadata/slice_info.config'] = strToU8(
        info.replace(
          '<object identify_id="108"',
          '<object identify_id="999" name="Ausgelassen.stl" skipped="true" /><object identify_id="108"',
        ),
      )
    })
    expect(parse3mf(archive).plates[0]!.objectNames).toEqual(['Body1.stl'])
  })

  it('captures every filament of a multi-colour plate (synthetic)', () => {
    const archive = mutate(load('single-plate.gcode.3mf'), (files) => {
      const info = strFromU8(files['Metadata/slice_info.config']!)
      const filament = /<filament [^/]+\/>/.exec(info)![0]
      const second = filament
        .replace('id="1"', 'id="2"')
        .replace('color="#898989"', 'color="#FF0000"')
        .replace('type="PLA"', 'type="PETG"')
      files['Metadata/slice_info.config'] = strToU8(info.replace(filament, filament + second))
    })
    const filaments = parse3mf(archive).plates[0]!.filaments
    expect(filaments).toHaveLength(2)
    expect(filaments.map((f) => f.type)).toEqual(['PLA', 'PETG'])
    expect(filaments.map((f) => f.colorHex)).toEqual(['#898989', '#FF0000'])
  })
})

describe('review flags', () => {
  it('flags a lying-down print instead of guessing the standing height (synthetic)', () => {
    // BBox axes carry no semantics: Z smallest of the three means "Höhe" is
    // the seller's call, not the parser's.
    const archive = mutate(load('single-plate.gcode.3mf'), (files) => {
      const head = strFromU8(files['Metadata/plate_1.gcode']!)
      files['Metadata/plate_1.gcode'] = strToU8(head.replace(/max_z_height: [\d.]+/, 'max_z_height: 5.00'))
    })
    const spec = parse3mf(archive)
    expect(spec.heightMm).toBe(5)
    expect(spec.needsReview).toBe(true)
    expect(spec.reviewReason).toBe('ORIENTATION_AMBIGUOUS')
  })

  it('degrades to review, never to a guess, when the bbox is unreadable (synthetic)', () => {
    const archive = mutate(load('single-plate.gcode.3mf'), (files) => {
      files['Metadata/plate_1.json'] = strToU8('not json')
    })
    const spec = parse3mf(archive)
    expect(spec.widthMm).toBeNull()
    expect(spec.needsReview).toBe(true)
    expect(spec.reviewReason).toBe('DIMENSIONS_INCOMPLETE')
  })
})

describe('refusals', () => {
  it('refuses a 3MF without slice data — that is a raw model, not a sliced plate', () => {
    const archive = mutate(load('single-plate.gcode.3mf'), (files) => {
      delete files['Metadata/slice_info.config']
    })
    expect(() => parse3mf(archive)).toThrow(/keine Slice-Daten/)
  })

  it('refuses a corrupt archive with a readable error', () => {
    expect(() => parse3mf(load('single-plate.gcode.3mf').subarray(0, 100))).toThrow(/kein lesbares 3MF/)
  })
})

describe('parseGcodeDuration', () => {
  it('reads the header time formats', () => {
    expect(parseGcodeDuration('2h 56m 6s')).toBe(10566)
    expect(parseGcodeDuration('2h 26m 27s')).toBe(8787)
    expect(parseGcodeDuration('3m 5s')).toBe(185)
    expect(parseGcodeDuration('45s')).toBe(45)
    expect(parseGcodeDuration('garbage')).toBeNull()
  })
})
