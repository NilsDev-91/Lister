import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * Everything stateful lives outside the repo, so a `git add -A` can never
 * sweep up a refresh token.
 */
export const DATA_DIR = process.env.LISTER_DATA_DIR ?? join(homedir(), '.3d-print-lister')

export const TOKENS_FILE = join(DATA_DIR, 'tokens.json')
export const IMAGE_CACHE_DIR = join(DATA_DIR, 'images')

/** Creates the data directory tree. Safe to call repeatedly. */
export function ensureDataDir(): void {
  // mode 0o700 is a no-op on Windows ACLs but correct on POSIX, and harmless here.
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(IMAGE_CACHE_DIR, { recursive: true, mode: 0o700 })
}

/** Per-listing image staging directory. */
export function imageDirFor(listingId: string): string {
  const dir = join(IMAGE_CACHE_DIR, listingId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
