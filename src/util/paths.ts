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
export const UPLOAD_DIR = join(DATA_DIR, 'uploads')
/**
 * The web UI's session token.
 *
 * Persisted so restarting the server does not invalidate the tabs that are
 * already open: a fresh token per run meant every restart answered the next
 * button press with a bare 403 ("Session token does not match"), which reads
 * as "the button is broken". It is a secret, so it sits in the same 0700
 * directory as the OAuth tokens and is written 0600.
 */
export const SESSION_TOKEN_FILE = join(DATA_DIR, 'session-token')

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

/**
 * Per-listing directory for uploaded print files (sliced 3MFs). Files are
 * stored content-addressed (`<sha256>.gcode.3mf`), so a re-upload of the same
 * bytes lands on the same path and every recorded version stays readable.
 */
export function uploadDirFor(listingId: string): string {
  const dir = join(UPLOAD_DIR, listingId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
