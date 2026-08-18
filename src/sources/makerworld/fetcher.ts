import { parse as parseHtml, type HTMLElement } from 'node-html-parser'
import { UserError, log } from '../../util/log.js'
import { request } from '../../util/http.js'
import { normaliseLicense } from './license.js'
import { SourceModelSchema, type SourceImage, type SourceModel } from '../../types.js'

/**
 * Reads a single MakerWorld model page.
 *
 * Scope, deliberately: one page, fetched because the user typed its URL. There
 * is no crawler here, no link following, no bulk enumeration and no background
 * refresh — one user action produces one request, the same as opening the page
 * in a browser. MakerWorld publishes no public API, so the page itself is the
 * only source, and that means this module is inherently brittle: it tries
 * several extraction strategies and degrades to whatever it can prove rather
 * than inventing values.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** e.g. https://makerworld.com/en/models/1234567-articulated-dragon#profileId-987 */
const MODEL_URL = /^https?:\/\/(?:www\.)?makerworld\.com\/(?:[a-z]{2}\/)?models\/(\d+)/i

export function parseModelUrl(input: string): { externalId: string; normalised: string } {
  const match = MODEL_URL.exec(input.trim())
  if (!match?.[1]) {
    throw new UserError(
      `"${input}" is not a MakerWorld model URL.`,
      'Expected something like https://makerworld.com/en/models/1234567-name',
    )
  }
  const externalId = match[1]
  return { externalId, normalised: `https://makerworld.com/en/models/${externalId}` }
}

const BLOCKED_HINT =
  'MakerWorld sits behind Cloudflare and refuses non-browser requests, so this is expected rather than a bug.\n' +
  '  Open the model in your browser, save the page (Ctrl+S, "Webpage, complete" or "HTML only"),\n' +
  '  then re-run with:  lister create --url <url> --from-html <saved-file.html> …'

/**
 * Markers of a Cloudflare *interstitial* — the page that stands in place of the
 * content, as opposed to an ordinary page that merely passed through Cloudflare.
 *
 * That distinction is the entire point of this list, and getting it wrong is
 * expensive. Cloudflare injects its passive JavaScript-detection probe — a
 * script at `/cdn-cgi/challenge-platform/scripts/jsd/main.js` — into pages it
 * serves **successfully**. A bare `challenge-platform` match therefore rejects
 * every real MakerWorld page, which is exactly what it did: the saved-page
 * route, the one route documented as dependable, refused every genuine page
 * while the synthetic test fixtures sailed through because they carry no
 * Cloudflare script at all.
 *
 * Each pattern below appears only where the content was actually withheld: the
 * challenge config object, the orchestrate path (`/h/b/`, `/h/g/` — not
 * `/scripts/jsd/`), and the interstitial's own wording.
 */
const CHALLENGE_MARKERS: RegExp[] = [
  /cf-browser-verification/i,
  /_cf_chl_opt/i,
  /\/cdn-cgi\/challenge-platform\/h\//i,
  /<title>\s*Just a moment/i,
  /Enable JavaScript and cookies to continue/i,
  /Checking if the site connection is secure/i,
]

/**
 * Detects a Cloudflare interstitial. It can arrive as a 403 *or* as a 200 with
 * a challenge body, so the status alone does not tell us whether we got the page.
 */
export function isChallenge(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => marker.test(html))
}

async function fetchPage(url: string): Promise<string> {
  let response: Response
  try {
    response = await request(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,de;q=0.8',
      },
      // A Cloudflare block is not transient; retrying just wastes the user's time.
      maxAttempts: 1,
    })
  } catch (error) {
    throw new UserError(`Could not read the MakerWorld page: ${(error as Error).message}`, BLOCKED_HINT)
  }

  const html = await response.text()
  if (isChallenge(html) || !html.includes('__NEXT_DATA__')) {
    throw new UserError('MakerWorld returned a Cloudflare browser check instead of the page.', BLOCKED_HINT)
  }

  return html
}

// ---------------------------------------------------------------------------
// Extraction strategies, tried in order of reliability
// ---------------------------------------------------------------------------

interface Extracted {
  title?: string
  description?: string
  designer?: string
  tags?: string[]
  images?: SourceImage[]
  license?: string
}

/**
 * Next.js pages-router payload: <script id="__NEXT_DATA__" type="application/json">.
 *
 * The model lives at `props.pageProps.design`. That path is an internal prop
 * name with no compatibility guarantee, so a structural search runs as a
 * fallback when it moves.
 */
function fromNextData(root: HTMLElement): Extracted | null {
  const script = root.querySelector('script#__NEXT_DATA__')
  if (!script) return null

  let data: unknown
  try {
    data = JSON.parse(script.rawText)
  } catch {
    return null
  }

  const direct = (data as { props?: { pageProps?: { design?: unknown } } })?.props?.pageProps?.design
  if (direct && typeof direct === 'object') {
    return fromDesignObject(direct as Record<string, unknown>)
  }

  const design = findDesignObject(data)
  return design ? fromDesignObject(design) : null
}

/**
 * Next.js app-router streams its payload as a series of
 * `self.__next_f.push([1,"...json fragment..."])` calls. Reassembling the
 * fragments and finding the design object is best-effort.
 */
function fromNextFlight(html: string): Extracted | null {
  const chunks: string[] = []
  const pattern = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    if (!match[1]) continue
    try {
      chunks.push(JSON.parse(`"${match[1]}"`) as string)
    } catch {
      // A fragment that will not unescape is not worth failing the whole parse.
    }
  }
  if (!chunks.length) return null

  const combined = chunks.join('')
  // Pull out balanced JSON objects that look like a design record.
  for (const candidate of jsonObjectsContaining(combined, '"designId"')) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      const design = findDesignObject(parsed)
      if (design) return fromDesignObject(design)
    } catch {
      continue
    }
  }
  return null
}

/** Yields substrings that are balanced JSON objects containing `needle`. */
function* jsonObjectsContaining(text: string, needle: string): Generator<string> {
  let from = 0
  for (;;) {
    const hit = text.indexOf(needle, from)
    if (hit === -1) return
    from = hit + needle.length

    // Walk backwards to the opening brace of the enclosing object.
    let start = hit
    let depth = 0
    while (start >= 0) {
      const ch = text[start]
      if (ch === '}') depth++
      else if (ch === '{') {
        if (depth === 0) break
        depth--
      }
      start--
    }
    if (start < 0) continue

    // Walk forwards to the matching close.
    let end = start
    depth = 0
    let inString = false
    let escaped = false
    while (end < text.length) {
      const ch = text[end]!
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = !inString
      else if (!inString) {
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            yield text.slice(start, end + 1)
            break
          }
        }
      }
      end++
    }
  }
}

/** Depth-first search for an object that looks like MakerWorld's design record. */
function findDesignObject(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 12 || value === null || typeof value !== 'object') return null

  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const hasId = 'designId' in record || 'id' in record
    const hasTitle = typeof record['title'] === 'string' || typeof record['name'] === 'string'
    const looksLikeDesign = hasId && hasTitle && ('license' in record || 'designCreator' in record || 'instruction' in record)
    if (looksLikeDesign) return record
  }

  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  for (const child of children) {
    const found = findDesignObject(child, depth + 1)
    if (found) return found
  }
  return null
}

function fromDesignObject(design: Record<string, unknown>): Extracted {
  const str = (key: string): string | undefined => {
    const v = design[key]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }

  const creator = design['designCreator']
  const designer =
    (typeof creator === 'object' && creator !== null
      ? ((creator as Record<string, unknown>)['name'] as string | undefined)
      : undefined) ?? str('creatorName')

  const licenseValue = design['license']
  const license =
    typeof licenseValue === 'string'
      ? licenseValue
      : typeof licenseValue === 'object' && licenseValue !== null
        ? ((licenseValue as Record<string, unknown>)['name'] as string | undefined)
        : undefined

  const rawTags = design['tags']
  const tags = Array.isArray(rawTags)
    ? rawTags
        .map((t) => (typeof t === 'string' ? t : (t as Record<string, unknown> | null)?.['name']))
        .filter((t): t is string => typeof t === 'string')
    : undefined

  // Pictures live at designExtension.design_pictures — designExtension itself is
  // an object, not an array, so it cannot be iterated directly. The other keys
  // are fallbacks for older or differently-shaped payloads.
  const extension = design['designExtension']
  const fromExtension =
    extension && typeof extension === 'object'
      ? (extension as Record<string, unknown>)['design_pictures']
      : undefined

  const rawCovers = fromExtension ?? design['covers'] ?? design['images']
  const images = Array.isArray(rawCovers)
    ? rawCovers
        .map((c, i) => {
          const url = typeof c === 'string' ? c : ((c as Record<string, unknown> | null)?.['url'] as string | undefined)
          return url ? { url, rank: i } : null
        })
        .filter((c): c is SourceImage => c !== null)
    : undefined

  return {
    title: str('title') ?? str('name'),
    description: str('summary') ?? str('description') ?? str('instruction'),
    designer,
    tags,
    images,
    license,
  }
}

/** OpenGraph and standard meta tags — the reliable floor. */
function fromMetaTags(root: HTMLElement): Extracted {
  const meta = (property: string): string | undefined => {
    const el =
      root.querySelector(`meta[property="${property}"]`) ?? root.querySelector(`meta[name="${property}"]`)
    const content = el?.getAttribute('content')?.trim()
    return content || undefined
  }

  const image = meta('og:image')
  return {
    title: meta('og:title') ?? root.querySelector('title')?.text.trim(),
    description: meta('og:description') ?? meta('description'),
    images: image ? [{ url: image, rank: 0 }] : undefined,
  }
}

/**
 * Last resort for the licence: look for a recognisable licence string in the
 * page text.
 *
 * Guarded on three sides, because this fallback can *upgrade* a licence and
 * thereby bypass the sale gate — a wrong match here is the worst wrong answer
 * this module can give:
 *
 *  - Scripts and styles are stripped first. They carry megabytes of base64 and
 *    hex colours where the short CC tokens match by accident — a stylesheet's
 *    `#cc0000` contains `CC0`, a JS identifier `accByUser` contains `ccBy`.
 *  - Every pattern is word-bounded, so a token inside a longer word never
 *    counts.
 *  - A bare "Attribution" is any footer link, not a licence; only the
 *    compound (`Attribution-NonCommercial…`) or versioned form qualifies.
 *
 * If nothing survives these rules the licence stays unknown, which downstream
 * turns into a confirmation prompt — the safe direction.
 */
function licenseFromText(html: string): string | undefined {
  const visible = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const patterns = [
    /Standard Digital File License/i,
    /\bCC[\s-]*BY(?:[\s-]*(?:NC|SA|ND))*(?:[\s-]*\d\.\d)?\b/i,
    /\bCC0(?:[\s-]*\d\.\d)?\b/i,
    /\bAttribution(?:[\s-]*(?:NonCommercial|ShareAlike|NoDerivatives))+\b/i,
    /\bAttribution[\s-]*\d\.\d\b/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(visible)
    if (match) return match[0]
  }
  return undefined
}

function merge(...sources: (Extracted | null)[]): Extracted {
  const out: Extracted = {}
  for (const source of sources) {
    if (!source) continue
    out.title ??= source.title
    out.description ??= source.description
    out.designer ??= source.designer
    out.license ??= source.license
    if (!out.tags?.length && source.tags?.length) out.tags = source.tags
    if (!out.images?.length && source.images?.length) out.images = source.images
  }
  return out
}

/**
 * Parses a model page that has already been retrieved.
 *
 * Split out from `fetchModel` because a browser-saved file is the more reliable
 * input: Cloudflare will not serve this page to a plain HTTP client, but the
 * user's own browser has no such trouble.
 *
 * Returns whatever it can prove. A missing description or tag list is normal
 * and downstream code copes; a missing title means the parse genuinely failed
 * and we say so rather than emitting a listing called "undefined".
 */
export function parseModelHtml(html: string, inputUrl: string): SourceModel {
  const { externalId, normalised } = parseModelUrl(inputUrl)

  const root = parseHtml(html)

  // Kept apart because the two carry different weight. The embedded payload is
  // MakerWorld's own model record; the meta tags are a floor that any HTML page
  // has, including an interstitial with a <title>.
  const fromPayload = merge(fromNextData(root), fromNextFlight(html))
  const extracted = merge(fromPayload, fromMetaTags(root))

  // **A page carrying the model record is not a challenge page**, whatever
  // scripts it happens to carry — and that is the only reliable way to tell the
  // two apart, because Cloudflare puts its detection script on both. Asking the
  // marker question first, as this once did, let a string found anywhere in two
  // megabytes of markup veto a page whose model data was sitting right there.
  //
  // The question still gets asked when the payload is missing, and there it
  // earns its keep: an interstitial's <title> would otherwise be mistaken for a
  // model name and produce a listing called "Just a moment...".
  if (!fromPayload.title && isChallenge(html)) {
    throw new UserError(
      'That file is a Cloudflare challenge page, not the model page.',
      'Open the model in your browser, wait until it has actually rendered, then save it with Ctrl+S.',
    )
  }

  if (!extracted.title) {
    throw new UserError(
      'Could not read the model title from that page.',
      'MakerWorld may have changed its page structure, or the URL may not be a model page.',
    )
  }

  const licenseRaw = extracted.license ?? licenseFromText(html) ?? ''
  const license = normaliseLicense(licenseRaw)

  const model: SourceModel = {
    sourceUrl: normalised,
    platform: 'MAKERWORLD',
    externalId,
    title: extracted.title,
    description: extracted.description ?? '',
    designer: extracted.designer ?? 'Unknown designer',
    tags: extracted.tags ?? [],
    images: dedupeImages(extracted.images ?? []),
    license,
    fetchedAt: new Date().toISOString(),
  }

  const parsed = SourceModelSchema.safeParse(model)
  if (!parsed.success) {
    throw new UserError(
      `The parsed model failed validation:\n${parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }

  log.ok(`"${model.title}" by ${model.designer}`)
  log.detail(`Licence: ${license.raw || '(none found)'} → commercial use: ${license.commercialUse}`)
  if (!model.description) log.warn('No description found on the page — copy will be written from the title and your notes.')
  if (!model.images.length) log.warn('No images found on the page — you will need to supply your own photos.')

  return parsed.data
}

/**
 * Reads a model from a page the user's browser already saved to disk.
 *
 * This is the reliable path. It also means no automated request ever reaches
 * MakerWorld: the page was fetched by an ordinary browser session, and this
 * tool only parses the resulting local file.
 */
export async function readModelFromFile(filePath: string, inputUrl: string): Promise<SourceModel> {
  const { readFile } = await import('node:fs/promises')
  let html: string
  try {
    html = await readFile(filePath, 'utf8')
  } catch (error) {
    throw new UserError(`Could not read ${filePath}: ${(error as Error).message}`)
  }
  log.step(`Parsing saved page ${filePath}`)
  return parseModelHtml(html, inputUrl)
}

/**
 * Fetches and parses one model page directly.
 *
 * Scope: one page, because the user typed its URL. Note that MakerWorld sits
 * behind Cloudflare and usually refuses non-browser clients, so this often
 * fails and `readModelFromFile` is the dependable route.
 */
export async function fetchModel(inputUrl: string): Promise<SourceModel> {
  const { externalId, normalised } = parseModelUrl(inputUrl)
  log.step(`Reading MakerWorld model ${externalId}`)
  const html = await fetchPage(normalised)
  return parseModelHtml(html, normalised)
}

function dedupeImages(images: SourceImage[]): SourceImage[] {
  const seen = new Set<string>()
  const out: SourceImage[] = []
  for (const image of images) {
    // MakerWorld serves the same asset at several CDN sizes; key on the path.
    let key = image.url
    try {
      const url = new URL(image.url)
      key = `${url.host}${url.pathname}`
    } catch {
      // Not a parseable URL; the zod schema will reject it below.
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: image.url, rank: out.length })
  }
  return out
}
