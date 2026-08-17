import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { config } from '../../config.js'
import { log, UserError } from '../../util/log.js'
import { RateLimiter, request, ApiError } from '../../util/http.js'
import { getUserToken, apiBase } from './auth.js'

/**
 * Uploads a picture to eBay's own picture server.
 *
 * eBay's Inventory API takes image *URLs* and fetches them itself — it will not
 * accept an upload. That leaves a seller who photographs their own product with
 * nowhere to put the file. `UploadSiteHostedPictures` closes that gap: hand it
 * the bytes, get back an eBay-hosted HTTPS URL that drops straight into
 * `product.imageUrls`.
 *
 * It is the one piece of this tool that is not REST. The Trading API is XML over
 * `/ws/api.dll`, and it has two traps worth knowing before reading further:
 *
 *   1. Failures come back as **HTTP 200** with `<Ack>Failure</Ack>` in the body.
 *      Checking the status code alone reports success on every error.
 *   2. The image bytes must be a separate MIME part. Serialising them into the
 *      XML is rejected, whatever the field name suggests.
 *
 * Authentication reuses the OAuth token we already hold, passed in the
 * `X-EBAY-API-IAF-TOKEN` header — the legacy Auth'n'Auth flow is not needed.
 */

/**
 * eBay's *site* id, which is a different numbering scheme from the Taxonomy
 * category-tree id even though Germany happens to be 77 in both. Do not
 * consolidate these; the coincidence is not a relationship.
 */
const SITE_IDS: Record<string, number> = {
  EBAY_DE: 77,
  EBAY_AT: 16,
  EBAY_CH: 193,
  EBAY_GB: 3,
  EBAY_US: 0,
  EBAY_FR: 71,
  EBAY_IT: 101,
  EBAY_ES: 186,
}

/** Trading API schema version. Anything recent works; this one is well established. */
const COMPATIBILITY_LEVEL = '1193'

/** eBay throttles the picture service; one upload at a time is plenty. */
const limiter = new RateLimiter(2)

function tradingEndpoint(): string {
  // The Trading API lives on the same host as REST but a different path.
  return `${apiBase()}/ws/api.dll`
}

function siteId(): number {
  const id = SITE_IDS[config.ebay.marketplaceId]
  if (id === undefined) {
    throw new UserError(
      `No eBay site id known for ${config.ebay.marketplaceId}.`,
      'Add it to SITE_IDS in src/marketplaces/ebay/pictures.ts.',
    )
  }
  return id
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  )
}

/**
 * Builds the XML part.
 *
 * `PictureName` is what shows in Seller Hub. `PictureSet: Supersize` asks eBay
 * to generate the larger variants gallery views use.
 */
export function buildUploadXml(pictureName: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <PictureName>${escapeXml(pictureName)}</PictureName>
  <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>`
}

export interface UploadedPicture {
  /** The URL to put in product.imageUrls. */
  url: string
  /** eBay's own identifier, useful if the picture is reused later. */
  pictureSetId: string | null
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
}

/**
 * Reads the Trading API response.
 *
 * Exported for tests: the HTTP-200-plus-`<Ack>Failure</Ack>` shape is the whole
 * reason this needs its own parser, and it deserves to be pinned.
 */
/**
 * Reads the text of an XML element, case-insensitively.
 *
 * Deliberately not using an HTML parser here. `node-html-parser` lowercases
 * tag names, so `querySelector('FullURL')` silently matches nothing while
 * `'fullurl'` works — a trap that costs an afternoon and, worse, could pass a
 * casual test and fail in production. eBay's response is flat and
 * well-formed, so matching the tag directly is both simpler and honest about
 * the case-insensitivity.
 */
/**
 * Undoes the XML escaping a well-formed response applies to text content.
 *
 * The request side escapes the five predefined entities (`escapeXml` above);
 * without the mirror image here, a FullURL whose query carries a second
 * parameter would be stored with a literal `&amp;` in it, and error messages
 * print their escaping at the seller. `&amp;` is decoded last so sequences
 * like `&amp;lt;` do not double-decode.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  const raw = match?.[1]?.trim()
  return raw ? decodeXmlEntities(raw) : undefined
}

/** All occurrences of a repeated element, as raw inner XML. */
function tagBlocks(xml: string, tag: string): string[] {
  const out: string[] = []
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) if (match[1]) out.push(match[1])
  return out
}

/**
 * Pulls eBay's own wording out of the `<Errors>` blocks.
 *
 * Keeps both messages when they differ: the short one is the diagnosis ("the
 * image is too small"), the long one the advice ("we recommend larger images").
 * Either alone loses half the point.
 */
function collectMessages(xml: string): string[] {
  return tagBlocks(xml, 'Errors')
    .map((block) => {
      const code = tagText(block, 'ErrorCode')
      const short = tagText(block, 'ShortMessage')
      const long = tagText(block, 'LongMessage')
      const text = short && long && short !== long ? `${short} ${long}` : (short ?? long ?? '')
      return [code ? `[${code}]` : '', text].filter(Boolean).join(' ')
    })
    .filter(Boolean)
}

export function parseUploadResponse(xml: string): UploadedPicture {
  const ack = tagText(xml, 'Ack') ?? ''
  // FullURL is the site-hosted address; it is what the Inventory API needs.
  // The sibling MemberURLs are the generated thumbnails.
  const url = tagText(xml, 'FullURL')
  const messages = collectMessages(xml)

  // The Trading API has four ack values, and only Failure is unambiguous.
  // `Warning` means the upload may still have succeeded — eBay complains but
  // returns a URL — so the presence of a URL decides, not the ack alone.
  if (/^failure$/i.test(ack) || !url) {
    // eBay's own wording goes in the message, not the hint: it is the only part
    // that says what actually went wrong, and a caller that logs just the
    // message would otherwise learn nothing.
    const reason = messages.join(' · ') || xml.slice(0, 300) || 'empty response'
    throw new UserError(
      `eBay did not accept the picture (Ack: ${ack || 'none'}) — ${reason}`,
      ack ? undefined : 'The response was not a Trading API reply at all; check the endpoint and headers.',
    )
  }

  // Accepted despite a complaint: say what it was rather than swallowing it.
  if (messages.length) {
    for (const message of messages) log.warn(`eBay: ${message}`)
  }

  return {
    url,
    pictureSetId: tagText(xml, 'PictureSetID') ?? null,
  }
}

/** Uploads one file and returns its eBay-hosted URL. */
export async function uploadPicture(filePath: string, name?: string): Promise<UploadedPicture> {
  const bytes = await readFile(filePath)
  const fileName = basename(filePath)
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'image/jpeg'
  const token = await getUserToken()

  const form = new FormData()
  // Order matters: the XML payload must be the first part, the binary the second.
  form.append('XML Payload', buildUploadXml(name ?? fileName))
  form.append('image', new Blob([new Uint8Array(bytes)], { type: contentType }), fileName)

  try {
    const response = await limiter.run(() =>
      request(tradingEndpoint(), {
        method: 'POST',
        headers: {
          // OAuth against the legacy API: this header replaces RequesterCredentials.
          'x-ebay-api-iaf-token': token,
          'x-ebay-api-call-name': 'UploadSiteHostedPictures',
          'x-ebay-api-compatibility-level': COMPATIBILITY_LEVEL,
          'x-ebay-api-siteid': String(siteId()),
          'x-ebay-api-detail-level': '0',
        },
        // No content-type here — fetch must set the multipart boundary itself.
        body: form,
        // Uploads are not idempotent; a retry can leave duplicate pictures behind.
        maxAttempts: 1,
        timeoutMs: 120_000,
      }),
    )

    return parseUploadResponse(await response.text())
  } catch (error) {
    if (error instanceof UserError) throw error
    if (error instanceof ApiError) {
      throw new UserError(`Uploading ${fileName} to eBay failed: ${error.message}`)
    }
    throw error
  }
}

/**
 * Uploads several files, in order, and returns their URLs.
 *
 * Sequential on purpose: the picture service is rate limited, and keeping the
 * order stable means image 1 stays the gallery image.
 */
export async function uploadPictures(filePaths: string[]): Promise<string[]> {
  const urls: string[] = []
  for (const [index, path] of filePaths.entries()) {
    log.detail(`Uploading image ${index + 1}/${filePaths.length} to eBay…`)
    const { url } = await uploadPicture(path)
    urls.push(url)
  }
  return urls
}
