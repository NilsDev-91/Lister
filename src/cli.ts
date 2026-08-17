#!/usr/bin/env node
import { Command, Option } from 'commander'
import { log, UserError } from './util/log.js'
import { createCommand } from './commands/create.js'
import { publishCommand } from './commands/publish.js'
import { preflightCommand } from './commands/preflight.js'
import { keywordsCommand } from './commands/keywords.js'
import { proposalCommand } from './commands/proposal.js'
import { titlesCommand } from './commands/titles.js'
import { aspectsCommand } from './commands/aspects.js'
import { startServer } from './web/server.js'
import { listAll, get, remove, storeFile } from './store/db.js'
import { MarketplaceSchema, type Marketplace } from './types.js'
import * as ebayAuth from './marketplaces/ebay/auth.js'
import * as ebayClient from './marketplaces/ebay/client.js'
import * as etsyAuth from './marketplaces/etsy/auth.js'
import { config } from './config.js'

const program = new Command()

/**
 * Number parser that accepts the German decimal comma.
 *
 * `parseFloat('12,99')` silently returns 12 — a German seller typing their own
 * price loses 99 cents per sale without a word of warning. One decimal comma is
 * converted; anything still unparseable is refused loudly.
 */
function parseEuroNumber(value: string): number {
  const normalised = /^\d+,\d+$/.test(value.trim()) ? value.trim().replace(',', '.') : value.trim()
  const parsed = Number(normalised)
  if (!Number.isFinite(parsed)) {
    throw new UserError(`"${value}" is not a number.`, 'Use a dot or comma as the decimal separator, e.g. 24.90')
  }
  return parsed
}

program
  .name('lister')
  .description('Turn a MakerWorld model page into eBay and Etsy listings, with Claude writing the copy.')
  .version('0.1.0')

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

program
  .command('auth')
  .argument('<marketplace>', 'ebay or etsy')
  .description('Connect a marketplace account (opens your browser)')
  .option(
    '--redirect-url <url>',
    'eBay only: the address eBay sent you to after approving. Skips the browser and the paste prompt.',
  )
  .option('--print-url', 'eBay only: print the consent URL and exit, without waiting for input', false)
  .action(async (marketplace: string, opts) => {
    const parsed = MarketplaceSchema.safeParse(marketplace)
    if (!parsed.success) throw new UserError(`Unknown marketplace "${marketplace}". Use ebay or etsy.`)

    if (parsed.data === 'ebay') {
      if (opts.printUrl) {
        log.step('Open this, sign in as your TESTUSER_ sandbox account, and approve:')
        process.stdout.write(`${ebayAuth.buildAuthorizeUrl('manual')}\n`)
        log.blank()
        log.info('Then run:  lister auth ebay --redirect-url "<the address you land on>"')
        log.detail('The code inside it is valid for about five minutes.')
        return
      }
      const tokens = await ebayAuth.authorize(opts.redirectUrl)
      log.ok(`Connected to eBay (${config.ebay.env}).`)
      log.detail(`Refresh token valid until ${new Date(tokens.refreshExpiresAt ?? 0).toDateString()}`)
    } else {
      const tokens = await etsyAuth.authorize()
      log.ok('Connected to Etsy.')
      log.detail(`Shop user id ${tokens.extra['userId'] ?? 'unknown'}; refresh token valid 90 days.`)
    }
  })

program
  .command('whoami')
  .description('Show which marketplace accounts are connected')
  .action(() => {
    const ebayTokens = ebayAuth.storedTokens()
    const etsyTokens = etsyAuth.storedTokens()

    const describe = (label: string, tokens: ReturnType<typeof ebayAuth.storedTokens>) => {
      if (!tokens) {
        log.info(`${label.padEnd(6)} not connected`)
        return
      }
      const expired = Date.now() >= tokens.accessExpiresAt
      log.info(
        `${label.padEnd(6)} connected — access token ${expired ? 'expired (will refresh)' : 'valid'}, ` +
          `refresh until ${tokens.refreshExpiresAt ? new Date(tokens.refreshExpiresAt).toDateString() : 'no expiry'}`,
      )
    }

    describe(`eBay`, ebayTokens)
    describe('Etsy', etsyTokens)
    log.detail(`eBay environment: ${config.ebay.env}`)
  })

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

program
  .command('create')
  .description('Build a draft listing from a MakerWorld model URL')
  .requiredOption('-u, --url <url>', 'MakerWorld model URL')
  .option(
    '--from-html <file>',
    'Parse a page you saved from the browser. MakerWorld blocks direct fetches, so this is the reliable route.',
  )
  .requiredOption('-p, --price <eur>', 'Selling price in EUR', parseEuroNumber)
  .requiredOption('-m, --material <name>', 'Print material, e.g. PLA or PETG')
  .option('-q, --quantity <n>', 'Quantity available', (v) => parseInt(v, 10), 1)
  .option('-c, --colour <name>', 'Colour of the printed item')
  .option('-d, --dimensions <lxwxh>', 'Dimensions in mm, e.g. 220x60x30')
  .option('-w, --weight <grams>', 'Weight in grams', parseEuroNumber)
  .option('--processing-days <n>', 'Business days before dispatch', (v) => parseInt(v, 10), 3)
  .option('--sku <sku>', 'Your own SKU (letters, digits, . _ -). Defaults to the local id.')
  .option('-n, --notes <text>', 'Extra detail for the copywriter', '')
  .option('--image <file...>', 'Your own photo files (for Etsy)', [])
  .option('--image-url <url...>', 'Your own photos on a public HTTPS URL (for eBay)', [])
  .option(
    '--i-have-commercial-rights',
    "Override the licence gate. Use only if you hold rights the page does not show.",
    false,
  )
  .option(
    '--no-credit',
    'Leave out the designer credit line. No marketplace requires it; some licences do.',
  )
  .option(
    '--own-design',
    "You designed this model yourself. Required for Etsy, which since 10.06.2025 only accepts a seller's own designs.",
    false,
  )
  .option('-y, --yes', 'Skip confirmation prompts', false)
  .action(async (opts) => {
    await createCommand({
      url: opts.url,
      fromHtml: opts.fromHtml,
      price: opts.price,
      quantity: opts.quantity,
      material: opts.material,
      colour: opts.colour,
      dimensions: opts.dimensions,
      weight: opts.weight,
      processingDays: opts.processingDays,
      notes: opts.notes,
      sku: opts.sku,
      image: opts.image ?? [],
      imageUrl: opts.imageUrl ?? [],
      commercialRights: opts.iHaveCommercialRights,
      credit: opts.credit,
      ownDesign: opts.ownDesign,
      yes: opts.yes,
    })
  })

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

program
  .command('preflight')
  .description('Check a draft for anything that would fail a publish or put the account at risk')
  .argument('<id>', 'Local listing id')
  .addOption(
    new Option('-M, --marketplace <name...>', 'Which marketplaces to check')
      .choices(['ebay', 'etsy'])
      .default(['ebay', 'etsy']),
  )
  .option('--category-id <id>', 'eBay leaf category id, so item specifics and GPSR can be checked')
  .action(async (id: string, opts) => {
    const clean = await preflightCommand({
      id,
      marketplaces: opts.marketplace as Marketplace[],
      categoryId: opts.categoryId,
    })
    if (!clean) process.exitCode = 1
  })

// ---------------------------------------------------------------------------
// keywords
// ---------------------------------------------------------------------------

program
  .command('keywords')
  .description('Research what buyers actually search for, and optionally rewrite the copy to match')
  .argument('<id>', 'Local listing id')
  .addOption(
    new Option('-M, --marketplace <name...>', 'Which marketplaces to research')
      .choices(['ebay', 'etsy'])
      .default(['ebay', 'etsy']),
  )
  .option('--rewrite', 'Also draft new copy against the research, stored for review', false)
  .option('--reuse-research', 'Draft from the research already stored, without searching again', false)
  .option(
    '--no-credit',
    'Leave out the designer credit line when rewriting. No marketplace requires it; some licences do.',
  )
  .action(async (id: string, opts) => {
    if (opts.reuseResearch && !opts.rewrite) {
      throw new UserError('--reuse-research only makes sense with --rewrite.', 'Without it there is nothing to do.')
    }
    await keywordsCommand({
      id,
      // Nothing to research means the stored evidence is used as it stands —
      // useful for a second attempt at the wording without spending the quota
      // again, since the market has not moved in the last two minutes.
      marketplaces: opts.reuseResearch ? [] : (opts.marketplace as Marketplace[]),
      rewrite: opts.rewrite,
      credit: opts.credit,
    })
  })

// ---------------------------------------------------------------------------
// proposal
// ---------------------------------------------------------------------------

program
  .command('proposal')
  .description('Review, accept or discard a pending rewrite')
  .argument('<id>', 'Local listing id')
  .addOption(
    new Option('-M, --marketplace <name...>', 'Which marketplaces to accept')
      .choices(['ebay', 'etsy'])
      .default(['ebay', 'etsy']),
  )
  .option('--accept', 'Replace the current copy with the pending rewrite', false)
  .option('--discard', 'Throw the pending rewrite away', false)
  .action(async (id: string, opts) => {
    if (opts.accept && opts.discard) {
      throw new UserError('Choose one of --accept or --discard, not both.')
    }
    await proposalCommand({
      id,
      accept: opts.accept ? (opts.marketplace as Marketplace[]) : null,
      discard: opts.discard,
    })
  })

// ---------------------------------------------------------------------------
// aspects
// ---------------------------------------------------------------------------

program
  .command('aspects')
  .description("Plan the eBay item specifics — the strongest ranking lever, and the one that decides filter visibility")
  .argument('<id>', 'Local listing id')
  .option('--category-id <id>', 'eBay leaf category id; stored on the listing and reused afterwards')
  .option('--refresh', 'Ignore the cached category metadata and fetch it again', false)
  .action(async (id: string, opts) => {
    await aspectsCommand({ id, categoryId: opts.categoryId, refresh: opts.refresh })
  })

// ---------------------------------------------------------------------------
// titles
// ---------------------------------------------------------------------------

program
  .command('titles')
  .description('Offer several title options, and set the one you pick')
  .argument('<id>', 'Local listing id')
  .addOption(new Option('-M, --marketplace <name>', 'Which marketplace a pick applies to').choices(['ebay', 'etsy']))
  .option('--use <n>', 'Apply stored option number n', (v) => parseInt(v, 10))
  .option('--no-credit', 'Leave out the designer credit line when generating')
  .action(async (id: string, opts) => {
    await titlesCommand({
      id,
      use: opts.use,
      marketplace: opts.marketplace as Marketplace | undefined,
      credit: opts.credit,
    })
  })

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

program
  .command('publish')
  .description('Send a draft to eBay and/or Etsy')
  .argument('<id>', 'Local listing id')
  .addOption(
    new Option('-M, --marketplace <name...>', 'Which marketplaces to publish to')
      .choices(['ebay', 'etsy'])
      .default(['ebay', 'etsy']),
  )
  .option('--draft', 'Create the remote draft but stop before it costs anything', false)
  .option('--location-key <key>', 'eBay inventory location key', 'default-de')
  .option(
    '--category-id <id>',
    'eBay leaf category id. Required in the sandbox, where category suggestions are boilerplate.',
  )
  .option('--vat <percent>', 'VAT percentage to declare on the eBay offer', parseEuroNumber)
  .option('--skip-preflight', 'Publish without running the safety checks first', false)
  .option('-y, --yes', 'Skip confirmation prompts (publishes for real)', false)
  .action(async (id: string, opts) => {
    if (!opts.skipPreflight) {
      const clean = await preflightCommand({
        id,
        marketplaces: opts.marketplace as Marketplace[],
        categoryId: opts.categoryId,
      })
      log.blank()
      if (!clean) {
        throw new UserError(
          'Preflight found blockers, so nothing was published.',
          'Fix them, or re-run with --skip-preflight if you have judged them acceptable.',
        )
      }
    }
    await publishCommand({
      id,
      marketplaces: opts.marketplace as Marketplace[],
      draftOnly: opts.draft,
      yes: opts.yes,
      locationKey: opts.locationKey,
      categoryId: opts.categoryId,
      vatPercentage: opts.vat,
    })
  })

// ---------------------------------------------------------------------------
// revise
// ---------------------------------------------------------------------------

program
  .command('revise')
  .description('Push edited copy to listings that are already live — eBay in place (item ID kept), Etsy in place')
  .argument('<id>', 'Local listing id')
  .addOption(
    new Option('-M, --marketplace <name...>', 'Which marketplaces to revise')
      .choices(['ebay', 'etsy'])
      .default(['ebay', 'etsy']),
  )
  .option('--category-id <id>', 'eBay leaf category id. Required in the sandbox.')
  .option('--location-key <key>', 'eBay inventory location key', 'default-de')
  .option('--vat <percent>', 'VAT percentage to declare on the eBay offer', parseEuroNumber)
  .option('--skip-preflight', 'Revise without running the safety checks first', false)
  .option('-y, --yes', 'Skip confirmation prompts', false)
  .action(async (id: string, opts) => {
    const listing = get(id)
    if (!listing) throw new UserError(`No listing with id "${id}".`)

    // `publish` routes to the revise path by itself when a listing is live;
    // this command exists so "update what is online" reads as what it is. It
    // therefore refuses to quietly become a first publish.
    const live = (opts.marketplace as Marketplace[]).filter((m) =>
      listing.marketplaces.some((row) => row.marketplace === m && row.liveId !== null),
    )
    if (!live.length) {
      throw new UserError(
        `Nothing is live for ${(opts.marketplace as Marketplace[]).join(' and ')} on this listing.`,
        'Revise updates existing live listings. To go live in the first place, use `lister publish`.',
      )
    }

    if (!opts.skipPreflight) {
      const clean = await preflightCommand({ id, marketplaces: live, categoryId: opts.categoryId })
      log.blank()
      if (!clean) {
        throw new UserError(
          'Preflight found blockers, so nothing was revised.',
          'Fix them, or re-run with --skip-preflight if you have judged them acceptable.',
        )
      }
    }
    await publishCommand({
      id,
      marketplaces: live,
      draftOnly: false,
      yes: opts.yes,
      locationKey: opts.locationKey,
      categoryId: opts.categoryId,
      vatPercentage: opts.vat,
    })
  })

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------

program
  .command('ui')
  .description('Open the local web interface')
  .option('-p, --port <n>', 'Port to listen on', (v) => parseInt(v, 10), 4321)
  .option('--no-open', 'Do not launch a browser')
  .action(async (opts) => {
    await startServer({ port: opts.port, openBrowser: opts.open })
    // Hold the process open until interrupted.
    await new Promise(() => {})
  })

// ---------------------------------------------------------------------------
// inspection
// ---------------------------------------------------------------------------

program
  .command('list')
  .description('List local drafts and their marketplace status')
  .option('--json', 'Emit JSON on stdout', false)
  .action((opts) => {
    const listings = listAll()
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(listings, null, 2)}\n`)
      return
    }
    if (!listings.length) {
      log.info('No listings yet. Create one with `lister create --url …`')
      return
    }
    for (const listing of listings) {
      const states = listing.marketplaces.map((m) => `${m.marketplace}:${m.state}`).join('  ')
      log.info(`${listing.id}  ${states}`)
      log.detail(`"${listing.source.title}" — EUR ${listing.product.priceEur.toFixed(2)}`)
      for (const m of listing.marketplaces) {
        if (m.url) log.detail(`  ${m.marketplace}: ${m.url}`)
        if (m.error) log.detail(`  ${m.marketplace} error: ${m.error}`)
      }
    }
    log.blank()
    log.detail(`Stored in ${storeFile}`)
  })

program
  .command('show')
  .description('Show the full generated copy for a draft')
  .argument('<id>', 'Local listing id')
  .option('--json', 'Emit JSON on stdout', false)
  .option('--remote', 'Read back what eBay actually stored, rather than the local copy', false)
  .action(async (id: string, opts) => {
    const listing = get(id)
    if (!listing) throw new UserError(`No listing with id "${id}".`)

    if (opts.remote) {
      const record = listing.marketplaces.find((m) => m.marketplace === 'ebay')
      if (!record?.remoteId) {
        throw new UserError('This draft has not been sent to eBay yet.', `Run: lister publish ${id} --marketplace ebay --draft`)
      }

      // A variation listing has no single offer — the remoteId records the
      // group, and the readable truth is one inventory item and offer per SKU.
      if (record.remoteId.startsWith('group:')) {
        const groupKey = record.remoteId.slice('group:'.length)
        log.step(`eBay variation listing — group "${groupKey}" (${config.ebay.env})`)
        for (const variant of listing.variants ?? []) {
          const [item, offerId] = await Promise.all([
            ebayClient.getInventoryItem(variant.sku),
            ebayClient.findOfferBySku(variant.sku),
          ])
          const aspects = item?.product?.aspects ?? {}
          const colour = Object.entries(aspects).find(([k]) => /farbe|colou?r/i.test(k))?.[1]?.join(', ')
          log.info(
            `${variant.sku.padEnd(20)} ${String(colour ?? variant.colour).padEnd(12)} ` +
              `offer ${offerId ?? '—'}  images ${item?.product?.imageUrls?.length ?? 0}`,
          )
        }
        log.blank()
        if (record.liveId) log.ok(`Live: ${ebayClient.listingUrl(record.liveId)}`)
        else log.warn('Not published yet — the offers and the group exist, nothing is live.')
        return
      }

      const [offer, item] = await Promise.all([
        ebayClient.getOffer(record.remoteId),
        ebayClient.getInventoryItem((listing.sku ?? listing.id).slice(0, 50)),
      ])

      log.step(`eBay offer ${record.remoteId} (${config.ebay.env})`)
      log.info(`Status        ${offer?.status ?? 'UNPUBLISHED'}`)
      log.info(`Marketplace   ${offer?.marketplaceId ?? '?'}  ${offer?.format ?? ''}  ${offer?.listingDuration ?? ''}`)
      log.info(`Category      ${offer?.categoryId ?? '?'}`)
      log.info(`Price         ${offer?.pricingSummary?.price?.value ?? '?'} ${offer?.pricingSummary?.price?.currency ?? ''}`)
      log.info(`Quantity      ${offer?.availableQuantity ?? '?'}`)
      log.info(`Location      ${offer?.merchantLocationKey ?? '?'}`)
      log.blank()
      log.step('Inventory item')
      log.info(`Title         ${item?.product?.title ?? '?'}`)
      log.info(`Images        ${item?.product?.imageUrls?.length ?? 0}`)
      log.info(`Aspects       ${JSON.stringify(item?.product?.aspects ?? {})}`)
      log.blank()

      if (offer?.listing?.listingId) {
        log.ok(`Live: ${ebayClient.listingUrl(offer.listing.listingId)}`)
      } else {
        log.warn('Not published, so it has no listing page and does not appear in Seller Hub.')
        log.detail(`Publishing puts it here: ${ebayClient.sellerHubUrl()}`)
      }
      return
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`)
      return
    }

    log.step(`${listing.id} — ${listing.source.title}`)
    log.detail(`Source: ${listing.sourceUrl}`)
    log.detail(`Licence: ${listing.source.license.raw} (commercial use: ${listing.source.license.commercialUse})`)
    log.blank()
    log.step('eBay (German)')
    log.info(listing.copy.ebay.title)
    log.detail(`Category hint: ${listing.copy.ebay.categoryHint}`)
    log.detail(`Aspects: ${JSON.stringify(listing.copy.ebay.aspects)}`)
    log.detail(`SKU: ${listing.sku ?? `${listing.id} (local id)`}`)
    if (listing.variants?.length) {
      log.detail(`Variants (${listing.variants.length}):`)
      for (const v of listing.variants) {
        log.detail(`  ${v.sku}  ${v.colour}  EUR ${v.priceEur.toFixed(2)}  x${v.quantity}`)
      }
    }
    log.blank()
    log.step('Etsy (English)')
    log.info(listing.copy.etsy.title)
    log.detail(`Tags: ${listing.copy.etsy.tags.join(', ')}`)
    log.detail(`Materials: ${listing.copy.etsy.materials.join(', ')}`)
    log.blank()
    log.detail(`${listing.imagePaths.length} local image(s), ${listing.imageUrls.length} hosted URL(s)`)
  })

program
  .command('delete')
  .description('Remove a local draft (does not touch published listings)')
  .argument('<id>', 'Local listing id')
  .action((id: string) => {
    const listing = get(id)
    if (listing?.marketplaces.some((m) => m.state === 'published')) {
      log.warn('This draft has published listings. Deleting it locally does not remove them from the marketplaces.')
    }
    if (remove(id)) log.ok(`Deleted ${id}`)
    else throw new UserError(`No listing with id "${id}".`)
  })

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    if (error instanceof UserError) {
      log.error(error.message)
      if (error.hint) log.detail(error.hint)
      process.exitCode = 1
      return
    }
    throw error
  }
}

void main()
