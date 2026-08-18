import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFile, mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import open from 'open'
import { log, UserError } from '../util/log.js'
import { collectingIo, type Io } from '../util/io.js'
import { listAll, get, upsert } from '../store/db.js'
import { imageDirFor } from '../util/paths.js'
import { downloadImages } from '../images.js'
import { gate } from '../makerworld/license.js'
import * as ebayAuth from '../marketplaces/ebay/auth.js'
import { EbayCopySchema, EbaySkuSchema, EtsyCopySchema, type ListingRecord, type Marketplace } from '../types.js'
import { auditContent, auditEbayAspects, Report } from '../commands/preflight.js'
import { createCommand } from '../commands/create.js'
import { publishCommand } from '../commands/publish.js'
import { keywordsCommand } from '../commands/keywords.js'
import { proposalCommand } from '../commands/proposal.js'
import { titlesCommand } from '../commands/titles.js'
import { uploadPictures } from '../marketplaces/ebay/pictures.js'
import { newSessionToken, guardMutation, tokensMatch, SECURITY_HEADERS, SESSION_COOKIE } from './security.js'
import { parseForm, type UploadedFile } from './multipart.js'
import {
  overview,
  newListingForm,
  listingDetail,
  settingsPage,
  creatingPage,
  splitListings,
  errorPage,
  page,
  esc,
} from './views.js'
import { startJob, getJob } from './jobs.js'
import { appStatus } from '../status.js'
import { parseAspects } from './aspect-text.js'
import { parseVariants } from './variant-text.js'
import { loadSettings, saveSettings, SettingsSchema } from '../settings.js'

/**
 * The local web UI.
 *
 * A second face on the same commands, not a parallel implementation: every
 * route delegates to `createCommand`, `publishCommand` or `auditContent`, so
 * the CLI and the UI cannot drift apart in what they enforce.
 */

const IMAGE_TYPES = new Set(['.jpg', '.jpeg', '.png', '.gif', '.heic'])

function send(res: ServerResponse, status: number, html: string): void {
  // Nothing here should ever be framed or sniffed. The referrer policy is a
  // deliberate choice with a trap behind it — see SECURITY_HEADERS.
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS })
  res.end(html)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to })
  res.end()
}

/** Flash messages ride in the query string; there is no session store to keep. */
function flashFrom(url: URL): { kind: string; text: string } | undefined {
  const text = url.searchParams.get('msg')
  if (!text) return undefined
  const kind = url.searchParams.get('kind') ?? 'ok'
  return { kind: ['ok', 'bad', 'warn'].includes(kind) ? kind : 'ok', text }
}

function flashUrl(path: string, kind: string, text: string): string {
  return `${path}?kind=${encodeURIComponent(kind)}&msg=${encodeURIComponent(text)}`
}

export interface ServerHandle {
  url: string
  close(): Promise<void>
}

export async function startServer(options: { port: number; openBrowser: boolean }): Promise<ServerHandle> {
  const sessionToken = newSessionToken()
  const host = `127.0.0.1:${options.port}`

  const server = createServer((req, res) => {
    void handle(req, res, host, sessionToken).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      const hint = error instanceof UserError ? error.hint : undefined
      log.error(`web: ${message}`)
      // If the response is already under way, writing a second head would throw
      // inside this very handler — the one place an exception must not escape.
      if (res.headersSent) {
        res.end()
        return
      }
      send(res, 500, errorPage(message, hint))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    // 127.0.0.1 only. Never 0.0.0.0 — this process can spend money.
    server.listen(options.port, '127.0.0.1', resolve)
  })

  const url = `http://${host}/?token=${sessionToken}`
  log.ok(`UI läuft auf http://${host}`)
  log.detail('Nur lokal erreichbar. Zum Beenden Strg+C.')

  if (options.openBrowser) {
    void open(url).catch(() => log.warn(`Browser ließ sich nicht öffnen — URL selbst aufrufen:\n  ${url}`))
  } else {
    log.info(`Öffne: ${url}`)
  }

  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  sessionToken: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${host}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // The token arrives once in the opened URL and then lives in a cookie.
  const bootstrapToken = url.searchParams.get('token')
  if (method === 'GET' && bootstrapToken && tokensMatch(bootstrapToken, sessionToken)) {
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`)
    url.searchParams.delete('token')
    redirect(res, url.pathname + (url.search || ''))
    return
  }

  if (method === 'POST') {
    const guard = guardMutation(req, host, sessionToken)
    if (!guard.ok) {
      log.warn(`web: blockierte Anfrage — ${guard.reason}`)
      send(res, 403, errorPage('Anfrage abgewiesen.', guard.reason))
      return
    }
  }

  // --- read-only routes ----------------------------------------------------
  if (method === 'GET' && path === '/') {
    send(res, 200, overview(listAll(), flashFrom(url)))
    return
  }

  if (method === 'GET' && path === '/new') {
    send(res, 200, newListingForm(undefined, loadSettings()))
    return
  }

  if (method === 'GET' && path === '/settings') {
    send(
      res,
      200,
      settingsPage({
        groups: appStatus(),
        settings: loadSettings(),
        counts: listingCounts(),
        ...(flashFrom(url) ? { flash: flashFrom(url)! } : {}),
      }),
    )
    return
  }

  // Background-job progress, shared by creation and image adoption. Two routes:
  // the page, and the state it polls.
  const progressState = /^\/progress\/([^/]+)\/state$/.exec(path)
  if (method === 'GET' && progressState) {
    const job = getJob(decodeURIComponent(progressState[1]!))
    if (!job) {
      sendJson(res, 404, { state: 'failed', lines: [], result: null, error: { message: 'Unbekannter Vorgang.' } })
      return
    }
    sendJson(res, 200, { state: job.state, lines: job.lines, result: job.result, error: job.error })
    return
  }

  const progressPage = /^\/progress\/([^/]+)$/.exec(path)
  if (method === 'GET' && progressPage) {
    const job = getJob(decodeURIComponent(progressPage[1]!))
    if (!job) {
      send(res, 404, errorPage('Dieser Vorgang ist nicht mehr bekannt.', 'Angelegte Entwürfe stehen in der Übersicht.'))
      return
    }
    // A job that finished while the browser was away still lands on the result.
    if (job.state === 'done' && job.result) {
      redirect(res, flashUrl(`/listing/${encodeURIComponent(job.result)}`, 'ok', 'Entwurf erstellt.'))
      return
    }
    send(res, 200, creatingPage(job))
    return
  }

  const detail = /^\/listing\/([^/]+)$/.exec(path)
  if (method === 'GET' && detail) {
    const listing = requireListing(decodeURIComponent(detail[1]!))
    const report = auditContent(listing, ['ebay', 'etsy'])
    await addAspectFindings(listing, report)

    // Counted per marketplace as well as together: the list is read as a whole,
    // but publishing is decided one marketplace at a time, and the aspect
    // findings belong to eBay alone.
    const ebayOnly = auditContent(listing, ['ebay'])
    await addAspectFindings(listing, ebayOnly)

    send(
      res,
      200,
      listingDetail({
        listing,
        findings: report.findings,
        passed: report.passed,
        flash: flashFrom(url),
        counts: listingCounts(),
        blockersPerMarketplace: {
          ebay: ebayOnly.blockers.length,
          etsy: auditContent(listing, ['etsy']).blockers.length,
        },
      }),
    )
    return
  }

  const imageRoute = /^\/listing\/([^/]+)\/image\/(\d+)$/.exec(path)
  if (method === 'GET' && imageRoute) {
    await serveImage(res, decodeURIComponent(imageRoute[1]!), Number(imageRoute[2]))
    return
  }

  // --- mutating routes -----------------------------------------------------
  if (method === 'POST' && path === '/new') {
    await handleCreate(req, res)
    return
  }

  if (method === 'POST' && path === '/settings') {
    await handleSettings(req, res)
    return
  }

  const post = /^\/listing\/([^/]+)(\/.*)?$/.exec(path)
  if (method === 'POST' && post) {
    const id = decodeURIComponent(post[1]!)
    const action = post[2] ?? ''
    await handleListingAction(req, res, id, action)
    return
  }

  send(res, 404, errorPage('Seite nicht gefunden.'))
}

/**
 * Folds the item-specific check into a report, when a category is known.
 *
 * This is what makes the aspect engine reach the browser at all: `auditContent`
 * is the offline half, and the required-aspect blocker used to live only in the
 * CLI-side `checkEbay`. A blocker the UI never renders stops nothing.
 *
 * Failures are swallowed on purpose — a taxonomy outage must not take out the
 * page that shows everything else about the listing.
 */
async function addAspectFindings(listing: ListingRecord, report: Report): Promise<void> {
  if (!listing.ebayCategoryId) return
  try {
    report.absorb(await auditEbayAspects(listing, listing.ebayCategoryId))
  } catch (error) {
    log.warn(`web: aspect check skipped — ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Live-versus-draft counts for the sidebar badge. */
function listingCounts(): { live: number; drafts: number } {
  const { live, drafts } = splitListings(listAll())
  return { live: live.length, drafts: drafts.length }
}

/**
 * Saves preferences.
 *
 * An unchecked checkbox is simply absent from a form post, so `defaultCredit`
 * is read as presence rather than value — treating a missing field as "keep the
 * old setting" would make the box impossible to switch off.
 */
async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { fields } = await parseForm(req)
  const current = loadSettings()

  const number = (name: string, fallback: number): number => {
    const parsed = Number(fields[name])
    return Number.isFinite(parsed) ? parsed : fallback
  }

  const candidate = {
    defaultMaterial: (fields['defaultMaterial'] ?? '').trim() || current.defaultMaterial,
    defaultQuantity: number('defaultQuantity', current.defaultQuantity),
    defaultProcessingDays: number('defaultProcessingDays', current.defaultProcessingDays),
    defaultCredit: fields['defaultCredit'] === '1',
    researchSampleSize: number('researchSampleSize', current.researchSampleSize),
    etsyBuyerCountry: (fields['etsyBuyerCountry'] ?? '').trim().toUpperCase(),
  }

  const parsed = SettingsSchema.safeParse(candidate)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ')
    redirect(res, flashUrl('/settings', 'bad', `Nicht gespeichert — ${issues}`))
    return
  }

  saveSettings(parsed.data)
  redirect(res, flashUrl('/settings', 'ok', 'Einstellungen gespeichert.'))
}

function requireListing(id: string): ListingRecord {
  const listing = get(id)
  if (!listing) throw new UserError(`Kein Inserat mit der ID "${id}".`)
  return listing
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

async function serveImage(res: ServerResponse, id: string, index: number): Promise<void> {
  const listing = requireListing(id)
  const path = listing.imagePaths[index]
  if (!path || !existsSync(path)) {
    send(res, 404, errorPage('Bild nicht gefunden.'))
    return
  }
  // Read before writeHead: a file deleted between the exists check and here
  // must surface as a clean 404. With the head already written, the outer
  // error handler's own writeHead would throw inside the catch — an unhandled
  // rejection that takes the whole server down over one missing thumbnail.
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    send(res, 404, errorPage('Bild nicht gefunden.'))
    return
  }
  const type = IMAGE_CONTENT_TYPES[extname(path).toLowerCase()] ?? 'image/jpeg'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(bytes)
}

// ---------------------------------------------------------------------------

/**
 * Starts the creation and hands back a page that watches it.
 *
 * The work is not awaited here. It takes half a minute — page parse, licence
 * gate, two sets of generated copy, image staging — and holding the response
 * open for that shows the user a blank tab with no way to tell a slow model
 * from a stalled process. The upload itself still has to be read first, so the
 * form is parsed before the job starts.
 */
async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { fields, files } = await parseForm(req)

  // The saved page arrives as an upload; createCommand wants a path.
  let fromHtml: string | undefined
  const pageFile = files.find((f) => f.field === 'page')
  if (pageFile) {
    const dir = await mkdtemp(join(tmpdir(), 'lister-page-'))
    fromHtml = join(dir, 'page.html')
    await writeFile(fromHtml, pageFile.data)
  }

  const job = startJob(async (io) => {
    const record = await createCommand({
      url: fields['url'] ?? '',
      fromHtml,
      price: Number(fields['price']),
      quantity: Number(fields['quantity'] || 1),
      material: fields['material'] ?? '',
      colour: fields['colour'] || undefined,
      dimensions: fields['dimensions'] || undefined,
      weight: fields['weight'] ? Number(fields['weight']) : undefined,
      processingDays: Number(fields['processingDays'] || 3),
      notes: fields['notes'] ?? '',
      image: [],
      imageUrl: [],
      commercialRights: fields['commercialRights'] === '1',
      credit: fields['credit'] === '1',
      ownDesign: fields['ownDesign'] === '1',
      acceptEtsyDesignRisk: fields['etsyDesignRisk'] === '1',
      // The form already said what would happen; there is nobody to prompt.
      yes: true,
      io,
    })
    return record.id
  }, {
    label: 'Inserat wird erstellt',
    hint: 'die Texte schreibt Claude, das dauert üblicherweise 20–40 Sekunden.',
  })

  redirect(res, `/progress/${encodeURIComponent(job.id)}`)
}

async function handleListingAction(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  action: string,
): Promise<void> {
  const listing = requireListing(id)
  const backTo = `/listing/${encodeURIComponent(id)}`
  const { fields, files } = await parseForm(req)

  // --- save edited copy ----------------------------------------------------
  if (action === '') {
    const ebay = EbayCopySchema.safeParse({
      ...listing.copy.ebay,
      title: fields['ebayTitle'] ?? '',
      descriptionHtml: fields['ebayDesc'] ?? '',
      aspects: parseAspects(fields['ebayAspects'] ?? ''),
    })
    const etsy = EtsyCopySchema.safeParse({
      ...listing.copy.etsy,
      title: fields['etsyTitle'] ?? '',
      description: fields['etsyDesc'] ?? '',
      tags: splitList(fields['etsyTags']),
      materials: splitList(fields['etsyMaterials']),
    })

    // Seller-entered SKU and colour variants ride on the same form. The parse
    // reports per line; a broken variant row refuses the whole save so the
    // seller sees the message rather than losing the row silently.
    const skuRaw = (fields['ebaySku'] ?? '').trim()
    const sku = skuRaw ? EbaySkuSchema.safeParse(skuRaw) : null
    const parsedVariants = parseVariants(fields['ebayVariants'] ?? '')

    // Validate with the same schemas the CLI uses, so the UI cannot smuggle in
    // copy that a marketplace would reject.
    if (!ebay.success || !etsy.success || (sku && !sku.success) || parsedVariants.errors.length) {
      const issues = [
        ...(ebay.success ? [] : ebay.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
        ...(etsy.success ? [] : etsy.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
        ...(sku && !sku.success ? sku.error.issues.map((i) => `SKU: ${i.message}`) : []),
        ...parsedVariants.errors.map((e) => `Varianten: ${e}`),
      ].join(' · ')
      redirect(res, flashUrl(backTo, 'bad', `Nicht gespeichert — ${issues}`))
      return
    }

    // Re-read at the write: `listing` was captured before the form was parsed,
    // and a CLI run finishing in between must not have its fields clobbered by
    // this stale snapshot. Same pattern at every upsert in this handler.
    const current = get(id) ?? listing
    // The textarea round trip carries no image URLs, so a variant keeps the
    // photos it already had — matched by SKU, which is what identifies it.
    const variants = parsedVariants.variants.length
      ? parsedVariants.variants.map((v) => ({
          ...v,
          imageUrls: current.variants?.find((old) => old.sku === v.sku)?.imageUrls ?? [],
        }))
      : null
    upsert({
      ...current,
      copy: { ebay: ebay.data, etsy: etsy.data },
      sku: sku ? sku.data : null,
      variants,
    })
    redirect(res, flashUrl(backTo, 'ok', 'Texte gespeichert.'))
    return
  }

  // --- images --------------------------------------------------------------
  if (action === '/images') {
    const added = await saveUploads(listing, files.filter((f) => f.field === 'images'))
    redirect(res, flashUrl(backTo, added ? 'ok' : 'warn', added ? `${added} Bild(er) hinzugefügt.` : 'Keine Bilder übernommen.'))
    return
  }

  const removeImage = /^\/images\/(\d+)\/remove$/.exec(action)
  if (removeImage) {
    const index = Number(removeImage[1])
    const current = get(id) ?? listing
    const paths = current.imagePaths.filter((_, i) => i !== index)
    upsert({ ...current, imagePaths: paths })
    redirect(res, flashUrl(backTo, 'ok', 'Bild entfernt.'))
    return
  }

  if (action === '/images/ebay') {
    if (!listing.imagePaths.length) {
      redirect(res, flashUrl(backTo, 'bad', 'Keine lokalen Bilder zum Hochladen.'))
      return
    }
    const urls = await uploadPictures(listing.imagePaths)
    // The uploads above take seconds per image — long enough for another
    // surface to have written. Re-read so only imageUrls changes here.
    upsert({ ...(get(id) ?? listing), imageUrls: urls })
    redirect(res, flashUrl(backTo, 'ok', `${urls.length} Bild(er) zu eBay hochgeladen.`))
    return
  }

  // --- commercial rights ---------------------------------------------------
  if (action === '/rights') {
    // Presence, not value: an unchecked box is simply absent from a form post,
    // so reading it as "leave unchanged" would make the claim impossible to
    // withdraw — and a rights assertion has to be revocable.
    const overridden = fields['overridden'] === '1'
    // The image claim cannot outlive the sale claim it depends on: pictures are
    // not licensed for a sale that is not.
    const imagesLicensed = overridden && fields['imagesLicensed'] === '1'
    const current = get(id) ?? listing

    // The Etsy risk claim keeps its original timestamp: it records when the
    // decision was made, and re-saving the form is not a new decision.
    const riskChecked = fields['etsyDesignRisk'] === '1'
    const etsyDesignRiskAccepted = riskChecked
      ? (current.etsyDesignRiskAccepted ?? { at: new Date().toISOString(), sourceUrl: current.sourceUrl })
      : null

    // The claim opens and closes the Etsy channel row. Withdrawing it removes
    // the row only while nothing exists remotely — a row with a remote draft
    // or live listing keeps its history, and the publish gate blocks anyway.
    let marketplaces = current.marketplaces
    const hasEtsyRow = marketplaces.some((m) => m.marketplace === 'etsy')
    const etsyOpen = current.ownDesign || etsyDesignRiskAccepted !== null
    if (etsyOpen && !hasEtsyRow) {
      marketplaces = [
        ...marketplaces,
        {
          marketplace: 'etsy',
          state: 'draft',
          remoteId: null,
          liveId: null,
          url: null,
          error: null,
          updatedAt: new Date().toISOString(),
        },
      ]
    } else if (!etsyOpen && hasEtsyRow) {
      marketplaces = marketplaces.filter(
        (m) => m.marketplace !== 'etsy' || m.remoteId !== null || m.liveId !== null,
      )
    }

    upsert({
      ...current,
      licenseOverridden: overridden,
      sourceImagesLicensed: imagesLicensed,
      etsyDesignRiskAccepted,
      marketplaces,
    })
    redirect(
      res,
      flashUrl(
        backTo,
        'ok',
        (overridden
          ? `Als lizenziert markiert${imagesLicensed ? ', Bilder eingeschlossen' : ''}. ` +
            'Prüfe, dass der Text keine Lizenz nennt — die auf der Seite ist nicht die, unter der du verkaufst.'
          : 'Rechte-Angabe zurückgenommen. Veröffentlichen ist wieder gesperrt.') +
          (riskChecked && !current.ownDesign
            ? ' Etsy-Eigendesign-Risiko übernommen — protokolliert mit Zeitpunkt und Quelle.'
            : ''),
      ),
    )
    return
  }

  // --- adopt the designer's images -----------------------------------------
  if (action === '/images/source') {
    const current = get(id) ?? listing
    // Re-checked here, not only in the markup: the button is only rendered once
    // the claim is made, but a form can be replayed, and this one copies
    // someone else's photographs into a listing.
    if (!gate(current.source.license, current.licenseOverridden, current.sourceImagesLicensed).mayReuseImages) {
      redirect(res, flashUrl(backTo, 'bad', 'Nicht übernommen — die Bilder sind für dieses Inserat nicht freigegeben.'))
      return
    }
    if (!current.source.images.length) {
      redirect(res, flashUrl(backTo, 'bad', 'Die Modellseite führt keine Bilder.'))
      return
    }

    const job = startJob(
      async (io) => {
        await adoptSourceImages(id, io)
        return id
      },
      {
        label: 'Bilder werden übernommen',
        hint: 'Sie werden von MakerWorld geladen und, wenn eBay verbunden ist, dort gehostet.',
      },
    )
    redirect(res, `/progress/${encodeURIComponent(job.id)}`)
    return
  }

  // --- preflight -----------------------------------------------------------
  if (action === '/preflight') {
    redirect(res, backTo)
    return
  }

  // --- keyword research ----------------------------------------------------
  if (action === '/keywords') {
    const choice = fields['marketplace']
    const marketplaces: Marketplace[] =
      choice === 'ebay' ? ['ebay'] : choice === 'etsy' ? ['etsy'] : ['ebay', 'etsy']

    const io = collectingIo(true)
    await keywordsCommand({ id, marketplaces, rewrite: false, credit: true, io })

    // A marketplace that failed is reported as a warning rather than thrown, so
    // read the collected output to say what actually happened.
    const failed = io.lines.filter((l) => l.level === 'warn' && l.message.includes('research failed'))
    redirect(
      res,
      failed.length
        ? flashUrl(backTo, 'warn', `Recherche teilweise fehlgeschlagen — ${failed[0]!.message}`)
        : flashUrl(backTo, 'ok', 'Recherche abgeschlossen.'),
    )
    return
  }

  if (action === '/keywords/rewrite') {
    // The button is disabled without research, but a form can be replayed —
    // so the precondition is enforced here too, as it is for publish.
    if (!listing.seo?.ebay && !listing.seo?.etsy) {
      redirect(res, flashUrl(backTo, 'bad', 'Erst recherchieren, dann neu schreiben.'))
      return
    }

    const io = collectingIo(true)
    // No marketplaces: draft against the research already on the record rather
    // than spending another round of marketplace calls.
    await keywordsCommand({ id, marketplaces: [], rewrite: true, credit: true, io })
    redirect(res, flashUrl(backTo, 'ok', 'Entwurf erstellt — noch nichts übernommen.'))
    return
  }

  // --- title options -------------------------------------------------------
  if (action === '/titles') {
    const io = collectingIo(true)
    await titlesCommand({ id, credit: true, io })
    redirect(res, flashUrl(backTo, 'ok', 'Titelvorschläge erzeugt — anklicken lädt sie ins Feld.'))
    return
  }

  // --- pending rewrite -----------------------------------------------------
  if (action === '/proposal/accept' || action === '/proposal/discard') {
    if (!listing.proposal) {
      redirect(res, flashUrl(backTo, 'bad', 'Kein Entwurf vorhanden.'))
      return
    }

    const discard = action === '/proposal/discard'
    const choice = fields['marketplace']
    const accept: Marketplace[] =
      choice === 'ebay' ? ['ebay'] : choice === 'etsy' ? ['etsy'] : ['ebay', 'etsy']

    const io = collectingIo(true)
    await proposalCommand({ id, accept: discard ? null : accept, discard, io })

    redirect(
      res,
      flashUrl(
        backTo,
        'ok',
        discard ? 'Entwurf verworfen — Inserat unverändert.' : 'Entwurf übernommen.',
      ),
    )
    return
  }

  // --- publish -------------------------------------------------------------
  if (action === '/publish') {
    const marketplace = (fields['marketplace'] === 'etsy' ? 'etsy' : 'ebay') as Marketplace
    const draftOnly = fields['draftOnly'] === '1'

    // The UI's publish button is disabled while blockers stand, but a form can
    // be replayed — so the rule is enforced here too, not just in the markup.
    if (!draftOnly) {
      const report = auditContent(listing, [marketplace])
      if (marketplace === 'ebay') await addAspectFindings(listing, report)
      if (report.blockers.length) {
        redirect(res, flashUrl(backTo, 'bad', `Nicht veröffentlicht — ${report.blockers.length} Blocker offen.`))
        return
      }
    }

    // Noted before the command runs: afterwards both a first publish and a
    // revise leave the row in the same state, and the flash should say which
    // of the two just happened.
    const wasLive = listing.marketplaces.some((m) => m.marketplace === marketplace && m.liveId !== null)

    const io = collectingIo(true)
    await publishCommand({
      id,
      marketplaces: [marketplace],
      draftOnly,
      yes: true,
      locationKey: 'default-de',
      categoryId: fields['categoryId'] || undefined,
      io,
    })

    const after = get(id)
    const record = after?.marketplaces.find((m) => m.marketplace === marketplace)
    if (record?.error) {
      redirect(res, flashUrl(backTo, 'bad', record.error.split('\n')[0] ?? 'Fehlgeschlagen.'))
    } else {
      redirect(
        res,
        flashUrl(
          backTo,
          'ok',
          wasLive
            ? 'Änderungen aufs Live-Inserat übertragen — gleiche Artikelnummer, Historie bleibt.'
            : draftOnly
              ? 'Entwurf beim Marktplatz angelegt.'
              : 'Veröffentlicht.',
        ),
      )
    }
    return
  }

  send(res, 404, errorPage('Unbekannte Aktion.'))
}

/**
 * Downloads the designer's images into the listing and, where eBay is already
 * connected, hosts them there too.
 *
 * One action because that is one decision: the seller said the pictures are
 * covered, and both marketplaces then want them in their own form — Etsy the
 * files, eBay a public URL it fetches itself. Splitting it would leave the
 * listing half-supplied and the difference invisible.
 *
 * The eBay half is best-effort. A missing token is an ordinary state for a
 * draft, and it must not discard the download that already succeeded.
 */
async function adoptSourceImages(id: string, io: Io): Promise<void> {
  const listing = requireListing(id)
  const urls = listing.source.images.map((image) => image.url)

  io.step(`Lade ${urls.length} Bild(er) von der Modellseite…`)
  const paths = await downloadImages(listing.id, urls)
  if (!paths.length) throw new UserError('Keines der Bilder ließ sich laden.')

  // The adopt button stays visible after a successful run, and a form can be
  // replayed. The downloads land on the same filenames, so paths already on
  // the record mean this adoption already happened — appending them again
  // would duplicate every photo in the listing and on the next eBay upload.
  const afterDownload = get(id) ?? listing
  const newPaths = paths.filter((p) => !afterDownload.imagePaths.includes(p))
  if (!newPaths.length) {
    io.warn('Diese Bilder sind bereits übernommen — nichts zu tun. Für eBay-URLs: Knopf „Zu eBay hochladen".')
    return
  }
  upsert({ ...afterDownload, imagePaths: [...afterDownload.imagePaths, ...newPaths] })
  io.ok(`${newPaths.length} Bild(er) übernommen — Etsy kann damit arbeiten.`)

  if (!ebayAuth.storedTokens()) {
    io.warn('Nicht mit eBay verbunden — die HTTPS-URLs fehlen noch. Nach `lister auth ebay` der Knopf „Zu eBay hochladen".')
    return
  }

  io.step('Lade sie auf eBays Bildserver…')
  const hosted = await uploadPictures(newPaths)
  const afterUpload = get(id) ?? afterDownload
  upsert({ ...afterUpload, imageUrls: [...afterUpload.imageUrls, ...hosted] })
  io.ok(`${hosted.length} HTTPS-URL(s) eingetragen — eBay kann damit arbeiten.`)
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * Picks a filename no existing file occupies.
 *
 * Counting from `paths.length + 1` — as this once did — collides after a
 * removal: with [own-01, own-02] reduced to [own-02], the next upload would be
 * named own-02 again and silently overwrite the bytes of an image the listing
 * still shows. The counter therefore probes the disk, not the array length.
 */
function freeImagePath(dir: string, ext: string, exists: (p: string) => boolean): string {
  for (let n = 1; ; n++) {
    const candidate = join(dir, `own-${String(n).padStart(2, '0')}${ext}`)
    if (!exists(candidate)) return candidate
  }
}

/** Writes uploaded photos into the listing's image directory. */
async function saveUploads(listing: ListingRecord, uploads: UploadedFile[]): Promise<number> {
  if (!uploads.length) return 0

  const dir = imageDirFor(listing.id)
  const paths = [...listing.imagePaths]

  for (const file of uploads) {
    const ext = extname(file.filename).toLowerCase()
    // Only image types the marketplaces accept, and never a caller-supplied path.
    if (!IMAGE_TYPES.has(ext)) continue
    const target = freeImagePath(dir, ext, existsSync)
    await writeFile(target, file.data)
    paths.push(target)
  }

  const added = paths.length - listing.imagePaths.length
  if (added > 0) {
    const current = get(listing.id) ?? listing
    upsert({ ...current, imagePaths: [...current.imagePaths, ...paths.slice(listing.imagePaths.length)] })
  }
  return added
}

export { page, esc }
