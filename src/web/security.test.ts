import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  checkOrigin,
  guardMutation,
  readCookie,
  tokensMatch,
  newSessionToken,
  SECURITY_HEADERS,
  SESSION_COOKIE,
} from './security.js'

/**
 * These tests describe an attack, not a formality.
 *
 * The server holds live eBay and Etsy tokens and can publish listings, which
 * costs money. Any website the user visits can send a request to
 * 127.0.0.1 — binding to localhost prevents nothing. If these gates regress,
 * a visited page could publish on the user's account.
 */

const HOST = '127.0.0.1:4321'

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('security headers', () => {
  it('never sets referrer-policy to no-referrer, which would null our own Origin', () => {
    // A live regression, caught in the browser: under `no-referrer` a browser
    // sends `Origin: null` on same-origin form posts as well (Fetch Standard,
    // "Append a request Origin header"). `checkOrigin` then rejects it, and
    // every button in the UI answers 403 while every page still renders.
    expect(SECURITY_HEADERS['referrer-policy']).toBe('same-origin')
  })

  it('spells the header the way HTTP does, not the way the HTML attribute does', () => {
    // `referrerpolicy` is the attribute; as a header name it is inert, which is
    // how the wrong policy above went unnoticed in the first place.
    expect(Object.keys(SECURITY_HEADERS)).toContain('referrer-policy')
    expect(Object.keys(SECURITY_HEADERS)).not.toContain('referrerpolicy')
  })

  it('keeps the framing and sniffing guards', () => {
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY')
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff')
  })
})

describe('checkOrigin', () => {
  it('accepts our own origin', () => {
    expect(checkOrigin(req({ origin: `http://${HOST}` }), HOST).ok).toBe(true)
  })

  it('rejects the literal "null" origin a no-referrer policy produces', () => {
    // The string "null" is what the browser actually sends; it is not a URL and
    // must not be waved through just because it came from our own page.
    expect(checkOrigin(req({ origin: 'null' }), HOST).ok).toBe(false)
  })

  it('rejects a different site — the cross-site POST this exists to stop', () => {
    const result = checkOrigin(req({ origin: 'https://evil.example' }), HOST)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/does not match/)
  })

  it('rejects a missing Origin rather than assuming good faith', () => {
    // A hand-rolled request is exactly what has no Origin.
    expect(checkOrigin(req({}), HOST).ok).toBe(false)
  })

  it('rejects a lookalike host', () => {
    expect(checkOrigin(req({ origin: 'http://127.0.0.1:4321.evil.example' }), HOST).ok).toBe(false)
    expect(checkOrigin(req({ origin: 'http://127.0.0.1:9999' }), HOST).ok).toBe(false)
  })

  it('accepts the other spellings of the same loopback interface', () => {
    // Opening the UI as localhost rather than 127.0.0.1 used to render every
    // page correctly and 403 every button.
    expect(checkOrigin(req({ origin: 'http://localhost:4321' }), HOST).ok).toBe(true)
    expect(checkOrigin(req({ origin: 'http://[::1]:4321' }), HOST).ok).toBe(true)
    expect(checkOrigin(req({ origin: 'http://127.0.0.1:4321' }), 'localhost:4321').ok).toBe(true)
  })

  it('still requires the port to match on a loopback alias', () => {
    expect(checkOrigin(req({ origin: 'http://localhost:9999' }), HOST).ok).toBe(false)
  })

  it('does not accept a hostile domain that merely resolves to loopback', () => {
    // DNS rebinding sends the attacker's own name in the Origin, which is not
    // one of the three loopback literals.
    expect(checkOrigin(req({ origin: 'http://localhost.evil.example:4321' }), HOST).ok).toBe(false)
    expect(checkOrigin(req({ origin: 'http://evil.example:4321' }), HOST).ok).toBe(false)
  })

  it('rejects a malformed Origin', () => {
    expect(checkOrigin(req({ origin: 'not a url' }), HOST).ok).toBe(false)
  })
})

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    const r = req({ cookie: `other=1; ${SESSION_COOKIE}=abc123; last=2` })
    expect(readCookie(r, SESSION_COOKIE)).toBe('abc123')
  })

  it('is absent rather than wrong when there are no cookies', () => {
    expect(readCookie(req({}), SESSION_COOKIE)).toBeUndefined()
  })

  it('does not match a cookie whose name merely ends with the one sought', () => {
    const r = req({ cookie: `not_${SESSION_COOKIE}=wrong` })
    expect(readCookie(r, SESSION_COOKIE)).toBeUndefined()
  })
})

describe('tokensMatch', () => {
  it('accepts an identical token and rejects anything else', () => {
    const token = newSessionToken()
    expect(tokensMatch(token, token)).toBe(true)
    expect(tokensMatch(token, newSessionToken())).toBe(false)
    expect(tokensMatch(token, token.slice(0, -1))).toBe(false)
    expect(tokensMatch('', token)).toBe(false)
  })

  it('produces tokens long enough not to be guessable', () => {
    expect(newSessionToken().length).toBeGreaterThanOrEqual(32)
    expect(newSessionToken()).not.toBe(newSessionToken())
  })
})

describe('guardMutation', () => {
  const token = newSessionToken()

  it('allows a request from our page carrying the session cookie', () => {
    const r = req({ origin: `http://${HOST}`, cookie: `${SESSION_COOKIE}=${token}` })
    expect(guardMutation(r, HOST, token).ok).toBe(true)
  })

  it('blocks a cross-site request even when it carries the cookie', () => {
    // The browser would attach the cookie automatically — the Origin check is
    // what stops this.
    const r = req({ origin: 'https://evil.example', cookie: `${SESSION_COOKIE}=${token}` })
    expect(guardMutation(r, HOST, token).ok).toBe(false)
  })

  it('blocks a same-origin request without the token', () => {
    // Belt and braces: if the Origin check is ever fooled, the token still stops it.
    const r = req({ origin: `http://${HOST}` })
    expect(guardMutation(r, HOST, token).ok).toBe(false)
  })

  it('blocks a wrong token', () => {
    const r = req({ origin: `http://${HOST}`, cookie: `${SESSION_COOKIE}=${newSessionToken()}` })
    expect(guardMutation(r, HOST, token).ok).toBe(false)
  })
})
