import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./env-banner.mjs', import.meta.url))

const dirs = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'lister-banner-'))
  dirs.push(dir)
  return dir
}

function runBanner({ dotenv, tokens, rawStdin } = {}) {
  const cwd = tempDir()
  const dataDir = tempDir()
  if (dotenv) writeFileSync(join(cwd, '.env'), dotenv, 'utf8')
  if (tokens) writeFileSync(join(dataDir, 'tokens.json'), JSON.stringify(tokens), 'utf8')

  const env = { ...process.env, LISTER_DATA_DIR: dataDir }
  delete env.EBAY_ENV
  const input = rawStdin !== undefined ? rawStdin : JSON.stringify({ hook_event_name: 'SessionStart', cwd })
  return spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env })
}

describe('session banner', () => {
  it('emits SessionStart additionalContext naming environment and Etsy status', () => {
    const r = runBanner({ dotenv: 'EBAY_ENV=production\n' })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toMatch(/eBay environment: production/)
    expect(out.hookSpecificOutput.additionalContext).toMatch(/not connected/)
  })

  it('reports a stored, unexpired Etsy refresh token as connected', () => {
    const r = runBanner({
      tokens: {
        accounts: {
          etsy: { refreshToken: 'x', refreshExpiresAt: Date.now() + 86_400_000 },
        },
      },
    })
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/Etsy OAuth: connected/)
  })

  it('still banners (defaults) on broken stdin', () => {
    const r = runBanner({ rawStdin: '{ nope' })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/eBay environment: sandbox/)
  })
})
