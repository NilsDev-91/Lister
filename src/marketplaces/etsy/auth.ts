import { config } from '../../config.js'
import { log, UserError } from '../../util/log.js'
import {
  captureViaLoopback,
  newPkcePair,
  newState,
} from '../../oauth/callback-server.js'
import {
  save,
  load,
  fromExpiresIn,
  isAccessExpired,
  isRefreshExpired,
  type TokenSet,
} from '../../oauth/tokens.js'

/**
 * Etsy Open API v3 authentication.
 *
 * Two credentials, used in two different places — this is the API's sharpest
 * edge and the cause of most 403s:
 *
 *   x-api-key: "<keystring>:<shared_secret>"   on every /v3/application call
 *   client_id: "<keystring>"                   in the OAuth flow (bare, no secret)
 *
 * PKCE replaces the client secret in the token exchange, so the token endpoint
 * takes neither an x-api-key nor a secret.
 */

const ACCOUNT = 'etsy'

export const ETSY_AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect'
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token'
export const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

/**
 * `listings_r` is included so the tool can read back its own drafts and stay
 * idempotent. `shops_w` is deliberately absent — it only covers editing the
 * shop description, which this tool never does.
 */
export const ETSY_SCOPES = ['listings_r', 'listings_w', 'shops_r'] as const

/** The header every /v3/application request needs, secret included. */
export function apiKeyHeader(): string {
  return `${config.etsy.keystring}:${config.etsy.sharedSecret}`
}

interface EtsyTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope?: string
}

async function postToken(body: Record<string, string>): Promise<EtsyTokenResponse> {
  const response = await fetch(ETSY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new UserError(
      `Etsy token request failed (${response.status}): ${text}`,
      response.status === 400
        ? 'A 400 here usually means the redirect_uri did not match the one registered on the app, or the code was already used.'
        : undefined,
    )
  }

  return JSON.parse(text) as EtsyTokenResponse
}

/**
 * Etsy embeds the user id in the token: "12345678.<random>". Parsing it saves a
 * round trip, but we still call getMe for the shop id.
 */
function userIdFromToken(accessToken: string): string | null {
  const prefix = accessToken.split('.')[0]
  return prefix && /^\d+$/.test(prefix) ? prefix : null
}

function toTokenSet(response: EtsyTokenResponse, extra: Record<string, string> = {}): TokenSet {
  const userId = userIdFromToken(response.access_token)
  return fromExpiresIn({
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresInSeconds: response.expires_in,
    // Etsy refresh tokens are valid 90 days and rotate on every use.
    refreshExpiresInSeconds: 90 * 24 * 60 * 60,
    scopes: response.scope ? response.scope.split(' ') : [...ETSY_SCOPES],
    extra: { ...(userId ? { userId } : {}), ...extra },
  })
}

/** Runs the full browser consent flow and stores the resulting tokens. */
export async function authorize(): Promise<TokenSet> {
  const state = newState()
  const { verifier, challenge } = newPkcePair()

  const authorizeUrl = new URL(ETSY_AUTHORIZE_URL)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', config.etsy.keystring)
  authorizeUrl.searchParams.set('redirect_uri', config.etsy.redirectUri)
  authorizeUrl.searchParams.set('scope', ETSY_SCOPES.join(' '))
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')

  const { code } = await captureViaLoopback({
    authorizeUrl: authorizeUrl.toString(),
    redirectUri: config.etsy.redirectUri,
    expectedState: state,
  })

  const response = await postToken({
    grant_type: 'authorization_code',
    client_id: config.etsy.keystring,
    redirect_uri: config.etsy.redirectUri,
    code,
    code_verifier: verifier,
  })

  const granted = response.scope ? response.scope.split(' ') : []
  const missing = ETSY_SCOPES.filter((s) => granted.length > 0 && !granted.includes(s))
  if (missing.length) {
    log.warn(`Etsy granted fewer scopes than requested; missing: ${missing.join(', ')}`)
  }

  const tokens = toTokenSet(response)
  save(ACCOUNT, tokens)
  return tokens
}

/**
 * Refreshes the access token.
 *
 * Etsy rotates the refresh token on every use: the response carries a *new*
 * one and the old is spent. `save` writes atomically (temp file + rename), so a
 * crash mid-write cannot leave a half-written file — but if the process dies
 * after Etsy has rotated and before we persist, the stored token is dead and
 * the user has to re-consent. That is inherent to rotation; we keep the window
 * as small as possible by saving immediately.
 */
async function refresh(tokens: TokenSet): Promise<TokenSet> {
  if (!tokens.refreshToken) {
    throw new UserError('No Etsy refresh token stored.', 'Run `lister auth etsy`.')
  }
  if (isRefreshExpired(tokens)) {
    throw new UserError(
      'The Etsy refresh token has expired (they last 90 days).',
      'Run `lister auth etsy` to reconnect.',
    )
  }

  let response: EtsyTokenResponse
  try {
    response = await postToken({
      grant_type: 'refresh_token',
      client_id: config.etsy.keystring,
      refresh_token: tokens.refreshToken,
    })
  } catch (error) {
    // The refresh token rotates on every use, so a concurrent process may have
    // spent this one moments ago — in which case a perfectly good replacement
    // is already on disk. Re-reading before demanding a fresh consent turns a
    // lost race into a retry instead of a burned connection.
    const stored = load(ACCOUNT)
    if (stored && stored.refreshToken && stored.refreshToken !== tokens.refreshToken) {
      if (!isAccessExpired(stored)) return stored
      return refresh(stored)
    }
    throw error
  }

  const next = toTokenSet(response, tokens.extra)
  save(ACCOUNT, next)
  return next
}

/** Returns a valid access token, refreshing transparently when needed. */
export async function getAccessToken(): Promise<string> {
  const tokens = load(ACCOUNT)
  if (!tokens) {
    throw new UserError('Not connected to Etsy.', 'Run `lister auth etsy` first.')
  }
  if (!isAccessExpired(tokens)) return tokens.accessToken

  log.detail('Etsy access token expired — refreshing.')
  const next = await refresh(tokens)
  return next.accessToken
}

export function storedTokens(): TokenSet | undefined {
  return load(ACCOUNT)
}

export const ETSY_ACCOUNT = ACCOUNT
