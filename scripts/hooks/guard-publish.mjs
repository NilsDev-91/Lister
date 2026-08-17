// PreToolUse hook (matcher: Bash). Blocks the commands that cost real money
// or destroy a live listing's history; lets everything else through.
//
// Exit 2 + stderr = Claude Code blocks the tool call and shows the reason.
// Exit 0 silently = normal permission flow continues.
//
// Structure: RULES is an ordered list of functions taking the command string
// and returning a block reason or null. The first reason wins. Everything a
// rule needs beyond the command (environment, .env) it resolves itself.
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

const RULES = [endRelistRule, cliPublishRule, ebayRawPublishRule, etsyActivationRule]

for (const rule of RULES) {
  const reason = rule(command)
  if (reason) {
    process.stderr.write(reason)
    process.exit(2)
  }
}
process.exit(0)

/**
 * eBay end+relist destroys the item ID, watchers, sale history and search
 * standing — this repo updates live listings in place (`lister revise`).
 * The lister CLI has no end/relist command, so anything matching here is a
 * raw API call (Trading `EndItem`/`RelistItem`, Inventory `withdraw`).
 * No trailing \b: the Trading API spells these `EndItemRequest`,
 * `RelistItemResponse` etc., and the suffix must still match.
 */
function endRelistRule(cmd) {
  const matches =
    /\b(EndItem|EndFixedPriceItem|RelistItem|RelistFixedPriceItem)/i.test(cmd) ||
    (/\bwithdraw\b/i.test(cmd) && /\boffer\b/i.test(cmd))
  if (!matches) return null
  return (
    'Blocked: this looks like an eBay end/relist or offer-withdraw call. ' +
    'Live listings are updated in place with `lister revise` — ending and relisting ' +
    'loses the item ID, watchers and sale history. If a listing really must come down, ' +
    'the user does that by hand.'
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
function cliPublishRule(cmd) {
  const isListerPublish =
    /(?:\blister\b|\bcli\.(?:ts|js)\b|\bnpm\s+run\s+dev\b|\bnode\s+--run\s+dev\b)[^&|;]*?\bpublish\b/.test(
      cmd,
    )
  if (!isListerPublish || /--draft\b/.test(cmd)) return null

  const marketplaces = marketplacesInvolved(cmd)
  // An empty flag (`-M` with no value) is a malformed call, not an eBay-only
  // one — it stays blocked rather than slipping through the sandbox exemption.
  const ebayOnly =
    marketplaces !== null && marketplaces.length > 0 && marketplaces.every((m) => m === 'ebay')

  if (!ebayOnly) {
    return (
      'Blocked: `lister publish` without --draft on a call that involves Etsy ' +
      '(explicitly, or implicitly because no -M/--marketplace flag limits it to eBay). ' +
      'Etsy has no sandbox — activation always charges a real listing fee and is never ' +
      'automatically repeatable. Use --draft, restrict to `-M ebay` in the sandbox, or ' +
      'leave the publish click to the user.'
    )
  }
  if (effectiveEbayEnv() !== 'sandbox') {
    return (
      'Blocked: `lister publish` without --draft while EBAY_ENV is not "sandbox". ' +
      'Publishing creates a live listing with real fees and is never automatically ' +
      'repeatable. Use --draft, or leave the publish click to the user.'
    )
  }
  return null
}

/**
 * Raw calls to the two eBay endpoints that make a listing LIVE and incur
 * fees — the same operation `lister publish` performs, reached sideways:
 *
 *   POST /sell/inventory/v1/offer/{offerId}/publish            (research §7)
 *   POST /sell/inventory/v1/offer/publish_by_inventory_item_group
 *
 * Everything else in the Inventory API is free drafting (createOffer, the
 * item/group PUTs, all reads) and passes. The sandbox exemption mirrors the
 * CLI rule: allowed only when the command explicitly targets
 * api.sandbox.ebay.com and not api.ebay.com. A publish path whose host is
 * not recognisable (variables, config lookups) is blocked — for a money
 * guard the cheap error is a rephrase, the expensive one is a fee.
 */
function ebayRawPublishRule(cmd) {
  const publishPath =
    /\/offer\/[^\s/"']+\/publish\b/i.test(cmd) || /\bpublish_by_inventory_item_group\b/i.test(cmd)
  if (!publishPath) return null

  const sandboxHost = /\bapi\.sandbox\.ebay\.com\b/i.test(cmd)
  const productionHost = /\bapi\.ebay\.com\b/i.test(cmd)
  if (sandboxHost && !productionHost) return null

  return (
    'Blocked: raw call to an eBay publish endpoint (offer/{id}/publish or ' +
    'publish_by_inventory_item_group)' +
    (productionHost ? ' against the production host.' : ' without a recognisable sandbox host.') +
    ' This makes a listing live with real fees and is never automatically repeatable. ' +
    'Target api.sandbox.ebay.com for experiments, use `lister publish --draft` for drafting, ' +
    'or leave publishing to the user.'
  )
}

/**
 * Etsy has no sandbox. Setting a listing's state to `active` IS the billable
 * moment — the listing fee lands on that PATCH, and reactivating a sold_out
 * or expired listing renews for another fee (docs/research/etsy-listings.md
 * §9). Drafts, content updates, reads and deactivation are free and pass.
 * The spelling variants cover form bodies (`state=active`), JSON
 * (`"state":"active"`) and shell quoting; an Etsy context (api host,
 * /listings path or the word etsy) keeps unrelated `state=active` strings
 * out.
 */
function etsyActivationRule(cmd) {
  const stateActive = /\bstate\b["']?\s*[:=]\s*["']?active\b/i.test(cmd)
  if (!stateActive) return null

  const etsyContext =
    /\b(?:open)?api\.etsy\.com\b/i.test(cmd) || /\/listings\b/i.test(cmd) || /\betsy\b/i.test(cmd)
  if (!etsyContext) return null

  return (
    'Blocked: this sets an Etsy listing to state=active — the billable moment. ' +
    'Etsy has no sandbox: every activation charges the listing fee, and reactivating a ' +
    'sold_out or expired listing renews it for another fee. Create and edit drafts freely; ' +
    'leave activation to the user.'
  )
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
