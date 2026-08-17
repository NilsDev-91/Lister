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
 * No trailing \b: the Trading API spells these `EndItemRequest`,
 * `RelistItemResponse` etc., and the suffix must still match.
 */
const endRelist =
  /\b(EndItem|EndFixedPriceItem|RelistItem|RelistFixedPriceItem)/i.test(command) ||
  (/\bwithdraw\b/i.test(command) && /\boffer\b/i.test(command))
if (endRelist) {
  block(
    'Blocked: this looks like an eBay end/relist or offer-withdraw call. ' +
      'Live listings are updated in place with `lister revise` — ending and relisting ' +
      'loses the item ID, watchers and sale history. If a listing really must come down, ' +
      'the user does that by hand.',
  )
}

/**
 * `lister publish` without --draft creates a live listing and charges fees; a
 * publish is never automatically repeatable. The eBay sandbox is the one free
 * playground — but Etsy has NO sandbox, so the exemption only applies when the
 * call touches nothing but eBay (`-M ebay`). Without a marketplace flag the
 * CLI publishes to BOTH (commander default in cli.ts), so a flagless publish
 * is never sandbox-exempt.
 *
 * The publish subcommand is only recognised after this repo's own entry
 * points — the `lister` bin, `src/cli.ts` / `dist/cli.js` (tsx/node), and the
 * README's `npm run dev -- …` (plus Node 22's `node --run dev`) — so that
 * e.g. `npm publish` in some other context is not caught.
 */
const isListerPublish =
  /(?:\blister\b|\bcli\.(?:ts|js)\b|\bnpm\s+run\s+dev\b|\bnode\s+--run\s+dev\b)[^&|;]*?\bpublish\b/.test(
    command,
  )
const hasDraftFlag = /--draft\b/.test(command)

if (isListerPublish && !hasDraftFlag) {
  const marketplaces = marketplacesInvolved(command)
  // An empty flag (`-M` with no value) is a malformed call, not an eBay-only
  // one — it stays blocked rather than slipping through the sandbox exemption.
  const ebayOnly =
    marketplaces !== null && marketplaces.length > 0 && marketplaces.every((m) => m === 'ebay')

  if (!ebayOnly) {
    block(
      'Blocked: `lister publish` without --draft on a call that involves Etsy ' +
        '(explicitly, or implicitly because no -M/--marketplace flag limits it to eBay). ' +
        'Etsy has no sandbox — activation always charges a real listing fee and is never ' +
        'automatically repeatable. Use --draft, restrict to `-M ebay` in the sandbox, or ' +
        'leave the publish click to the user.',
    )
  }
  if (effectiveEbayEnv() !== 'sandbox') {
    block(
      'Blocked: `lister publish` without --draft while EBAY_ENV is not "sandbox". ' +
        'Publishing creates a live listing with real fees and is never automatically ' +
        'repeatable. Use --draft, or leave the publish click to the user.',
    )
  }
}

process.exit(0)

function block(reason) {
  process.stderr.write(reason)
  process.exit(2)
}

/**
 * The marketplaces a publish call names, or null when no flag is present.
 *
 * Mirrors cli.ts: `-M, --marketplace <name...>` is variadic (values until the
 * next `-`-prefixed token), may repeat, and the long form accepts `=`.
 * Anything unrecognised stays in the list — an unknown value must make the
 * call NOT ebay-only (fail closed), not disappear.
 */
function marketplacesInvolved(cmd) {
  const tokens = cmd.split(/\s+/)
  let values = null
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    let inline = null
    if (token.startsWith('--marketplace=')) inline = token.slice('--marketplace='.length)
    else if (token !== '-M' && token !== '--marketplace') continue

    values ??= []
    if (inline !== null) {
      if (inline) values.push(inline.toLowerCase())
      continue
    }
    while (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      values.push(tokens[++i].toLowerCase())
    }
  }
  return values
}

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
