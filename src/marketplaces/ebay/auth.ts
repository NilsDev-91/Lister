import { config, type EbayEnv } from '../../config.js'
import { log, UserError } from '../../util/log.js'
import { captureViaPaste, newState } from '../../oauth/callback-server.js'
import {
  save,
  load,
  fromExpiresIn,
  isAccessExpired,
  isRefreshExpired,
  type TokenSet,
} from '../../oauth/tokens.js'

/**
 * eBay OAuth for the Sell APIs.
 *
 * Two things here are unlike every other OAuth 2 provider, and both are load
 * bearing:
 *
 *  1. `redirect_uri` is not a URL. It is an opaque "RuName" token minted in the
 *     developer portal, and the real HTTPS callback URL is configured *behind*
 *     it. The RuName goes in both the authorize request and the token exchange.
 *
 *  2. eBay refuses to register `localhost` or a private IP as the callback, so a
 *     desktop CLI cannot run a loopback listener the way it can for Etsy. We
 *     open the consent page and have the user paste back the redirected URL.
 *     The authorization code inside it is valid for only ~5 minutes.
 *
 * Scope strings always carry the literal `https://api.ebay.com/...` prefix even
 * when talking to the sandbox — they are identifiers, not endpoints.
 */

export const EBAY_HOSTS = {
  sandbox: {
    authorize: 'https://auth.sandbox.ebay.com/oauth2/authorize',
    token: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
    api: 'https://api.sandbox.ebay.com',
  },
  production: {
    authorize: 'https://auth.ebay.com/oauth2/authorize',
    token: 'https://api.ebay.com/identity/v1/oauth2/token',
    api: 'https://api.ebay.com',
  },
} as const satisfies Record<EbayEnv, { authorize: string; token: string; api: string }>

/**
 * Minimum set to create and publish a listing.
 * `sell.inventory` covers inventory items, offers, publish and locations;
 * `sell.account` covers business policies and the program opt-in.
 */
export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
] as const

function account(): string {
  return `ebay:${config.ebay.env}`
}

export function apiBase(): string {
  return EBAY_HOSTS[config.ebay.env].api
}

/** eBay authenticates the token endpoint with HTTP Basic, not a body parameter. */
function basicAuthHeader(): string {
  const encoded = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString('base64')
  return `Basic ${encoded}`
}

interface EbayTokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_token_expires_in?: number
  token_type: string
}

async function postToken(body: Record<string, string>): Promise<EbayTokenResponse> {
  const url = EBAY_HOSTS[config.ebay.env].token
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuthHeader(),
    },
    body: new URLSearchParams(body),
  })

  const text = await response.text()
  if (!response.ok) {
    // eBay returns {"error":"invalid_grant","error_description":"..."}
    let detail = text
    try {
      const parsed = JSON.parse(text) as { error?: string; error_description?: string }
      if (parsed.error) detail = `${parsed.error}: ${parsed.error_description ?? ''}`.trim()
    } catch {
      // Non-JSON body; the raw text is the best we have.
    }
    throw new UserError(
      `eBay token request failed (${response.status}): ${detail}`,
      text.includes('invalid_grant')
        ? 'Authorization codes expire about five minutes after consent. Run the command again and paste the URL promptly.'
        : 'Check that EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RUNAME all belong to the same environment as EBAY_ENV.',
    )
  }

  return JSON.parse(text) as EbayTokenResponse
}

function toTokenSet(response: EbayTokenResponse): TokenSet {
  return fromExpiresIn({
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? null,
    expiresInSeconds: response.expires_in,
    refreshExpiresInSeconds: response.refresh_token_expires_in ?? null,
    scopes: [...EBAY_SCOPES],
  })
}

/** Builds the consent URL. Exposed so the two-step flow can print it. */
export function buildAuthorizeUrl(state: string): string {
  const authorizeUrl = new URL(EBAY_HOSTS[config.ebay.env].authorize)
  authorizeUrl.searchParams.set('client_id', config.ebay.clientId)
  authorizeUrl.searchParams.set('response_type', 'code')
  // Not a URL — the RuName. eBay resolves it to the registered callback.
  authorizeUrl.searchParams.set('redirect_uri', config.ebay.ruName)
  authorizeUrl.searchParams.set('scope', EBAY_SCOPES.join(' '))
  authorizeUrl.searchParams.set('state', state)
  return authorizeUrl.toString()
}

/**
 * Runs the consent flow and stores the resulting user token.
 *
 * `redirectUrl` skips the browser and the prompt: pass the address eBay landed
 * you on and the code is taken straight from it. That makes the flow usable
 * where stdin is not a terminal, and it is the escape hatch when the
 * interactive paste misbehaves.
 */
export async function authorize(redirectUrl?: string): Promise<TokenSet> {
  const state = newState()

  let code: string
  if (redirectUrl) {
    let parsed: URL
    try {
      parsed = new URL(redirectUrl.trim())
    } catch {
      throw new UserError(`"${redirectUrl}" is not a URL.`, 'Paste the whole address, including https://')
    }
    const error = parsed.searchParams.get('error')
    if (error) {
      throw new UserError(
        `eBay refused authorisation: ${parsed.searchParams.get('error_description') ?? error}`,
      )
    }
    const fromUrl = parsed.searchParams.get('code')
    if (!fromUrl) {
      throw new UserError(
        'That URL carries no `code` parameter.',
        'Copy the address *after* approving, not the consent page itself.',
      )
    }
    // `state` is not checked here: the URL came from the user's own hands in a
    // separate step, so there is no in-flight request to bind it to.
    code = fromUrl
  } else {
    log.info(`Authorising against eBay ${config.ebay.env}.`)
    log.detail('eBay will not redirect to localhost, so this uses copy-and-paste rather than a local listener.')
    log.detail('The code expires about five minutes after you approve — paste promptly.')

    const captured = await captureViaPaste({
      authorizeUrl: buildAuthorizeUrl(state),
      expectedState: state,
    })
    code = captured.code
  }

  const response = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.ebay.ruName,
  })

  if (!response.refresh_token) {
    throw new UserError(
      'eBay returned no refresh token.',
      'This happens when the flow ran as a client-credentials grant. Check that the consent page actually appeared.',
    )
  }

  const tokens = toTokenSet(response)
  save(account(), tokens)
  return tokens
}

/**
 * Exchanges the refresh token for a new access token.
 *
 * Unlike Etsy, eBay does not rotate the refresh token: the same one stays valid
 * for ~18 months, and the refresh response usually omits it. We keep the stored
 * one in that case rather than nulling it out.
 */
async function refresh(tokens: TokenSet): Promise<TokenSet> {
  if (!tokens.refreshToken) {
    throw new UserError('No eBay refresh token stored.', 'Run `lister auth ebay`.')
  }
  if (isRefreshExpired(tokens)) {
    throw new UserError(
      'The eBay refresh token has expired (they last about 18 months).',
      'Run `lister auth ebay` to reconnect.',
    )
  }

  const response = await postToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    scope: EBAY_SCOPES.join(' '),
  })

  const next: TokenSet = {
    ...toTokenSet(response),
    // Preserve the long-lived refresh token and its expiry when eBay omits them.
    refreshToken: response.refresh_token ?? tokens.refreshToken,
    refreshExpiresAt:
      response.refresh_token_expires_in != null
        ? Date.now() + response.refresh_token_expires_in * 1000
        : tokens.refreshExpiresAt,
  }

  save(account(), next)
  return next
}

/** Returns a valid user access token, refreshing transparently when needed. */
export async function getUserToken(): Promise<string> {
  const tokens = load(account())
  if (!tokens) {
    throw new UserError(
      `Not connected to eBay (${config.ebay.env}).`,
      'Run `lister auth ebay` first.',
    )
  }
  if (!isAccessExpired(tokens)) return tokens.accessToken

  log.detail('eBay access token expired — refreshing.')
  const next = await refresh(tokens)
  return next.accessToken
}

/**
 * Mints an application token via client credentials.
 *
 * The public metadata APIs — Taxonomy in particular, which we need for category
 * suggestions and item aspects — accept this and need no user consent. It is
 * cheap to mint and not worth persisting, so it is cached in memory only.
 */
let appTokenCache: { token: string; expiresAt: number } | undefined

export async function getAppToken(): Promise<string> {
  if (appTokenCache && Date.now() + 60_000 < appTokenCache.expiresAt) {
    return appTokenCache.token
  }

  const response = await postToken({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  })

  appTokenCache = {
    token: response.access_token,
    expiresAt: Date.now() + response.expires_in * 1000,
  }
  return appTokenCache.token
}

export function storedTokens(): TokenSet | undefined {
  return load(account())
}

export const EBAY_ACCOUNT = account
