import { randomUUID } from 'node:crypto'
import { fetchModel, readModelFromFile } from '../sources/makerworld/fetcher.js'
import { gate } from '../sources/makerworld/license.js'
import { composeListingCopy } from '../ai/composer.js'
import { stageImages, looksLikeSourceDownload } from '../images.js'
import { ListingRecordSchema, ProductInputSchema, type ListingRecord, type ProductInput } from '../types.js'
import { upsert, findBySourceUrl } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'

export interface CreateOptions {
  url: string
  /** A page saved from the browser. More reliable than fetching, which Cloudflare blocks. */
  fromHtml?: string | undefined
  price: number
  quantity: number
  material: string
  colour?: string | undefined
  dimensions?: string | undefined
  weight?: number | undefined
  processingDays: number
  notes: string
  /** Seller's own SKU. Undefined falls back to the local id at publish time. */
  sku?: string | undefined
  image: string[]
  imageUrl: string[]
  commercialRights: boolean
  /** You designed this model yourself. The only thing that opens the Etsy channel. */
  ownDesign: boolean
  /**
   * The seller's explicit acceptance of the Etsy own-design platform risk for
   * this listing. Distinct from `commercialRights`: that one says "the
   * designer permits the sale", this one says "I carry Etsy's authorship-rule
   * risk myself". Neither implies the other.
   */
  acceptEtsyDesignRisk: boolean
  /** Add a designer credit line. Not an eBay requirement — a licence one. */
  credit: boolean
  yes: boolean
  /** How to prompt and report progress. Defaults to the terminal. */
  io?: Io
}

function parseDimensions(input: string | undefined): ProductInput['dimensionsMm'] {
  if (!input) return null
  const parts = input.split(/[x×*]/i).map((p) => Number(p.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new UserError(
      `Could not read dimensions "${input}".`,
      'Use length x width x height in millimetres, e.g. --dimensions 220x60x30',
    )
  }
  return { length: parts[0]!, width: parts[1]!, height: parts[2]! }
}

/**
 * Builds a draft listing from a MakerWorld URL: read the page, apply the licence
 * gate, generate copy, stage images, and persist. Nothing is sent to a
 * marketplace here — that is `lister publish`, which is where money changes hands.
 */
export async function createCommand(options: CreateOptions): Promise<ListingRecord> {
  const io = options.io ?? terminalIo
  const model = options.fromHtml
    ? await readModelFromFile(options.fromHtml, options.url)
    : await fetchModel(options.url)

  const existing = findBySourceUrl(model.sourceUrl)
  if (existing) {
    io.warn(`You already have a listing for this model: ${existing.id} (created ${existing.createdAt.slice(0, 10)}).`)
    if (!options.yes && !(await io.confirm('Create another one anyway?'))) {
      throw new UserError('Cancelled.')
    }
  }

  // ---- Licence gate -------------------------------------------------------
  const decision = gate(model.license, options.commercialRights)
  io.step('Licence check')
  io.info(decision.reason)

  // A licence that forbids the sale is stated plainly here and enforced at
  // publish — not here.
  //
  // The distinction is the point. A draft is local, costs nothing and puts
  // nothing on a marketplace; the risk lives entirely at the moment of going
  // live, and `requireSaleRights` guards that moment in both publish paths and
  // in preflight, past `--skip-preflight`. Refusing to *draft* protected
  // nothing and stopped the seller from working: the licence question is often
  // settled later, by buying the creator's commercial membership, and the
  // answer does not change a word of the copy that has to be written either way.
  if (model.license.commercialUse === 'no' && !decision.overridden) {
    io.warn(
      `This licence ("${model.license.raw}") does not permit selling prints, so this draft cannot be published as it stands.`,
    )
    io.detail(
      'The draft is still worth having — the copy is the same either way. Before going live you need the ' +
        "creator's commercial licence, and then you mark this listing as covered (the rights switch on the " +
        'listing page, or --i-have-commercial-rights when creating).',
    )
  }

  if (!decision.mayReuseImages) {
    io.warn(
      decision.overridden
        ? "Your rights cover the model. The designer's own photos are separate content and stay theirs."
        : "The designer's images and description are off-limits under this licence.",
    )
    // Said loudly, but not fatal. Publishing without photos is already refused
    // in four places — both preflight blockers and both publish paths — so
    // stopping here as well protected nothing and cost the one workflow that
    // needs it most: the web editor has no image field on the create form
    // (photos are added afterwards, where they can be previewed and reordered),
    // so this throw made every listing under a non-permissive licence
    // impossible to create in the browser at all. A draft without photos is a
    // legitimate half-finished state; a *listing* without them is not, and that
    // is the one the gates guard.
    if (!options.image.length && !options.imageUrl.length) {
      io.warn(
        'No photos yet — this draft cannot be published until you add your own. ' +
          (decision.overridden
            ? 'Photograph the item you printed, then add the files in the editor (Etsy) and upload them to eBay from there.'
            : 'Add them in the editor, or pass --image / --image-url on the command line.'),
      )
    }
  }

  if (decision.needsConfirmation && !options.yes) {
      if (!(await io.confirm('Continue on that basis?'))) throw new UserError('Cancelled.')
  }

  // The Etsy risk claim gets its own confirmation, like the rights override:
  // it is a recorded decision to carry a platform risk, not a checkbox.
  if (options.acceptEtsyDesignRisk && !options.ownDesign) {
    io.warn(
      `Etsy's Creativity Standards require the seller's own design, and this model is by ${model.designer}. ` +
        'Accepting means Etsy can remove the listing with fees retained, and repeat findings reach the shop. ' +
        'Your acceptance is stored on the listing with time and source URL.',
    )
    if (!options.yes && !(await io.confirm('Accept the Etsy own-design risk for this listing?'))) {
      throw new UserError('Cancelled.', 'Re-run without --i-accept-etsy-design-risk to keep Etsy closed for it.')
    }
  }

  // ---- Seller facts -------------------------------------------------------
  const product = ProductInputSchema.parse({
    priceEur: options.price,
    quantity: options.quantity,
    material: options.material,
    colour: options.colour ?? null,
    dimensionsMm: parseDimensions(options.dimensions),
    weightGrams: options.weight ?? null,
    processingDays: options.processingDays,
    notes: options.notes,
  } satisfies Record<string, unknown>)

  // ---- Copy ---------------------------------------------------------------
  io.step('Writing listing copy with Claude…')
  const copy = await composeListingCopy({ model, product, gate: decision, credit: options.credit })
  io.ok('Copy generated and validated against both marketplaces\' rules.')
  io.info(`eBay  (${copy.ebay.title.length}/80):  ${copy.ebay.title}`)
  io.info(`Etsy  (${copy.etsy.title.length}/140): ${copy.etsy.title}`)
  io.detail(`Etsy tags: ${copy.etsy.tags.join(', ')}`)

  // ---- Images -------------------------------------------------------------
  const id = `mw-${model.externalId}-${randomUUID().slice(0, 6)}`
  io.step('Staging images…')
  const images = await stageImages({
    listingId: id,
    sourceUrls: model.images.map((i) => i.url),
    mayReuseSource: decision.mayReuseImages,
    localPaths: options.image,
    hostedUrls: options.imageUrl,
  })

  // Etsy counts only the seller's own files; staged source downloads serve eBay.
  const ownPaths = images.paths.filter((p) => !looksLikeSourceDownload(p))
  if (!ownPaths.length) {
    io.warn(
      images.paths.length
        ? 'Only source-platform downloads are staged — those never go to Etsy. Add your own photos before an Etsy publish.'
        : 'No local image files — Etsy publishing will fail without at least one of your own photos.',
    )
  }
  if (!images.urls.length) io.warn('No HTTPS image URLs — eBay publishing will fail without at least one.')

  // ---- Persist ------------------------------------------------------------
  const now = new Date().toISOString()
  // Built through the schema rather than as a typed literal, so the fields a
  // fresh draft simply does not have yet — research, a pending rewrite, title
  // options — take their declared defaults. A literal has to name every one of
  // them, which means every new optional field breaks this line.
  const record = ListingRecordSchema.parse({
    id,
    sourceUrl: model.sourceUrl,
    source: model,
    product,
    copy,
    imagePaths: images.paths,
    imageUrls: images.urls,
    sku: options.sku?.trim() || null,
    licenseOverridden: decision.overridden,
    ownDesign: options.ownDesign,
    etsyDesignRiskAccepted:
      options.acceptEtsyDesignRisk && !options.ownDesign ? { at: now, sourceUrl: model.sourceUrl } : null,
    // Etsy is only a channel for the seller's own designs — or for a listing
    // whose seller explicitly accepted the platform risk. Since 10.06.2025 the
    // Creativity Standards require original authorship, which a licence cannot
    // supply — so without either claim a third-party model does not get an
    // Etsy row at all rather than getting one that can never be published.
    marketplaces: [
      { marketplace: 'ebay', state: 'draft', remoteId: null, liveId: null, url: null, error: null, updatedAt: now },
      ...(options.ownDesign || options.acceptEtsyDesignRisk
        ? [{ marketplace: 'etsy', state: 'draft', remoteId: null, liveId: null, url: null, error: null, updatedAt: now }]
        : []),
    ],
    createdAt: now,
    updatedAt: now,
  })

  upsert(record)

  io.ok(`Draft saved as ${id}`)
  io.info(`Review it with:  lister show ${id}`)
  io.info(`Publish it with: lister publish ${id} --marketplace etsy`)

  return record
}
