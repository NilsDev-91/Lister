import { writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { imageDirFor } from './util/paths.js'
import { request } from './util/http.js'
import { log, UserError } from './util/log.js'

/**
 * Image staging.
 *
 * The two marketplaces want images in opposite forms:
 *   eBay  — an array of public HTTPS URLs, which eBay fetches itself.
 *   Etsy  — the actual bytes, one multipart upload per image.
 *
 * So a MakerWorld render that the licence lets us reuse can go to eBay as a URL
 * with no download at all, while Etsy needs it on disk. Photos the seller took
 * themselves are the mirror image: fine for Etsy, but eBay cannot see a local
 * file, so those need somewhere public to live.
 */

export interface StagedImages {
  /** Public HTTPS URLs, for eBay. */
  urls: string[]
  /** Local file paths, for Etsy's multipart upload. */
  paths: string[]
}

const MAX_BYTES = 10 * 1024 * 1024 // Etsy rejects uploads above ~10 MB.

/**
 * Whether a staged file looks like a source-platform download rather than the
 * seller's own photo.
 *
 * `downloadImages` below names its files `01.jpg`, `02.png`, … while seller
 * uploads are `own-01.jpg` (web UI) or arbitrary paths (CLI). A heuristic,
 * and labelled as one — renaming a file changes its verdict. It is the
 * boundary the Etsy image rule runs on: Etsy requires the seller's own
 * original material of the finished product, so downloads never qualify
 * there, whatever the licence says.
 */
export function looksLikeSourceDownload(path: string): boolean {
  return /^\d{2}\.(jpe?g|png|gif|webp)$/i.test(path.split(/[\\/]/).pop() ?? '')
}

function extensionFor(url: string, contentType: string | null): string {
  const fromUrl = extname(new URL(url).pathname).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(fromUrl)) return fromUrl
  if (contentType?.includes('png')) return '.png'
  if (contentType?.includes('gif')) return '.gif'
  if (contentType?.includes('webp')) return '.webp'
  return '.jpg'
}

/** Downloads remote images so Etsy can upload them. */
export async function downloadImages(listingId: string, urls: string[]): Promise<string[]> {
  if (!urls.length) return []

  const dir = imageDirFor(listingId)
  const paths: string[] = []

  for (const [index, url] of urls.entries()) {
    const response = await request(url, {
      onRetry: (attempt, delay, reason) =>
        log.detail(`Image ${index + 1}: ${reason}, retrying in ${Math.round(delay)}ms (attempt ${attempt})`),
    })
    const buffer = Buffer.from(await response.arrayBuffer())

    if (buffer.byteLength > MAX_BYTES) {
      log.warn(`Skipping image ${index + 1}: ${(buffer.byteLength / 1e6).toFixed(1)} MB exceeds the 10 MB limit.`)
      continue
    }

    const file = join(dir, `${String(index + 1).padStart(2, '0')}${extensionFor(url, response.headers.get('content-type'))}`)
    await writeFile(file, buffer)
    paths.push(file)
  }

  log.detail(`Staged ${paths.length} image(s) in ${dir}`)
  return paths
}

/** Validates seller-supplied local image paths. */
export function useLocalImages(inputs: string[]): string[] {
  const paths: string[] = []
  for (const input of inputs) {
    const path = resolve(input)
    if (!existsSync(path)) {
      throw new UserError(`Image not found: ${input}`)
    }
    const size = statSync(path).size
    if (size > MAX_BYTES) {
      throw new UserError(`${input} is ${(size / 1e6).toFixed(1)} MB; the limit is 10 MB.`)
    }
    // The intersection of what both marketplaces take. Notably no .webp: eBay
    // accepts it but Etsy does not, and local files are staged for Etsy.
    if (!['.jpg', '.jpeg', '.png', '.gif', '.heic'].includes(extname(path).toLowerCase())) {
      throw new UserError(`${input} is not a JPG, PNG, GIF or HEIC.`)
    }
    paths.push(path)
  }
  return paths
}

/**
 * Works out what each marketplace gets.
 *
 * `--image-url` exists because eBay cannot read a local file: if you shoot your
 * own photos, they have to be reachable over HTTPS before eBay will accept them.
 */
export async function stageImages(args: {
  listingId: string
  /** MakerWorld renders, usable only when the licence permits. */
  sourceUrls: string[]
  mayReuseSource: boolean
  /** Local photos supplied by the seller. */
  localPaths: string[]
  /** Seller-hosted HTTPS URLs, for eBay. */
  hostedUrls: string[]
}): Promise<StagedImages> {
  const { listingId, sourceUrls, mayReuseSource, localPaths, hostedUrls } = args

  if (mayReuseSource && sourceUrls.length && !localPaths.length && !hostedUrls.length) {
    // The straightforward case: licence allows reuse, so eBay gets the CDN URLs
    // directly and we only download for Etsy's sake.
    const paths = await downloadImages(listingId, sourceUrls)
    return { urls: sourceUrls, paths }
  }

  const paths = localPaths.length ? useLocalImages(localPaths) : []
  const urls = [...hostedUrls]

  if (mayReuseSource && sourceUrls.length && !urls.length) {
    urls.push(...sourceUrls)
  }
  if (!paths.length && urls.length) {
    // Etsy needs bytes; fetch whatever we have URLs for.
    paths.push(...(await downloadImages(listingId, urls)))
  }

  return { urls, paths }
}
