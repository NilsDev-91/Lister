import { createHash } from 'node:crypto'
import { unzipSync, Unzip, UnzipInflate } from 'fflate'
import { parse as parseXml } from 'node-html-parser'
import { z } from 'zod'
import { UserError } from '../util/log.js'

/**
 * Reads a sliced Bambu Studio / OrcaSlicer plate export (`.gcode.3mf`) into a
 * PhysicalSpec: measured weight, print time, filament and dimensions of the
 * user's OWN sliced print — not estimates derived from a model page.
 *
 * Everything here was verified against two real exports on 2026-08-19
 * (fixtures in `__fixtures__/`, trimmed from those files). The findings that
 * shaped this module, because they contradict the obvious design:
 *
 *  - A sliced export carries NO geometry. `3D/3dmodel.model` has an empty
 *    `<resources>` and `<build/>`; there is no `3D/Objects/`. A mesh bounding
 *    box is not computable from this input class, so there is no mesh parser
 *    here — deliberately. Only `.gcode.3mf` is accepted.
 *  - Dimensions come from two other places, and they are measurements of the
 *    actual print: `Metadata/plate_N.json` (`bbox_all`, the full X/Y
 *    projection in bed millimetres — semantics confirmed by the user against
 *    Bambu Studio's scale display) and the G-code header's `max_z_height`
 *    (the real printed height; matched the user's two variants to 0.1 mm).
 *  - `slice_info.config` matches the researched shape, plus traps: its
 *    `first_layer_time` uses a decimal COMMA while `weight` uses a dot (we
 *    read neither of the comma fields), and `prediction` is the TOTAL
 *    estimated time (Bambu's own display), not the shorter
 *    "model printing time" from the G-code header — both are captured.
 *  - The root model file, while empty of geometry, carries the source
 *    platform's provenance (Designer, License, DesignModelId, Title). That is
 *    recorded verbatim: it lets later steps cross-check an upload against the
 *    listing's source model.
 *
 * Plate policy (the user's rule): one plate per listing. Several plates are
 * accepted only when they are colour variants — the same part on every plate
 * with only the filament changed. Assemblies spread over multiple plates stay
 * manual; combining their dimensions automatically would be guesswork.
 */

export const PARSER_VERSION = '3mf-parser 1.0.0'

/** How far two colour-variant plates may drift and still count as the same part. */
const VARIANT_LENGTH_TOLERANCE = 0.03 // used_m, relative
const VARIANT_HEIGHT_TOLERANCE_MM = 1.0

const FilamentUseSchema = z.object({
  id: z.string(),
  /** e.g. "PLA", "PETG" — feeds the Material aspect. */
  type: z.string(),
  colorHex: z.string(),
  usedG: z.number().nonnegative(),
  usedM: z.number().nonnegative(),
})
export type FilamentUse = z.infer<typeof FilamentUseSchema>

const PlateSpecSchema = z.object({
  index: z.number().int().positive(),
  /** From slice_info `weight` — grams, as Bambu displays it. */
  weightG: z.number().positive(),
  /** From slice_info `prediction` — total estimated seconds (Bambu's display). */
  printTimeSec: z.number().int().nonnegative(),
  /** From the G-code header's "model printing time", when readable. */
  modelPrintTimeSec: z.number().int().nonnegative().nullable(),
  /** From the G-code header, when readable. */
  totalLayers: z.number().int().positive().nullable(),
  /** Real printed height from the G-code header's max_z_height. */
  maxZMm: z.number().positive().nullable(),
  /** Full X/Y projection from plate_N.json bbox_all, bed millimetres. */
  bboxWidthMm: z.number().positive().nullable(),
  bboxDepthMm: z.number().positive().nullable(),
  filaments: z.array(FilamentUseSchema),
  objectNames: z.array(z.string()),
})
export type PlateSpec = z.infer<typeof PlateSpecSchema>

export const PhysicalSpecSchema = z.object({
  /**
   * Dimensions of the printed part. Present because the plate policy
   * guarantees all accepted plates share them: a single plate, or colour
   * variants of the same part.
   */
  widthMm: z.number().positive().nullable(),
  depthMm: z.number().positive().nullable(),
  heightMm: z.number().positive().nullable(),

  plates: z.array(PlateSpecSchema).min(1),
  /** True when several plates carry the same part in different filament. */
  colourVariants: z.boolean(),

  dimensionSource: z.enum(['PLATE_JSON_GCODE', 'MANUAL']),
  weightSource: z.enum(['SLICE_INFO', 'MANUAL']),
  /** Raw `<model unit>` value, for the audit trail. Sliced exports say "millimeter". */
  unitDeclared: z.string(),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),

  /**
   * Provenance the export itself carries — the slicer embeds the source
   * platform's metadata. Verbatim, so later steps can cross-check the upload
   * against the listing's source model and licence.
   */
  provenance: z.object({
    title: z.string().nullable(),
    designer: z.string().nullable(),
    licenseRaw: z.string().nullable(),
    designModelId: z.string().nullable(),
    slicerVersion: z.string().nullable(),
  }),

  /** Designer media shipped inside the archive (Auxiliaries/) — names only here. */
  auxiliaryPictures: z.array(z.string()),

  parserVersion: z.string(),
  fileSha256: z.string(),
})
export type PhysicalSpec = z.infer<typeof PhysicalSpecSchema>

// ---------------------------------------------------------------------------
// Archive reading
// ---------------------------------------------------------------------------

const NOT_SLICED_HINT =
  'Bitte die geslicte Druckplatte exportieren (Bambu Studio: Datei → Exportieren → geslicte Datei, ergibt .gcode.3mf), nicht das Rohmodell.'

interface ArchiveContents {
  /** Decompressed small metadata files, keyed by entry name. */
  files: Map<string, Uint8Array>
  /** Every entry name in the archive, decompressed or not. */
  entryNames: string[]
  /** First bytes of each plate G-code, keyed by entry name. */
  gcodeHeads: Map<string, string>
}

/** How much of each G-code entry to keep — the header block sits well inside. */
const GCODE_HEAD_BYTES = 8192

/**
 * Two passes over the archive. The metadata files are tiny and read whole;
 * the G-code bodies are the bulk (many megabytes per plate) and only their
 * first bytes carry the header block, so they run through a streaming pass
 * that keeps the head and discards the rest without buffering the body.
 */
function readArchive(buffer: Uint8Array): ArchiveContents {
  const entryNames: string[] = []
  const wanted = (name: string): boolean =>
    name === '[Content_Types].xml' ||
    name === '3D/3dmodel.model' ||
    (name.startsWith('Metadata/') && (name.endsWith('.config') || name.endsWith('.json')))

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buffer, {
      filter: (file) => {
        entryNames.push(file.name)
        return wanted(file.name)
      },
    })
  } catch {
    throw new UserError('Die Datei ist kein lesbares 3MF-Archiv (ZIP beschädigt oder kein ZIP).', NOT_SLICED_HINT)
  }

  const gcodeNames = new Set(entryNames.filter((n) => /^Metadata\/plate_\d+\.gcode$/.test(n)))
  const gcodeHeads = new Map<string, string>()

  if (gcodeNames.size) {
    let remaining = gcodeNames.size
    const unzip = new Unzip((stream) => {
      if (!gcodeNames.has(stream.name)) return
      const chunks: Uint8Array[] = []
      let collected = 0
      let done = false
      stream.ondata = (err, chunk, final) => {
        if (err || done) return
        if (chunk) {
          chunks.push(chunk)
          collected += chunk.length
        }
        if (collected >= GCODE_HEAD_BYTES || final) {
          done = true
          remaining--
          const head = new Uint8Array(Math.min(collected, GCODE_HEAD_BYTES))
          let offset = 0
          for (const c of chunks) {
            if (offset >= head.length) break
            head.set(c.subarray(0, Math.min(c.length, head.length - offset)), offset)
            offset += c.length
          }
          gcodeHeads.set(stream.name, new TextDecoder().decode(head))
        }
      }
      stream.start()
    })
    unzip.register(UnzipInflate)
    // Feed in slices so the loop can stop as soon as every head is collected,
    // instead of inflating a hundred megabytes of toolpaths for nothing.
    const CHUNK = 512 * 1024
    for (let at = 0; at < buffer.length && remaining > 0; at += CHUNK) {
      const end = Math.min(at + CHUNK, buffer.length)
      unzip.push(buffer.subarray(at, end), end === buffer.length)
    }
  }

  return {
    files: new Map(Object.entries(files)),
    entryNames,
    gcodeHeads,
  }
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

const text = (bytes: Uint8Array | undefined): string | null => (bytes ? new TextDecoder().decode(bytes) : null)

/** "2h 56m 6s", "56m 6s" or "45s" → seconds. */
export function parseGcodeDuration(raw: string): number | null {
  const m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/.exec(raw.trim())
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

interface GcodeHeader {
  maxZMm: number | null
  modelPrintTimeSec: number | null
  totalLayers: number | null
}

function parseGcodeHeader(head: string | undefined): GcodeHeader {
  if (!head) return { maxZMm: null, modelPrintTimeSec: null, totalLayers: null }
  const grab = (re: RegExp): string | null => re.exec(head)?.[1]?.trim() ?? null

  const maxZ = grab(/;\s*max_z_height:\s*([\d.]+)/)
  const modelTime = grab(/;\s*model printing time:\s*([^;\r\n]+)/)
  const layers = grab(/;\s*total layer number:\s*(\d+)/)

  return {
    maxZMm: maxZ ? Number(maxZ) : null,
    modelPrintTimeSec: modelTime ? parseGcodeDuration(modelTime) : null,
    totalLayers: layers ? Number(layers) : null,
  }
}

interface PlateJson {
  widthMm: number | null
  depthMm: number | null
}

function parsePlateJson(raw: string | null): PlateJson {
  if (!raw) return { widthMm: null, depthMm: null }
  try {
    const parsed = JSON.parse(raw) as { bbox_all?: unknown }
    const bbox = parsed.bbox_all
    if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((v) => typeof v === 'number')) {
      const [xmin, ymin, xmax, ymax] = bbox as [number, number, number, number]
      const width = xmax - xmin
      const depth = ymax - ymin
      if (width > 0 && depth > 0) return { widthMm: width, depthMm: depth }
    }
  } catch {
    // Fall through — a bbox we cannot read degrades to null, never to a guess.
  }
  return { widthMm: null, depthMm: null }
}

/** Round to two decimals — these are millimetre measurements, not floats to ship raw. */
const mm = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100)

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export function parse3mf(buffer: Uint8Array): PhysicalSpec {
  const fileSha256 = createHash('sha256').update(buffer).digest('hex')
  const archive = readArchive(buffer)

  const sliceInfoRaw = text(archive.files.get('Metadata/slice_info.config'))
  if (!sliceInfoRaw) {
    throw new UserError('Dieses 3MF enthält keine Slice-Daten (Metadata/slice_info.config fehlt).', NOT_SLICED_HINT)
  }

  // node-html-parser lowercases tag names (documented quirk) — query lowercase.
  const sliceInfo = parseXml(sliceInfoRaw)
  const plateNodes = sliceInfo.querySelectorAll('plate')
  if (!plateNodes.length) {
    throw new UserError('slice_info.config enthält keine Druckplatte.', NOT_SLICED_HINT)
  }

  // model_settings maps each plate to its files; fall back to the naming
  // convention the real exports use when the mapping is absent.
  const modelSettings = text(archive.files.get('Metadata/model_settings.config'))
  const settingsPlates = modelSettings ? parseXml(modelSettings).querySelectorAll('plate') : []
  const fileFor = (index: number, key: 'gcode_file' | 'pattern_bbox_file', fallback: string): string => {
    for (const p of settingsPlates) {
      const id = p.querySelector('metadata[key="plater_id"]')?.getAttribute('value')
      if (id === String(index)) {
        const value = p.querySelector(`metadata[key="${key}"]`)?.getAttribute('value')
        if (value) return value
      }
    }
    return fallback
  }

  const plates: PlateSpec[] = plateNodes.map((node) => {
    const meta = (key: string): string | null =>
      node.querySelector(`metadata[key="${key}"]`)?.getAttribute('value') ?? null

    const index = Number(meta('index') ?? NaN)
    const weightG = Number(meta('weight') ?? NaN)
    const prediction = Number(meta('prediction') ?? NaN)
    if (!Number.isFinite(index) || !Number.isFinite(weightG) || !Number.isFinite(prediction)) {
      throw new UserError(
        `Druckplatte ohne index/weight/prediction in slice_info.config — das Format weicht vom bekannten Bambu-Export ab.`,
        'Fixture gegen einen frischen Export abgleichen; der Parser rät nicht.',
      )
    }

    const filaments: FilamentUse[] = node.querySelectorAll('filament').map((f) => ({
      id: f.getAttribute('id') ?? '',
      type: f.getAttribute('type') ?? '',
      colorHex: f.getAttribute('color') ?? '',
      usedG: Number(f.getAttribute('used_g') ?? 0),
      usedM: Number(f.getAttribute('used_m') ?? 0),
    }))

    // skipped="true" objects were excluded from the print — they are not part
    // of what the buyer receives and never counted.
    const objectNames = node
      .querySelectorAll('object')
      .filter((o) => o.getAttribute('skipped') !== 'true')
      .map((o) => o.getAttribute('name') ?? '')
      .filter(Boolean)

    const gcodeHead = archive.gcodeHeads.get(fileFor(index, 'gcode_file', `Metadata/plate_${index}.gcode`))
    const header = parseGcodeHeader(gcodeHead)
    const bboxRaw = text(archive.files.get(fileFor(index, 'pattern_bbox_file', `Metadata/plate_${index}.json`)))
    const bbox = parsePlateJson(bboxRaw)

    return {
      index,
      weightG,
      printTimeSec: prediction,
      modelPrintTimeSec: header.modelPrintTimeSec,
      totalLayers: header.totalLayers,
      maxZMm: mm(header.maxZMm),
      bboxWidthMm: mm(bbox.widthMm),
      bboxDepthMm: mm(bbox.depthMm),
      filaments,
      objectNames,
    }
  })

  // ---- Plate policy: one plate, or colour variants of the same part -------
  let colourVariants = false
  if (plates.length > 1) {
    const first = plates[0]!
    const sameAsFirst = (p: PlateSpec): boolean => {
      const namesMatch = JSON.stringify([...p.objectNames].sort()) === JSON.stringify([...first.objectNames].sort())
      const lengthOf = (x: PlateSpec): number => x.filaments.reduce((sum, f) => sum + f.usedM, 0)
      const l0 = lengthOf(first)
      const lengthMatch = l0 > 0 && Math.abs(lengthOf(p) - l0) / l0 <= VARIANT_LENGTH_TOLERANCE
      const heightMatch =
        p.maxZMm === null || first.maxZMm === null || Math.abs(p.maxZMm - first.maxZMm) <= VARIANT_HEIGHT_TOLERANCE_MM
      return namesMatch && lengthMatch && heightMatch
    }
    if (plates.every(sameAsFirst)) {
      colourVariants = true
    } else {
      throw new UserError(
        `Dieses 3MF enthält ${plates.length} unterschiedliche Druckplatten.`,
        'Ein Inserat bekommt eine Platte: bitte die passende Platte einzeln exportieren ' +
          '(Bambu Studio: Rechtsklick auf die Platte → geslicte Datei exportieren). ' +
          'Mehrere Platten nimmt der Import nur als Farbvarianten desselben Bauteils an; ' +
          'Baugruppen über mehrere Platten trägst du weiterhin manuell ein.',
      )
    }
  }

  // ---- Dimensions — shared across accepted plates by construction ---------
  const dims = plates[0]!
  const widthMm = dims.bboxWidthMm
  const depthMm = dims.bboxDepthMm
  const heightMm = dims.maxZMm

  let needsReview = false
  let reviewReason: string | null = null
  if (widthMm === null || depthMm === null || heightMm === null) {
    needsReview = true
    reviewReason = 'DIMENSIONS_INCOMPLETE'
  } else if (heightMm <= widthMm && heightMm <= depthMm) {
    // The bed axes carry no semantics. A part printed lying down has Z as its
    // thickness, while the listing's "Höhe" means the standing height — that
    // assignment is the seller's call, not a guess this code makes.
    needsReview = true
    reviewReason = 'ORIENTATION_AMBIGUOUS'
  }

  // ---- Provenance from the geometry-less root model ------------------------
  const rootModel = text(archive.files.get('3D/3dmodel.model'))
  const root = rootModel ? parseXml(rootModel) : null
  const rootMeta = (name: string): string | null => {
    const node = root?.querySelector(`metadata[name="${name}"]`)
    const value = node?.text.trim()
    return value ? value : null
  }
  const unitDeclared = root?.querySelector('model')?.getAttribute('unit') ?? 'millimeter'

  const spec: PhysicalSpec = {
    widthMm,
    depthMm,
    heightMm,
    plates,
    colourVariants,
    dimensionSource: 'PLATE_JSON_GCODE',
    weightSource: 'SLICE_INFO',
    unitDeclared,
    needsReview,
    reviewReason,
    provenance: {
      title: rootMeta('Title'),
      designer: rootMeta('Designer'),
      licenseRaw: rootMeta('License'),
      designModelId: rootMeta('DesignModelId'),
      slicerVersion: rootMeta('Application'),
    },
    auxiliaryPictures: archive.entryNames.filter((n) => /^Auxiliaries\/Model Pictures\//.test(n)),
    parserVersion: PARSER_VERSION,
    fileSha256,
  }

  const validated = PhysicalSpecSchema.safeParse(spec)
  if (!validated.success) {
    throw new UserError(
      `Der gelesene 3MF-Inhalt hält das PhysicalSpec-Schema nicht ein:\n${validated.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return validated.data
}
