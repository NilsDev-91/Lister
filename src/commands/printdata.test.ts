import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { ListingRecordSchema, type ListingRecord } from '../types.js'

/**
 * Attach/apply against a real store in a scratch data dir.
 *
 * Everything that reads DATA_DIR is imported DYNAMICALLY after the env var is
 * set — the documented trap: a static import freezes the real
 * ~/.3d-print-lister before `beforeAll` runs, and these tests would then
 * write fixtures into the user's actual store.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'print', '__fixtures__')
const singlePlate = (): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, 'single-plate.gcode.3mf')))

const dir = mkdtempSync(join(tmpdir(), 'lister-printdata-'))
let db: typeof import('../store/db.js')
let printdata: typeof import('./printdata.js')

beforeAll(async () => {
  process.env['LISTER_DATA_DIR'] = dir
  db = await import('../store/db.js')
  printdata = await import('./printdata.js')
})

afterAll(() => {
  delete process.env['LISTER_DATA_DIR']
  rmSync(dir, { recursive: true, force: true })
})

const now = '2026-08-19T00:00:00.000Z'

function record(id: string): ListingRecord {
  return ListingRecordSchema.parse({
    id,
    sourceUrl: 'https://makerworld.com/en/models/148232',
    source: {
      sourceUrl: 'https://makerworld.com/en/models/148232',
      externalId: '148232',
      title: 'Moss Pole Base',
      description: '',
      designer: 'Makerspace.Online',
      tags: [],
      images: [],
      license: { raw: 'Standard Digital File License', code: 'BAMBU-SDFL', commercialUse: 'no', reason: 'x' },
      fetchedAt: now,
    },
    product: {
      priceEur: 20.99,
      quantity: 1,
      material: 'PLA',
      colour: null,
      dimensionsMm: null,
      weightGrams: null,
      processingDays: 3,
      notes: '',
    },
    copy: {
      ebay: { title: 'Moosstab-Basis', descriptionHtml: '<p>x</p>', categoryHint: 'Deko', aspects: {} },
      etsy: { title: 'Moss Pole Base', description: 'x', tags: [], materials: [], taxonomyHint: 'Home Decor' },
    },
    imagePaths: [],
    marketplaces: [],
    createdAt: now,
    updatedAt: now,
  })
}

function mutate(archive: Uint8Array, change: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(archive)
  change(files)
  return zipSync(files)
}

const quiet = { step() {}, info() {}, detail() {}, ok() {}, warn() {}, error() {}, confirm: async () => true }

describe('attachPrintData', () => {
  it('parses, stores the file content-addressed and records the version', async () => {
    db.upsert(record('mw-attach-1'))
    const { listing, spec, refreshed } = await printdata.attachPrintData({
      listingId: 'mw-attach-1',
      data: singlePlate(),
      fileName: 'platte1.gcode.3mf',
      io: quiet,
    })

    expect(refreshed).toBe(false)
    expect(listing.printUploads).toHaveLength(1)
    const upload = listing.printUploads[0]!
    expect(upload.spec.plates[0]?.weightG).toBe(60.78)
    expect(upload.filePath).toContain(join(dir, 'uploads', 'mw-attach-1'))
    expect(upload.filePath).toContain(spec.fileSha256)
    expect(existsSync(upload.filePath), 'archive must be stored for reparse').toBe(true)
  })

  it('refreshes instead of duplicating when the same bytes arrive again', async () => {
    db.upsert(record('mw-attach-2'))
    await printdata.attachPrintData({ listingId: 'mw-attach-2', data: singlePlate(), fileName: 'a.gcode.3mf', io: quiet })
    const second = await printdata.attachPrintData({
      listingId: 'mw-attach-2',
      data: singlePlate(),
      fileName: 'a.gcode.3mf',
      io: quiet,
    })
    expect(second.refreshed).toBe(true)
    expect(second.listing.printUploads).toHaveLength(1)
  })

  it('keeps every distinct upload readable, newest last', async () => {
    db.upsert(record('mw-attach-3'))
    await printdata.attachPrintData({ listingId: 'mw-attach-3', data: singlePlate(), fileName: 'v1.gcode.3mf', io: quiet })
    // A "new slice": same part, different bytes (one metadata byte changed).
    const v2 = mutate(singlePlate(), (files) => {
      const info = strFromU8(files['Metadata/slice_info.config']!)
      files['Metadata/slice_info.config'] = strToU8(info.replace('value="60.78"', 'value="61.02"').replace('used_g="60.78"', 'used_g="61.02"'))
    })
    await printdata.attachPrintData({ listingId: 'mw-attach-3', data: v2, fileName: 'v2.gcode.3mf', io: quiet })

    const listing = db.get('mw-attach-3')!
    expect(listing.printUploads).toHaveLength(2)
    expect(listing.printUploads[0]?.spec.plates[0]?.weightG).toBe(60.78)
    expect(listing.printUploads[1]?.spec.plates[0]?.weightG).toBe(61.02)
  })
})

describe('proposedValues', () => {
  it('proposes footprint as Länge/Breite (larger first), height from the print, colours by name', async () => {
    db.upsert(record('mw-prop-1'))
    const { spec } = await printdata.attachPrintData({
      listingId: 'mw-prop-1',
      data: singlePlate(),
      fileName: 'p.gcode.3mf',
      io: quiet,
    })
    expect(printdata.proposedValues(spec)).toEqual({
      lengthMm: 104.32,
      widthMm: 90.75,
      heightMm: 120.04,
      weightGrams: 61,
      material: 'PLA',
      colours: ['Grau'],
    })
  })
})

describe('applyPrintData', () => {
  it('writes product facts, aspects and the per-field audit trail', async () => {
    db.upsert(record('mw-apply-1'))
    const { spec } = await printdata.attachPrintData({
      listingId: 'mw-apply-1',
      data: singlePlate(),
      fileName: 'p.gcode.3mf',
      io: quiet,
    })
    const proposed = printdata.proposedValues(spec)
    const updated = await printdata.applyPrintData({
      listingId: 'mw-apply-1',
      fileSha256: spec.fileSha256,
      ...proposed,
      io: quiet,
    })

    expect(updated.product.weightGrams).toBe(61)
    expect(updated.product.dimensionsMm).toEqual({ length: 104.32, width: 90.75, height: 120.04 })
    expect(updated.product.material).toBe('PLA')
    expect(updated.product.colour).toBe('Grau')
    expect(updated.copy.ebay.aspects['Material']).toEqual(['PLA'])
    expect(updated.copy.ebay.aspects['Farbe']).toEqual(['Grau'])

    for (const field of ['weightGrams', 'dimensionsMm', 'material', 'colour']) {
      const applied = updated.printApplied[field]
      expect(applied?.source, field).toBe('3MF')
      expect(applied?.fileSha256).toBe(spec.fileSha256)
      expect(applied?.parserVersion).toBe(spec.parserVersion)
    }
  })

  it('records an edited value as MANUAL', async () => {
    db.upsert(record('mw-apply-2'))
    const { spec } = await printdata.attachPrintData({
      listingId: 'mw-apply-2',
      data: singlePlate(),
      fileName: 'p.gcode.3mf',
      io: quiet,
    })
    const proposed = printdata.proposedValues(spec)
    const updated = await printdata.applyPrintData({
      listingId: 'mw-apply-2',
      fileSha256: spec.fileSha256,
      ...proposed,
      weightGrams: 63, // seller weighed the real print
      io: quiet,
    })
    expect(updated.product.weightGrams).toBe(63)
    expect(updated.printApplied['weightGrams']?.source).toBe('MANUAL')
    expect(updated.printApplied['material']?.source).toBe('3MF')
  })

  it('never lets a re-attach touch applied values — manual edits survive a reparse', async () => {
    db.upsert(record('mw-apply-3'))
    const { spec } = await printdata.attachPrintData({
      listingId: 'mw-apply-3',
      data: singlePlate(),
      fileName: 'p.gcode.3mf',
      io: quiet,
    })
    await printdata.applyPrintData({
      listingId: 'mw-apply-3',
      fileSha256: spec.fileSha256,
      ...printdata.proposedValues(spec),
      io: quiet,
    })

    // The seller corrects the weight by hand afterwards…
    const edited = db.get('mw-apply-3')!
    db.upsert({ ...edited, product: { ...edited.product, weightGrams: 99 } })

    // …and a later re-parse of the same file refreshes only the evidence.
    await printdata.attachPrintData({ listingId: 'mw-apply-3', data: singlePlate(), fileName: 'p.gcode.3mf', io: quiet })
    expect(db.get('mw-apply-3')!.product.weightGrams).toBe(99)
  })

  it('carries every filament type and colour of variant plates into the aspects', async () => {
    // Synthetic colour-variant archive: plate 2 is plate 1 with different
    // filament — PETG in white instead of PLA in grey.
    const variants = mutate(singlePlate(), (files) => {
      const info = strFromU8(files['Metadata/slice_info.config']!)
      const plates = info.split('<plate>')
      const plate2 = plates[1]!
        .replace('key="index" value="1"', 'key="index" value="2"')
        .replace('color="#898989"', 'color="#FFFFFF"')
        .replace('type="PLA"', 'type="PETG"')
      files['Metadata/slice_info.config'] = strToU8(plates[0]! + '<plate>' + plates[1]! + '<plate>' + plate2)
      files['Metadata/plate_2.gcode'] = files['Metadata/plate_1.gcode']!
      files['Metadata/plate_2.json'] = files['Metadata/plate_1.json']!
    })

    db.upsert(record('mw-apply-4'))
    const { spec } = await printdata.attachPrintData({
      listingId: 'mw-apply-4',
      data: variants,
      fileName: 'varianten.gcode.3mf',
      io: quiet,
    })
    expect(spec.colourVariants).toBe(true)

    const proposed = printdata.proposedValues(spec)
    expect(proposed.material).toBe('PLA, PETG')
    expect(proposed.colours).toEqual(['Grau', 'Weiß'])

    const updated = await printdata.applyPrintData({
      listingId: 'mw-apply-4',
      fileSha256: spec.fileSha256,
      ...proposed,
      io: quiet,
    })
    expect(updated.copy.ebay.aspects['Material']).toEqual(['PLA', 'PETG'])
    expect(updated.copy.ebay.aspects['Farbe']).toEqual(['Grau', 'Weiß'])
    expect(updated.product.colour).toBe('Grau, Weiß')
  })

  it('refuses to apply values from a version the listing does not carry', async () => {
    db.upsert(record('mw-apply-5'))
    await expect(
      printdata.applyPrintData({
        listingId: 'mw-apply-5',
        fileSha256: 'deadbeef',
        lengthMm: 1,
        widthMm: 1,
        heightMm: 1,
        weightGrams: 1,
        material: 'PLA',
        colours: [],
        io: quiet,
      }),
    ).rejects.toThrow(/liegt nicht am Inserat/)
  })
})
