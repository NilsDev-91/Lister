import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs'
import { z } from 'zod'
import { TOKENS_FILE, ensureDataDir } from '../util/paths.js'
import { withFileLock, replaceFile } from '../store/file-lock.js'
import { UserError } from '../util/log.js'

/**
 * OAuth token storage.
 *
 * Tokens live in ~/.3d-print-lister/tokens.json with 0600 permissions, outside
 * the repo. An OS keychain (@napi-rs/keyring) would be stronger, but it adds a
 * native build step to what is otherwise a pure-JS tool; the file is at least
 * never in a directory `git add` can reach.
 */

const TokenSetSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  /** Epoch milliseconds. */
  accessExpiresAt: z.number().int(),
  /** Epoch milliseconds. eBay refresh tokens expire (~18 months); Etsy's do not. */
  refreshExpiresAt: z.number().int().nullable(),
  scopes: z.array(z.string()),
  /** Anything the provider returns that we need later, e.g. Etsy's user_id. */
  extra: z.record(z.string(), z.string()).default({}),
})
export type TokenSet = z.infer<typeof TokenSetSchema>

const FileSchema = z.object({
  version: z.literal(1),
  /** Keyed by provider account, e.g. "ebay:sandbox", "ebay:production", "etsy". */
  accounts: z.record(z.string(), TokenSetSchema),
})
type TokenFile = z.infer<typeof FileSchema>

const EMPTY: TokenFile = { version: 1, accounts: {} }

function read(): TokenFile {
  ensureDataDir()
  if (!existsSync(TOKENS_FILE)) return structuredClone(EMPTY)
  // Both failure shapes — invalid JSON and a wrong schema — get the same
  // actionable message. A raw SyntaxError from a half-written file told the
  // user nothing about which file or what to do.
  let json: unknown
  try {
    json = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'))
  } catch {
    json = undefined
  }
  const parsed = FileSchema.safeParse(json)
  if (!parsed.success) {
    throw new UserError(
      `${TOKENS_FILE} is not readable as a token file.`,
      'Delete it and re-run `lister auth` for each marketplace.',
    )
  }
  return parsed.data
}

function write(file: TokenFile): void {
  ensureDataDir()
  // Per-pid temp name so two processes cannot truncate each other's staging file.
  const tmp = `${TOKENS_FILE}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
  replaceFile(tmp, TOKENS_FILE)
  try {
    chmodSync(TOKENS_FILE, 0o600)
  } catch {
    // Windows ACLs do not map onto POSIX modes; the file is still user-scoped.
  }
}

/**
 * Stores one account's tokens, leaving the others alone.
 *
 * Locked, and re-read inside the lock, because the failure mode here is not
 * merely an inconvenience: Etsy issues a new refresh token on every refresh and
 * spends the old one. If a concurrent process wrote this file back from a copy
 * it read earlier, the spent token would land on disk and the Etsy connection
 * would need fresh consent — triggered by an operation that never touched Etsy.
 */
export function save(account: string, tokens: TokenSet): void {
  withFileLock(TOKENS_FILE, () => {
    const file = read()
    file.accounts[account] = tokens
    write(file)
  })
}

export function load(account: string): TokenSet | undefined {
  return read().accounts[account]
}

export function forget(account: string): boolean {
  return withFileLock(TOKENS_FILE, () => {
    const file = read()
    if (!(account in file.accounts)) return false
    delete file.accounts[account]
    write(file)
    return true
  })
}

export function listAccounts(): string[] {
  return Object.keys(read().accounts)
}

/** Treat a token as expired slightly early, so it cannot lapse mid-request. */
const SKEW_MS = 60_000

export function isAccessExpired(tokens: TokenSet): boolean {
  return Date.now() + SKEW_MS >= tokens.accessExpiresAt
}

export function isRefreshExpired(tokens: TokenSet): boolean {
  if (tokens.refreshExpiresAt === null) return false
  return Date.now() >= tokens.refreshExpiresAt
}

/** Builds a TokenSet from a provider's `expires_in`-style response. */
export function fromExpiresIn(args: {
  accessToken: string
  refreshToken: string | null
  expiresInSeconds: number
  refreshExpiresInSeconds?: number | null
  scopes: string[]
  extra?: Record<string, string>
}): TokenSet {
  const now = Date.now()
  return {
    accessToken: args.accessToken,
    refreshToken: args.refreshToken,
    accessExpiresAt: now + args.expiresInSeconds * 1000,
    refreshExpiresAt:
      args.refreshExpiresInSeconds == null ? null : now + args.refreshExpiresInSeconds * 1000,
    scopes: args.scopes,
    extra: args.extra ?? {},
  }
}
