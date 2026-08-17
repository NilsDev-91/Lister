import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'

/**
 * The guard is tested over its real interface — JSON on stdin, verdict via
 * exit code and stderr — because that is the contract Claude Code holds it
 * to. Every case runs the actual script in a child process.
 *
 * The event's cwd points at a throwaway directory with a controlled .env, so
 * the repo's real .env can never influence a verdict; EBAY_ENV is stripped
 * from the child's environment for the same reason.
 */

const SCRIPT = fileURLToPath(new URL('./guard-publish.mjs', import.meta.url))

const dirs = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function runGuard(command, { dotenv, env = {}, rawStdin } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lister-guard-'))
  dirs.push(dir)
  if (dotenv) writeFileSync(join(dir, '.env'), dotenv, 'utf8')

  const childEnv = { ...process.env, ...env }
  delete childEnv.EBAY_ENV
  for (const [key, value] of Object.entries(env)) childEnv[key] = value

  const input =
    rawStdin !== undefined
      ? rawStdin
      : JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir })
  return spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: childEnv })
}

const SANDBOX = 'EBAY_ENV=sandbox\n'
const PRODUCTION = 'EBAY_ENV=production\n'

describe('publish guard — marketplace scope (Bug 1)', () => {
  it('blocks an Etsy publish without --draft even in the eBay sandbox', () => {
    const r = runGuard('npx tsx src/cli.ts publish mw-1 -M etsy --yes', { dotenv: SANDBOX })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/Etsy has no sandbox/)
  })

  it('allows an eBay-only publish without --draft in the sandbox', () => {
    const r = runGuard('npx tsx src/cli.ts publish mw-1 -M ebay --yes', { dotenv: SANDBOX })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('blocks an eBay-only publish without --draft in production', () => {
    const r = runGuard('npx tsx src/cli.ts publish mw-1 -M ebay --yes', { dotenv: PRODUCTION })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/EBAY_ENV is not "sandbox"/)
  })

  it('blocks a flagless publish in the sandbox — the CLI default is BOTH marketplaces', () => {
    const r = runGuard('npx tsx src/cli.ts publish mw-1 --yes', { dotenv: SANDBOX })
    expect(r.status).toBe(2)
  })

  it('understands the long form and the = form', () => {
    expect(runGuard('lister publish mw-1 --marketplace ebay', { dotenv: SANDBOX }).status).toBe(0)
    expect(runGuard('lister publish mw-1 --marketplace=ebay', { dotenv: SANDBOX }).status).toBe(0)
    expect(runGuard('lister publish mw-1 --marketplace etsy', { dotenv: SANDBOX }).status).toBe(2)
  })

  it('blocks when eBay and Etsy are both named', () => {
    const r = runGuard('lister publish mw-1 -M ebay etsy', { dotenv: SANDBOX })
    expect(r.status).toBe(2)
  })

  it('treats an empty -M flag as not eBay-only (fail closed)', () => {
    const r = runGuard('lister publish mw-1 -M --yes', { dotenv: SANDBOX })
    expect(r.status).toBe(2)
  })
})

describe('publish guard — entry points (Bug 2)', () => {
  const entryPoints = [
    'lister publish mw-1 -M ebay',
    'npx tsx src/cli.ts publish mw-1 -M ebay',
    'node dist/cli.js publish mw-1 -M ebay',
    'npm run dev -- publish mw-1 -M ebay',
  ]

  for (const cmd of entryPoints) {
    it(`recognises: ${cmd}`, () => {
      // Production makes even the eBay-only form blockable, proving the
      // entry point itself was detected.
      expect(runGuard(cmd, { dotenv: PRODUCTION }).status).toBe(2)
      expect(runGuard(`${cmd} --draft`, { dotenv: PRODUCTION }).status).toBe(0)
    })
  }

  it('always allows --draft, whatever the marketplace or environment', () => {
    expect(runGuard('lister publish mw-1 -M etsy --draft', { dotenv: SANDBOX }).status).toBe(0)
    expect(runGuard('npm run dev -- publish mw-1 --draft', { dotenv: PRODUCTION }).status).toBe(0)
  })

  it('leaves publish in foreign contexts alone', () => {
    expect(runGuard('npm publish', { dotenv: PRODUCTION }).status).toBe(0)
    expect(runGuard('npm test', { dotenv: PRODUCTION }).status).toBe(0)
    expect(runGuard('git status', { dotenv: PRODUCTION }).status).toBe(0)
  })

  it('leaves the revise path alone — that is the intended way to touch live listings', () => {
    expect(runGuard('npx tsx src/cli.ts revise mw-1 -M ebay --yes', { dotenv: PRODUCTION }).status).toBe(0)
  })
})

describe('publish guard — environment resolution', () => {
  it('lets an inline EBAY_ENV override beat a sandbox .env', () => {
    const r = runGuard('EBAY_ENV=production npx tsx src/cli.ts publish mw-1 -M ebay --yes', {
      dotenv: SANDBOX,
    })
    expect(r.status).toBe(2)
  })

  it('lets the process environment beat the .env file, like config.ts does', () => {
    const r = runGuard('lister publish mw-1 -M ebay', {
      dotenv: SANDBOX,
      env: { EBAY_ENV: 'production' },
    })
    expect(r.status).toBe(2)
  })

  it('defaults to sandbox when nothing sets EBAY_ENV', () => {
    expect(runGuard('lister publish mw-1 -M ebay').status).toBe(0)
  })
})

describe('end/relist guard', () => {
  it('blocks Trading API end and relist calls, including the Request/Response spellings', () => {
    for (const cmd of [
      'curl -X POST https://api.ebay.com/ws/api.dll -d "<EndItemRequest>..."',
      'curl -d "<RelistFixedPriceItemRequest/>" https://api.ebay.com/ws/api.dll',
      'some-tool RelistItem --item 123',
    ]) {
      expect(runGuard(cmd, { dotenv: SANDBOX }).status).toBe(2)
    }
  })

  it('blocks an offer withdraw', () => {
    const r = runGuard('curl -X POST .../sell/inventory/v1/offer/123/withdraw', { dotenv: SANDBOX })
    expect(r.status).toBe(2)
  })
})

describe('robustness', () => {
  it('fails open on broken stdin', () => {
    expect(runGuard('', { rawStdin: '{ this is not json' }).status).toBe(0)
  })

  it('fails open on empty stdin', () => {
    expect(runGuard('', { rawStdin: '' }).status).toBe(0)
  })

  it('ignores events without a command', () => {
    expect(runGuard('', { rawStdin: JSON.stringify({ tool_name: 'Bash', tool_input: {} }) }).status).toBe(0)
  })
})
