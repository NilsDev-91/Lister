import { UserError } from '../util/log.js'
import type { Platform, SourceModel } from '../types.js'
import * as makerworld from './makerworld/fetcher.js'
import * as cults3d from './cults3d/fetcher.js'
import * as printables from './printables/fetcher.js'

/**
 * The one place that turns a pasted URL into a platform and its adapter.
 *
 * Dispatch is by hostname, and an unknown host is a loud error rather than a
 * fallback: guessing the wrong platform would produce a listing whose licence
 * came from the wrong vocabulary, and everything downstream trusts that field.
 */

interface SourceAdapter {
  /** Human name for error messages and the UI. */
  label: string
  /** Hostname suffix match, e.g. `makerworld.com` and its subdomains. */
  hosts: RegExp
  parseModelUrl(input: string): { externalId: string; normalised: string }
  fetchModel(url: string): Promise<SourceModel>
  /**
   * Present only where the platform cannot be fetched by a plain HTTP client
   * and the browser-saved page is the dependable route (MakerWorld sits behind
   * Cloudflare). Platforms with an API never need the file.
   */
  readModelFromFile?: (filePath: string, url: string) => Promise<SourceModel>
}

const ADAPTERS: ReadonlyArray<readonly [Platform, SourceAdapter]> = [
  [
    'MAKERWORLD',
    {
      label: 'MakerWorld',
      hosts: /(^|\.)makerworld\.com$/i,
      parseModelUrl: makerworld.parseModelUrl,
      fetchModel: makerworld.fetchModel,
      readModelFromFile: makerworld.readModelFromFile,
    },
  ],
  [
    'CULTS3D',
    {
      label: 'Cults3D',
      hosts: /(^|\.)cults3d\.com$/i,
      parseModelUrl: cults3d.parseModelUrl,
      fetchModel: cults3d.fetchModel,
    },
  ],
  [
    'PRINTABLES',
    {
      label: 'Printables',
      hosts: /(^|\.)printables\.com$/i,
      parseModelUrl: printables.parseModelUrl,
      fetchModel: printables.fetchModel,
    },
  ],
]

function supportedHosts(): string {
  return ADAPTERS.map(([, a]) => a.label).join(', ')
}

function adapterFor(input: string): { platform: Platform; adapter: SourceAdapter } {
  let hostname: string
  try {
    hostname = new URL(input.trim()).hostname
  } catch {
    throw new UserError(
      `"${input}" is not a URL.`,
      `Paste the model page's address. Supported platforms: ${supportedHosts()}.`,
    )
  }
  const hit = ADAPTERS.find(([, a]) => a.hosts.test(hostname))
  if (!hit) {
    throw new UserError(
      `No adapter for ${hostname}.`,
      `Supported platforms: ${supportedHosts()}. Other hosts are deliberately not guessed at.`,
    )
  }
  return { platform: hit[0], adapter: hit[1] }
}

/** Which platform a URL belongs to, or null — for UI hints, never for dispatch. */
export function platformForUrl(input: string): Platform | null {
  try {
    return adapterFor(input).platform
  } catch {
    return null
  }
}

export interface ParsedModelUrl {
  platform: Platform
  externalId: string
  normalised: string
}

/** Hostname → platform → that platform's URL rules. Throws a UserError on unknown hosts. */
export function parseModelUrl(input: string): ParsedModelUrl {
  const { platform, adapter } = adapterFor(input)
  return { platform, ...adapter.parseModelUrl(input) }
}

export async function fetchModel(url: string): Promise<SourceModel> {
  const { adapter } = adapterFor(url)
  return adapter.fetchModel(url)
}

/**
 * Parses a browser-saved page — MakerWorld's route around Cloudflare.
 *
 * Refused for platforms with an API rather than silently ignored: a file the
 * user attached on purpose deserves either to be used or to be named as the
 * mistake it is.
 */
export async function readModelFromFile(filePath: string, url: string): Promise<SourceModel> {
  const { adapter } = adapterFor(url)
  if (!adapter.readModelFromFile) {
    throw new UserError(
      `A saved page is only for MakerWorld — ${adapter.label} is read through its API.`,
      'Drop the file / --from-html and pass the URL alone.',
    )
  }
  return adapter.readModelFromFile(filePath, url)
}

/** True when the platform's dependable route is a browser-saved page. */
export function needsSavedPage(platform: Platform): boolean {
  return ADAPTERS.some(([p, a]) => p === platform && a.readModelFromFile !== undefined)
}
