import { existsSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse3mf, PARSER_VERSION, type PhysicalSpec } from '../print/threemf.js'
import { germanColourName } from '../print/colours.js'
import { uploadDirFor } from '../util/paths.js'
import { get, upsert } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import type { ListingRecord } from '../types.js'

/**
 * Print data from the seller's own sliced 3MF: attach parses and records the
 * measured values, apply writes them into the listing.
 *
 * Attach and apply are deliberately two steps. The parse result is evidence —
 * weight, time, filament, dimensions of the plate that was actually sliced —
 * and evidence gets reviewed before it becomes listing content: the UI shows
 * every value editable, and an edited value is applied as MANUAL. A re-upload
 * or re-parse only ever refreshes the evidence; the applied values live in
 * `product`/`copy` and are never touched by it, which is what lets a manual
 * override survive any later parse.
 */

export interface AttachResult {
  listing: ListingRecord
  spec: PhysicalSpec
  /** True when the same bytes were already attached — refreshed, not duplicated. */
  refreshed: boolean
}

export async function attachPrintData(
  options: { listingId: string; data: Uint8Array; fileName: string; io?: Io },
): Promise<AttachResult> {
  const io = options.io ?? terminalIo
  const listing = get(options.listingId)
  if (!listing) throw new UserError(`No listing with id "${options.listingId}"`)

  io.step(`Lese ${options.fileName} (${(options.data.length / 1e6).toFixed(1)} MB)…`)
  const spec = parse3mf(options.data)

  // Content-addressed: the sha both names the file on disk and keys the audit
  // trail. Same bytes → same path, so history never collides with itself.
  const filePath = join(uploadDirFor(listing.id), `${spec.fileSha256}.gcode.3mf`)
  if (!existsSync(filePath)) await writeFile(filePath, options.data)

  const plate = spec.plates[0]!
  io.ok(
    `Platte ${plate.index}: ${plate.weightG} g, ${formatDuration(plate.printTimeSec)}, ` +
      `${spec.widthMm ?? '?'} × ${spec.depthMm ?? '?'} × ${spec.heightMm ?? '?'} mm`,
  )
  for (const p of spec.plates) {
    io.detail(
      `Platte ${p.index}: ${p.filaments.map((f) => `${f.type} ${f.colorHex} (${f.usedG} g)`).join(', ') || 'kein Filament?'}`,
    )
  }
  if (spec.colourVariants) io.info(`${spec.plates.length} Platten — dasselbe Bauteil in verschiedenen Filamenten.`)
  if (spec.needsReview) {
    io.warn(
      spec.reviewReason === 'ORIENTATION_AMBIGUOUS'
        ? 'Das Teil liegt flach auf der Platte — ordne Höhe/Breite/Tiefe vor der Übernahme selbst zu.'
        : 'Maße unvollständig — bitte vor der Übernahme prüfen.',
    )
  }

  // The export names its source. A different designer than the listing's is
  // worth a loud line — the wrong plate on the wrong listing is exactly the
  // mistake this feature exists to prevent.
  if (spec.provenance.designer && spec.provenance.designer !== listing.source.designer) {
    io.warn(
      `Die 3MF nennt als Designer "${spec.provenance.designer}", das Inserat "${listing.source.designer}" — sicher die richtige Datei?`,
    )
  }

  // Re-read inside the mutation window, then append — or refresh in place
  // when the identical file is uploaded again (a re-parse, not a new version).
  const current = get(listing.id) ?? listing
  const entry = {
    fileSha256: spec.fileSha256,
    fileName: options.fileName,
    filePath,
    uploadedAt: new Date().toISOString(),
    spec,
  }
  const existing = current.printUploads.findIndex((u) => u.fileSha256 === spec.fileSha256)
  const refreshed = existing !== -1
  const printUploads = refreshed
    ? current.printUploads.map((u, i) => (i === existing ? { ...entry, uploadedAt: u.uploadedAt } : u))
    : [...current.printUploads, entry]
  const updated: ListingRecord = { ...current, printUploads }
  upsert(updated)

  io.ok(refreshed ? 'Druckdaten aktualisiert (gleiche Datei, neu geparst).' : 'Druckdaten am Inserat gespeichert.')
  return { listing: updated, spec, refreshed }
}

/** Seconds → "2 h 33 min" for progress lines and the card. */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h ? `${h} h ${m} min` : `${m} min`
}

/**
 * The values the seller confirms — prefilled from the spec, every one
 * editable. What arrives here is what gets written; each field whose value
 * differs from the parsed one is recorded as MANUAL.
 */
export interface ApplyPrintDataOptions {
  listingId: string
  /** Which upload the values came from; must exist on the listing. */
  fileSha256: string
  lengthMm: number | null
  widthMm: number | null
  heightMm: number | null
  weightGrams: number | null
  /** e.g. "PLA" or "PLA, PETG" — multiple types stay visible, not averaged. */
  material: string | null
  /** Colour names for the aspect, e.g. ["Grau", "Weiß"]. */
  colours: string[]
  io?: Io
}

/** What the parser itself would have proposed, for MANUAL detection and the UI. */
export function proposedValues(spec: PhysicalSpec): {
  lengthMm: number | null
  widthMm: number | null
  heightMm: number | null
  weightGrams: number | null
  material: string | null
  colours: string[]
} {
  // The bed axes carry no length/width semantics, so the proposal is the
  // stated convention (Länge = larger footprint side) — visible and editable,
  // never silently decided. ORIENTATION_AMBIGUOUS flags the cases where even
  // the height needs the seller's judgement.
  const footprint = [spec.widthMm, spec.depthMm].filter((v): v is number => v !== null).sort((a, b) => b - a)
  const types = [...new Set(spec.plates.flatMap((p) => p.filaments.map((f) => f.type)).filter(Boolean))]
  const colours = [
    ...new Set(
      spec.plates
        .flatMap((p) => p.filaments.map((f) => germanColourName(f.colorHex) ?? f.colorHex))
        .filter(Boolean),
    ),
  ]
  return {
    lengthMm: footprint[0] ?? null,
    widthMm: footprint[1] ?? footprint[0] ?? null,
    heightMm: spec.heightMm,
    // Colour variants share one part: every plate weighs the same, so the
    // first plate speaks for all. (Different parts never get this far.)
    weightGrams: spec.plates[0] ? Math.round(spec.plates[0].weightG) : null,
    material: types.length ? types.join(', ') : null,
    colours,
  }
}

export async function applyPrintData(options: ApplyPrintDataOptions): Promise<ListingRecord> {
  const io = options.io ?? terminalIo
  const listing = get(options.listingId)
  if (!listing) throw new UserError(`No listing with id "${options.listingId}"`)

  const upload = listing.printUploads.find((u) => u.fileSha256 === options.fileSha256)
  if (!upload) {
    throw new UserError(
      'Diese Druckdaten-Version liegt nicht am Inserat.',
      'Erst hochladen, dann übernehmen — die Herkunft jeder Zahl muss nachvollziehbar bleiben.',
    )
  }

  const proposed = proposedValues(upload.spec)
  const now = new Date().toISOString()
  const provenance = (matches: boolean): ListingRecord['printApplied'][string] => ({
    source: matches ? '3MF' : 'MANUAL',
    fileSha256: upload.fileSha256,
    parserVersion: upload.spec.parserVersion,
    appliedAt: now,
  })

  const printApplied = { ...listing.printApplied }
  const product = { ...listing.product }
  const aspects = { ...listing.copy.ebay.aspects }

  if (options.weightGrams !== null) {
    product.weightGrams = options.weightGrams
    printApplied['weightGrams'] = provenance(options.weightGrams === proposed.weightGrams)
  }
  if (options.lengthMm !== null && options.widthMm !== null && options.heightMm !== null) {
    product.dimensionsMm = { length: options.lengthMm, width: options.widthMm, height: options.heightMm }
    const matches =
      options.lengthMm === proposed.lengthMm &&
      options.widthMm === proposed.widthMm &&
      options.heightMm === proposed.heightMm
    printApplied['dimensionsMm'] = provenance(matches)
  }
  if (options.material !== null && options.material.trim()) {
    product.material = options.material.trim()
    printApplied['material'] = provenance(options.material.trim() === proposed.material)
    // One aspect value per filament type: "PLA, PETG" as a single string would
    // match no category value list, two separate values can.
    aspects['Material'] = options.material.split(',').map((t) => t.trim()).filter(Boolean)
  }
  const colours = options.colours.map((c) => c.trim()).filter(Boolean)
  if (colours.length) {
    product.colour = colours.join(', ')
    printApplied['colour'] = provenance(JSON.stringify(colours) === JSON.stringify(proposed.colours))
    aspects['Farbe'] = colours
  }

  const updated: ListingRecord = {
    ...listing,
    product,
    printApplied,
    copy: { ...listing.copy, ebay: { ...listing.copy.ebay, aspects } },
  }
  upsert(updated)

  const manual = Object.entries(printApplied)
    .filter(([, p]) => p.appliedAt === now && p.source === 'MANUAL')
    .map(([field]) => field)
  io.ok(
    `Druckdaten übernommen (${upload.fileName}, ${upload.fileSha256.slice(0, 12)}…, ${upload.spec.parserVersion}).` +
      (manual.length ? ` Manuell angepasst: ${manual.join(', ')}.` : ''),
  )
  io.detail('Gewicht und Maße fließen über die Merkmals-Engine in der Schreibweise der eBay-Kategorie ein.')
  return updated
}

/** CLI entry: attach a file, show the values, optionally apply them as parsed. */
export async function printDataCommand(options: {
  listingId: string
  file: string
  apply: boolean
  io?: Io
}): Promise<void> {
  const io = options.io ?? terminalIo
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(options.file))
  } catch (error) {
    throw new UserError(`Could not read ${options.file}: ${(error as Error).message}`)
  }
  const { spec } = await attachPrintData({
    listingId: options.listingId,
    data,
    fileName: options.file.replace(/^.*[\\/]/, ''),
    io,
  })

  if (options.apply) {
    const proposed = proposedValues(spec)
    await applyPrintData({ listingId: options.listingId, fileSha256: spec.fileSha256, ...proposed, io })
  } else {
    io.info('Übernehmen: im Web-Editor prüfen, oder --apply für die Werte wie geparst.')
  }
}
