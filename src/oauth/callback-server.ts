import { createServer, type Server } from 'node:http'
import { createInterface } from 'node:readline/promises'
import { randomBytes, createHash } from 'node:crypto'
import open from 'open'
import { log, UserError } from '../util/log.js'

/**
 * The browser half of an OAuth authorization-code flow.
 *
 * Two capture modes, because the two marketplaces differ:
 *
 *   loopback — we listen on 127.0.0.1 and the provider redirects straight back.
 *              Etsy allows registering an http://localhost redirect URI.
 *
 *   paste    — the provider will only redirect to an https URL it has on file,
 *              so we cannot receive the callback. The user copies the URL from
 *              the browser address bar and pastes it in. eBay's RuName model
 *              needs this unless you host an https endpoint yourself.
 */

export interface AuthCodeResult {
  code: string
  /** Present on the loopback path; providers echo it back for CSRF checking. */
  state: string | null
}

const SUCCESS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Authorised</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #0f1115; color: #e6e6e6; }
  .card { text-align: center; padding: 2.5rem 3rem; border: 1px solid #2a2f3a;
          border-radius: 12px; background: #161a22; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; }
  p { margin: 0; color: #9aa3b2; }
</style>
<div class="card">
  <h1>Authorised</h1>
  <p>You can close this tab and return to the terminal.</p>
</div>`

const FAILURE_HTML = (reason: string) => `<!doctype html>
<meta charset="utf-8">
<title>Authorisation failed</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #0f1115; color: #e6e6e6; }
  .card { text-align: center; padding: 2.5rem 3rem; border: 1px solid #4a2a2a;
          border-radius: 12px; background: #221616; }
  h1 { margin: 0 0 .5rem; font-size: 1.25rem; color: #ff8f8f; }
  code { color: #9aa3b2; }
</style>
<div class="card">
  <h1>Authorisation failed</h1>
  <p><code>${reason.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</code></p>
</div>`

/** Cryptographically random `state`, to bind the callback to this request. */
export function newState(): string {
  return randomBytes(24).toString('base64url')
}

/** PKCE pair. `S256` is the only method Etsy accepts. */
export function newPkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes -> 43 base64url chars, inside RFC 7636's 43..128 range.
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/**
 * Starts a loopback listener, opens the browser, and resolves with the code.
 *
 * The server is bound before the browser opens so the redirect cannot arrive
 * at a closed port, and it is always torn down, including on error.
 */
export async function captureViaLoopback(args: {
  authorizeUrl: string
  /** Must match the redirect URI registered with the provider. */
  redirectUri: string
  expectedState: string
  timeoutMs?: number
}): Promise<AuthCodeResult> {
  const url = new URL(args.redirectUri)
  const port = Number(url.port || 80)
  const path = url.pathname

  // 15 minutes, not 5: the consent page may sit behind a login (password
  // manager, 2FA), and a run on 2026-08-16 timed out exactly that way. The
  // authorization code itself only lives seconds once granted, so a longer
  // wait costs nothing in security — the window being bounded at all is what
  // matters, and the process is interactive besides.
  const timeoutMs = args.timeoutMs ?? 15 * 60_000

  let server: Server | undefined

  try {
    const result = await new Promise<AuthCodeResult>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new UserError(
              `No browser callback arrived within ${timeoutMs / 60_000} minutes.`,
              'Run the auth command again and finish the consent in the freshly opened tab — ' +
                'an old tab belongs to the previous attempt and will be rejected.',
            ),
          ),
        timeoutMs,
      )

      server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (requestUrl.pathname !== path) {
          res.writeHead(404).end('Not found')
          return
        }

        const error = requestUrl.searchParams.get('error')
        const code = requestUrl.searchParams.get('code')
        const state = requestUrl.searchParams.get('state')

        if (error) {
          const description = requestUrl.searchParams.get('error_description') ?? error
          // A denial carrying a FOREIGN state belongs to an older attempt — a
          // stale tab where the user clicked "deny" long after starting over.
          // Answer it and keep waiting for this flow's real callback; only a
          // denial for THIS request (matching state, or none echoed) is fatal.
          if (state && state !== args.expectedState) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(
              FAILURE_HTML('This tab belongs to an earlier attempt — finish the flow in the newest tab.'),
            )
            return
          }
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(FAILURE_HTML(description))
          clearTimeout(timeout)
          reject(new UserError(`The marketplace refused authorisation: ${description}`))
          return
        }

        if (!code) {
          // Not a rejection: any stray request to this path — a health probe, a
          // prefetching extension — would otherwise abort the whole flow while
          // the user is still looking at the consent page. Answer and keep
          // waiting for the real callback; the timeout is the backstop.
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(FAILURE_HTML('No code in callback'))
          return
        }

        if (state !== args.expectedState) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(FAILURE_HTML('State mismatch'))
          clearTimeout(timeout)
          reject(
            new UserError(
              'The callback `state` did not match the one we sent — the response may not belong to this request.',
              'Run the auth command again. If it keeps happening, check for a stale browser tab completing an old flow.',
            ),
          )
          return
        }

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML)
        clearTimeout(timeout)
        resolve({ code, state })
      })

      server.on('error', (err) => {
        clearTimeout(timeout)
        reject(
          new UserError(
            `Could not listen on ${args.redirectUri}: ${(err as Error).message}`,
            `Port ${port} may be in use. Free it, or change the redirect URI (it must also be updated in the app's settings).`,
          ),
        )
      })

      server.listen(port, '127.0.0.1', () => {
        log.step('Opening your browser to authorise…')
        log.detail(`If it does not open, visit:\n  ${args.authorizeUrl}`)
        log.detail(`Waiting up to ${timeoutMs / 60_000} minutes for you to grant access.`)
        void open(args.authorizeUrl).catch(() => {
          log.warn('Could not launch a browser automatically — open the URL above by hand.')
        })
      })
    })

    return result
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  }
}

/**
 * Fallback for providers that will not redirect to localhost: open the browser,
 * let the user complete the flow, then have them paste the resulting URL.
 */
export async function captureViaPaste(args: {
  authorizeUrl: string
  expectedState: string | null
}): Promise<AuthCodeResult> {
  log.step('Opening your browser to authorise…')
  log.detail(`If it does not open, visit:\n  ${args.authorizeUrl}`)
  void open(args.authorizeUrl).catch(() => {
    log.warn('Could not launch a browser automatically — open the URL above by hand.')
  })

  log.blank()
  log.info('After you approve, the browser lands on a page that may show an error —')
  log.info('that is expected. Copy the full URL from the address bar and paste it here.')
  log.blank()

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question('Redirect URL: ')).trim()
    if (!answer) throw new UserError('No URL entered.')

    let parsed: URL
    try {
      parsed = new URL(answer)
    } catch {
      throw new UserError(`"${answer}" is not a URL.`, 'Paste the entire address, including the https:// prefix.')
    }

    const error = parsed.searchParams.get('error')
    if (error) {
      const description = parsed.searchParams.get('error_description') ?? error
      throw new UserError(`The marketplace refused authorisation: ${description}`)
    }

    const code = parsed.searchParams.get('code')
    if (!code) {
      throw new UserError(
        'That URL has no `code` parameter.',
        'Make sure you copied the address *after* approving, not the consent page itself.',
      )
    }

    const state = parsed.searchParams.get('state')
    if (args.expectedState !== null && state !== args.expectedState) {
      throw new UserError(
        'The `state` in that URL does not match the one we sent.',
        'Run the auth command again and paste the URL from that run.',
      )
    }

    return { code, state }
  } finally {
    rl.close()
  }
}
