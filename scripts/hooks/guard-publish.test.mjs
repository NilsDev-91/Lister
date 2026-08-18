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

describe('raw eBay publish endpoints', () => {
  const publishCalls = [
    'curl -X POST https://HOST/sell/inventory/v1/offer/8527/publish -H "Authorization: Bearer $T"',
    'curl -X POST https://HOST/sell/inventory/v1/offer/publish_by_inventory_item_group -d "{\\"inventoryItemGroupKey\\":\\"WW-MOOS-40\\"}"',
  ]

  for (const template of publishCalls) {
    it(`blocks against production: ${template.slice(0, 60)}…`, () => {
      const r = runGuard(template.replace('HOST', 'api.ebay.com'), { dotenv: SANDBOX })
      expect(r.status).toBe(2)
      expect(r.stderr).toMatch(/eBay publish endpoint/)
    })

    it(`allows the same call against the sandbox host`, () => {
      const r = runGuard(template.replace('HOST', 'api.sandbox.ebay.com'), { dotenv: SANDBOX })
      expect(r.status).toBe(0)
    })
  }

  it('blocks a publish path whose host is a variable — fail closed on the money side', () => {
    const r = runGuard('curl -X POST "$EBAY_API/sell/inventory/v1/offer/8527/publish"', {
      dotenv: SANDBOX,
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/without a recognisable sandbox host/)
  })

  it('leaves the free Inventory API neighbours alone, production host included', () => {
    for (const cmd of [
      // createOffer — drafting, no fee (research §5: fees land at publishOffer)
      'curl -X POST https://api.ebay.com/sell/inventory/v1/offer -d @offer.json',
      // full-replace item and group PUTs — drafting
      'curl -X PUT https://api.ebay.com/sell/inventory/v1/inventory_item/WW-MOOS-40-SW -d @item.json',
      'curl -X PUT https://api.ebay.com/sell/inventory/v1/inventory_item_group/WW-MOOS-40 -d @group.json',
      // reads
      'curl https://api.ebay.com/sell/inventory/v1/offer/8527',
      'curl "https://api.ebay.com/commerce/taxonomy/v1/category_tree/77/get_item_aspects_for_category?category_id=261636"',
    ]) {
      expect(runGuard(cmd, { dotenv: SANDBOX }).status, cmd).toBe(0)
    }
  })
})

describe('raw Etsy activation', () => {
  it('blocks state=active regardless of EBAY_ENV — Etsy has no sandbox', () => {
    for (const cmd of [
      'curl -X PATCH https://api.etsy.com/v3/application/shops/1/listings/2 --data-urlencode "state=active"',
      'curl -X PATCH https://openapi.etsy.com/v3/application/shops/1/listings/2 -d \'{"state":"active"}\'',
    ]) {
      const r = runGuard(cmd, { dotenv: SANDBOX })
      expect(r.status, cmd).toBe(2)
      expect(r.stderr).toMatch(/billable moment/)
    }
  })

  it('leaves the free Etsy neighbours alone', () => {
    for (const cmd of [
      // createDraftListing — free (research §9: the fee lands on activation)
      'curl -X POST https://api.etsy.com/v3/application/shops/1/listings --data-urlencode "title=Moss Pole" --data-urlencode "quantity=4"',
      // content update on a draft — free
      'curl -X PATCH https://api.etsy.com/v3/application/shops/1/listings/2 --data-urlencode "title=Better Title"',
      // reads
      'curl "https://api.etsy.com/v3/application/listings/active?keywords=moss+pole"',
      // deactivation is not activation
      'curl -X PATCH https://api.etsy.com/v3/application/shops/1/listings/2 --data-urlencode "state=inactive"',
    ]) {
      expect(runGuard(cmd, { dotenv: SANDBOX }).status, cmd).toBe(0)
    }
  })

  it('ignores state=active without any Etsy context', () => {
    expect(runGuard('systemctl set-property foo state=active', { dotenv: SANDBOX }).status).toBe(0)
  })
})

describe('lookalikes in strings and comments', () => {
  // The guard reads command strings, not intent — it cannot parse shell
  // semantics to tell a request from a quoted mention. The line it draws:
  // the PATH form (`/offer/{id}/publish`) and the literal endpoint name
  // (`publish_by_inventory_item_group`) block wherever they appear, even
  // inside a commit message. That is the right side of the error for a money
  // guard: the cheap failure is rephrasing a message, the expensive one is a
  // listing fee. Looser mentions without the path form pass.

  it('blocks the endpoint path form even inside a quoted string — fail closed, by design', () => {
    const r = runGuard(
      'git commit -m "fix: retry /offer/123/publish call against api.ebay.com"',
      { dotenv: SANDBOX },
    )
    expect(r.status).toBe(2)
  })

  it('passes a colloquial mention that lacks the path form', () => {
    const r = runGuard('git commit -m "guard: block offer publish calls on ebay"', {
      dotenv: SANDBOX,
    })
    expect(r.status).toBe(0)
  })
})

describe('per-segment evaluation — no cross-segment whitewashing', () => {
  it('a --draft in the first command does not cover a second publish behind &&', () => {
    const r = runGuard('lister publish A --draft && lister publish B -M ebay', {
      dotenv: PRODUCTION,
    })
    expect(r.status).toBe(2)
  })

  it('a -M ebay in the first command does not cover a flagless publish behind ;', () => {
    const r = runGuard('lister publish A -M ebay; lister publish B', { dotenv: SANDBOX })
    expect(r.status).toBe(2)
  })

  it('both segments guarded individually still pass when each is safe', () => {
    const r = runGuard('lister publish A -M ebay --draft && lister publish B -M ebay --draft', {
      dotenv: PRODUCTION,
    })
    expect(r.status).toBe(0)
  })

  it('an Etsy host in one segment does not condemn an unrelated state=active in another', () => {
    const r = runGuard('curl https://api.etsy.com/v3/application/listings/1 && systemctl set-property foo state=active', {
      dotenv: SANDBOX,
    })
    expect(r.status).toBe(0)
  })

  it('newlines separate segments too — a --draft on line one covers nothing on line two', () => {
    const r = runGuard('lister publish A --draft\nlister publish B -M ebay', { dotenv: PRODUCTION })
    expect(r.status).toBe(2)
  })

  it('newlines also stop cross-line condemnation of unrelated commands', () => {
    const r = runGuard(
      'curl https://api.etsy.com/v3/application/listings/1\nsystemctl set-property foo state=active',
      { dotenv: SANDBOX },
    )
    expect(r.status).toBe(0)
  })

  it('an inline EBAY_ENV=sandbox cannot whitewash a production .env', () => {
    // The guard cannot model which segment an export reaches, so ANY
    // non-sandbox source makes the line count as production — fail closed.
    const r = runGuard('EBAY_ENV=sandbox true && lister publish x -M ebay', {
      dotenv: PRODUCTION,
    })
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
