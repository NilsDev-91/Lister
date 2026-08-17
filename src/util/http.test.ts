import { describe, it, expect } from 'vitest'
import { parseRetryAfter } from './http.js'

/**
 * RFC 7231 permits Retry-After in two forms, and the difference is not cosmetic:
 * `Number()` on the date form yields NaN, and `setTimeout(NaN)` fires
 * immediately — turning a back-off into a hot retry against a server that just
 * asked us to slow down.
 */
describe('parseRetryAfter', () => {
  const now = Date.parse('2026-08-12T10:00:00Z')

  it('reads the seconds form', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000)
    expect(parseRetryAfter('0', now)).toBe(0)
    expect(parseRetryAfter('  5  ', now)).toBe(5_000)
  })

  it('reads the HTTP-date form instead of producing NaN', () => {
    expect(parseRetryAfter('Wed, 12 Aug 2026 10:00:20 GMT', now)).toBe(20_000)
  })

  it('treats a date already in the past as no delay, never a negative one', () => {
    expect(parseRetryAfter('Wed, 12 Aug 2026 09:59:00 GMT', now)).toBe(0)
  })

  it('caps an absurd delay rather than hanging the CLI', () => {
    // A server asking for a day off should not block the process for a day.
    expect(parseRetryAfter('86400', now)).toBe(60_000)
    expect(parseRetryAfter('Thu, 13 Aug 2026 10:00:00 GMT', now)).toBe(60_000)
  })

  it('returns null for junk so the caller falls back to exponential backoff', () => {
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter('', now)).toBeNull()
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter('-5', now)).toBeNull()
  })

  it('never returns NaN, whatever it is given', () => {
    for (const input of ['', 'abc', '1.5', '-1', 'Wed, 99 Xxx 9999', '1e3']) {
      const result = parseRetryAfter(input, now)
      expect(Number.isNaN(result as number), `input ${JSON.stringify(input)}`).toBe(false)
    }
  })
})
