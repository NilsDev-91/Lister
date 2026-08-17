import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Guards for a server that holds live marketplace credentials.
 *
 * "It only listens on localhost" is not a security boundary. Any page you visit
 * in a browser can send requests to `http://127.0.0.1:4321` — the browser will
 * happily do it, and it will attach cookies. Without a check, visiting the
 * wrong website while this server runs would be enough for that site to publish
 * a listing on your account. That is the attack this file exists to stop.
 *
 * Two independent gates, because either one alone has a gap:
 *
 *   - Origin/Host, which blocks the ordinary cross-site form POST but is absent
 *     on some legitimate requests and forgeable outside a browser.
 *   - A per-run secret token, which an attacker cannot read because the
 *     same-origin policy stops them reading our pages.
 */

/**
 * The response headers every page carries.
 *
 * `referrer-policy` is `same-origin` rather than the stricter-sounding
 * `no-referrer`, and the difference is load bearing: under `no-referrer` a
 * browser sends `Origin: null` on **same-origin form posts** too (Fetch
 * Standard, "Append a request Origin header"), which `checkOrigin` then
 * rejects — every button in the UI answers 403. `same-origin` keeps the real
 * Origin on our own posts while still sending no referrer to eBay, Etsy or
 * MakerWorld.
 *
 * This was a live regression, not a hypothetical: the header used to be
 * misspelled `referrerpolicy`, which browsers ignore. Correcting the spelling
 * activated a policy that broke every mutation in the app.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
}

/** Fresh for every server start; never written to disk. */
export function newSessionToken(): string {
  return randomBytes(24).toString('base64url')
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export const SESSION_COOKIE = 'lister_session'

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim()
      // A malformed %-sequence in a hostile cookie must read as "no valid
      // cookie" (403), not as a URIError that turns every POST into a 500.
      try {
        return decodeURIComponent(raw)
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

export interface GuardResult {
  ok: boolean
  reason?: string
}

/**
 * Checks that a state-changing request came from our own page.
 *
 * `null` and absent Origin are rejected rather than waved through: a missing
 * Origin is exactly what a hand-rolled request looks like, and every legitimate
 * request from our own UI carries one.
 */
/**
 * The three spellings of the loopback interface a browser may send.
 *
 * Accepting all three is not a loosening. The port must still match, the name
 * must still be one of these literals, and the session token is the gate that
 * actually stops a hostile page — a domain that resolves to 127.0.0.1 still
 * sends its own name as the Origin and is still rejected.
 *
 * Without this, opening the UI as `localhost:4321` instead of `127.0.0.1:4321`
 * makes every button fail with a 403 while every page still renders normally.
 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Splits `host:port`, tolerating the brackets IPv6 literals carry. */
function splitHost(hostWithPort: string): { name: string; port: string } {
  const colon = hostWithPort.lastIndexOf(':')
  if (colon === -1 || hostWithPort.endsWith(']')) return { name: hostWithPort, port: '' }
  return { name: hostWithPort.slice(0, colon), port: hostWithPort.slice(colon + 1) }
}

function isLoopbackEquivalent(host: string, expectedHost: string): boolean {
  const actual = splitHost(host)
  const expected = splitHost(expectedHost)
  if (actual.port !== expected.port) return false
  return LOOPBACK_NAMES.has(actual.name) && LOOPBACK_NAMES.has(expected.name)
}

export function checkOrigin(req: IncomingMessage, expectedHost: string): GuardResult {
  const origin = req.headers.origin
  if (!origin) {
    // No Origin at all. Same-origin form posts do send it in current browsers,
    // so treat its absence as suspicious rather than as an old-browser quirk.
    return { ok: false, reason: 'Request had no Origin header.' }
  }

  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return { ok: false, reason: `Origin "${origin}" is not a URL.` }
  }

  if (host !== expectedHost && !isLoopbackEquivalent(host, expectedHost)) {
    return { ok: false, reason: `Origin ${host} does not match ${expectedHost}.` }
  }
  return { ok: true }
}

/** Full gate for any request that changes state or spends money. */
export function guardMutation(
  req: IncomingMessage,
  expectedHost: string,
  sessionToken: string,
): GuardResult {
  const origin = checkOrigin(req, expectedHost)
  if (!origin.ok) return origin

  const supplied = readCookie(req, SESSION_COOKIE)
  if (!supplied) return { ok: false, reason: 'No session cookie.' }
  if (!tokensMatch(supplied, sessionToken)) return { ok: false, reason: 'Session token does not match.' }

  return { ok: true }
}
