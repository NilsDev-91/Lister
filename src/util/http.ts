import { UserError } from './log.js'

/**
 * A minimal request gate: serialises calls to one host and keeps them under a
 * requests-per-second ceiling. Etsy caps at 10 QPS and returns 429 beyond it,
 * which for image uploads is easy to trip if you fire them in parallel.
 */
export class RateLimiter {
  #minIntervalMs: number
  #tail: Promise<void> = Promise.resolve()
  #lastStart = 0

  constructor(requestsPerSecond: number) {
    this.#minIntervalMs = 1000 / requestsPerSecond
  }

  /** Runs `fn` once the gate allows it. Calls execute in the order queued. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      const wait = this.#lastStart + this.#minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.#lastStart = Date.now()
      return fn()
    })
    // Keep the chain alive even when a call rejects, or the limiter deadlocks.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface ApiErrorDetail {
  status: number
  body: string
  url: string
}

export class ApiError extends Error {
  readonly status: number
  readonly body: string
  readonly url: string

  constructor(message: string, detail: ApiErrorDetail) {
    super(message)
    this.name = 'ApiError'
    this.status = detail.status
    this.body = detail.body
    this.url = detail.url
  }
}

/** 429 and 5xx are worth retrying; 4xx means the request itself is wrong. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

export interface RequestOptions extends RequestInit {
  /** Attempts including the first. */
  maxAttempts?: number
  /** Called before each retry, for progress output. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void
  /** Per-attempt ceiling. Node's fetch has no default, so a stalled socket hangs forever. */
  timeoutMs?: number
}

/** Longest we will honour a Retry-After. Beyond this, failing is kinder than hanging. */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Parses Retry-After, which RFC 7231 allows to be either a seconds count or an
 * HTTP-date. `Number()` on a date yields NaN, and `setTimeout(NaN)` fires
 * immediately — turning a back-off into a hot retry loop against a server that
 * just asked us to slow down. Returns null when the header is unusable.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null

  // Seconds form: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS)
  }

  // HTTP-date form. Every RFC 7231 date shape — IMF-fixdate, RFC 850, asctime —
  // begins with a weekday name, so require one. Date.parse alone is far too
  // permissive: it reads "-5" as a date in 2001, which would then look like a
  // delay in the past and trigger an immediate retry.
  if (!/^[A-Za-z]{3,9},?\s/.test(trimmed)) return null

  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS)
}

/**
 * fetch with bounded retry and a readable error.
 *
 * Honours `Retry-After` when the server sends it; otherwise backs off
 * exponentially with jitter so parallel callers do not resynchronise.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const { maxAttempts = 4, onRetry, timeoutMs = 60_000, ...init } = options
  let lastError: ApiError | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response
    // A fresh controller per attempt: an aborted one stays aborted.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      response = await fetch(url, { ...init, signal: init.signal ?? controller.signal })
    } catch (cause) {
      const aborted = (cause as Error).name === 'AbortError'
      // Network-level failure: no status, always worth one more try.
      lastError = new ApiError(
        aborted
          ? `Timed out after ${timeoutMs}ms calling ${url}`
          : `Network error calling ${url}: ${(cause as Error).message}`,
        { status: 0, body: '', url },
      )
      if (attempt === maxAttempts) break
      const delay = backoff(attempt)
      onRetry?.(attempt, delay, aborted ? 'timeout' : (cause as Error).message)
      await sleep(delay)
      continue
    } finally {
      // Stop the clock once headers are in. The body is read below and can be
      // large (a 1.7 MB page, an image), so it should not share the deadline —
      // and leaving the timer armed would abort a perfectly healthy download.
      clearTimeout(timer)
    }

    if (response.ok) return response

    const body = await response.text()
    lastError = new ApiError(`${response.status} from ${url}: ${truncate(body, 600)}`, {
      status: response.status,
      body,
      url,
    })

    if (!isRetryable(response.status) || attempt === maxAttempts) break

    const delay = parseRetryAfter(response.headers.get('retry-after')) ?? backoff(attempt)
    onRetry?.(attempt, delay, `HTTP ${response.status}`)
    await sleep(delay)
  }

  throw lastError ?? new Error(`Request to ${url} failed for an unknown reason`)
}

function backoff(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 16_000)
  return base + Math.random() * 250
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (${s.length} bytes total)`
}

/** Turns an ApiError into something a user can act on. */
export function explain(error: unknown, context: string): never {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      throw new UserError(`${context}: not authorised (401).`, 'Your token may have expired — re-run the auth command.')
    }
    if (error.status === 403) {
      throw new UserError(
        `${context}: forbidden (403).\n${truncate(error.body, 400)}`,
        'Check that the app has the required scopes and that credentials are complete.',
      )
    }
    throw new UserError(`${context}: ${error.message}`)
  }
  throw error
}
