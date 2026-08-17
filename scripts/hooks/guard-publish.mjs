// PreToolUse hook (matcher: Bash). Blocks the two commands that cost real
// money or destroy a live listing's history; lets everything else through.
//
// Exit 2 + stderr = Claude Code blocks the tool call and shows the reason.
// Exit 0 silently = normal permission flow continues.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// BOM-tolerant, and fail-open on unparseable input: a guard that blocked every
// Bash call after an event-format change would be worse than no guard.
let event
try {
  event = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''))
} catch {
  process.exit(0)
}
const command = String(event?.tool_input?.command ?? '')
if (!command) process.exit(0)

const cwd = event?.cwd ?? process.cwd()

/**
 * eBay end+relist destroys the item ID, watchers, sale history and search
 * standing — this repo updates live listings in place (`lister revise`).
 * The lister CLI has no end/relist command, so anything matching here is a
 * raw API call (Trading `EndItem`/`RelistItem`, Inventory `withdraw`).
 */
// No trailing \b: the Trading API spells these `EndItemRequest`,
// `RelistItemResponse` etc., and the suffix must still match.
const endRelist =
  /\b(EndItem|EndFixedPriceItem|RelistItem|RelistFixedPriceItem)/i.test(command) ||
  (/\bwithdraw\b/i.test(command) && /\boffer\b/i.test(command))
if (endRelist) {
  process.stderr.write(
    'Blocked: this looks like an eBay end/relist or offer-withdraw call. ' +
      'Live listings are updated in place with `lister revise` — ending and relisting ' +
      'loses the item ID, watchers and sale history. If a listing really must come down, ' +
      'the user does that by hand.',
  )
  process.exit(2)
}

/**
 * `lister publish` without --draft creates a live listing and charges fees on
 * both marketplaces; a publish is never automatically repeatable. Outside the
 * eBay sandbox that is a real-money action, so it needs a human, not an agent.
 *
 * The publish subcommand is only recognised after this repo's own entrypoints
 * (`lister`, `src/cli.ts`, `dist/cli.js`) so that e.g. `npm publish` in some
 * other context is not caught.
 */
const isListerPublish = /(?:\blister\b|\bcli\.(?:ts|js)\b)[^&|;]*\bpublish\b/.test(command)
const hasDraftFlag = /--draft\b/.test(command)

if (isListerPublish && !hasDraftFlag) {
  if (effectiveEbayEnv() !== 'sandbox') {
    process.stderr.write(
      'Blocked: `lister publish` without --draft while EBAY_ENV is not "sandbox". ' +
        'Publishing creates a live listing with real fees and is never automatically ' +
        'repeatable. Use --draft, or leave the publish click to the user.',
    )
    process.exit(2)
  }
}

process.exit(0)

/**
 * Resolves EBAY_ENV the same way the CLI will see it: an inline override in
 * the command wins, then the hook's own environment (real env wins over the
 * file in config.ts too), then the project .env, then the config default.
 */
function effectiveEbayEnv() {
  const inline = command.match(/\bEBAY_ENV\s*=\s*["']?(\w+)/)
  if (inline) return inline[1]
  if (process.env.EBAY_ENV) return process.env.EBAY_ENV
  const envFile = join(cwd, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*EBAY_ENV\s*=\s*["']?(\w+)/)
      if (m) return m[1]
    }
  }
  return 'sandbox' // config.ts default
}
