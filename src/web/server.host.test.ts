import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

/**
 * The second face of the localhost-vs-127.0.0.1 origin lesson: the session
 * cookie lives on 127.0.0.1, so a tab on `localhost` rendered every page and
 * failed every button with "No session cookie". The server now canonicalises
 * GETs at the door — this boots the real server and proves it.
 *
 * Dynamic imports after LISTER_DATA_DIR is set, as everywhere: the store
 * freezes its path at module load.
 */

const dir = mkdtempSync(join(tmpdir(), 'lister-host-'))
const PORT = 43241
let close: (() => Promise<void>) | undefined

beforeAll(async () => {
  process.env['LISTER_DATA_DIR'] = dir
  const { startServer } = await import('./server.js')
  const handle = await startServer({ port: PORT, openBrowser: false })
  close = handle.close
})

afterAll(async () => {
  await close?.()
  delete process.env['LISTER_DATA_DIR']
  rmSync(dir, { recursive: true, force: true })
})

describe('host canonicalisation', () => {
  it('redirects a localhost GET onto 127.0.0.1, query included', async () => {
    const res = await fetch(`http://localhost:${PORT}/settings?kind=ok&msg=x`, { redirect: 'manual' })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(`http://127.0.0.1:${PORT}/settings?kind=ok&msg=x`)
  })

  it('serves the canonical host directly', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' })
    expect(res.status).toBe(200)
  })

  it('still refuses a localhost POST rather than redirecting it into a replay', async () => {
    // A 301 would turn the POST into a GET and a 307 would replay the body
    // across origins — refusal stays the right answer for mutations.
    const res = await fetch(`http://localhost:${PORT}/listing/x/images/1/remove`, {
      method: 'POST',
      redirect: 'manual',
    })
    expect(res.status).toBe(403)
  })
})

describe('the session token survives a restart', () => {
  it('hands the same token to a second server on the same data dir', async () => {
    // The regression this guards: a fresh token per run left every open tab
    // with a stale cookie, and the next button press — a publish, when this
    // was found — answered 403 while the page still rendered fine.
    const { startServer } = await import('./server.js')
    const tokenOf = (u: string): string => new URL(u).searchParams.get('token') ?? ''

    const first = await startServer({ port: PORT + 1, openBrowser: false })
    const firstToken = tokenOf(first.url)
    await first.close()

    const second = await startServer({ port: PORT + 1, openBrowser: false })
    const secondToken = tokenOf(second.url)
    await second.close()

    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(secondToken).toBe(firstToken)
  })
})
