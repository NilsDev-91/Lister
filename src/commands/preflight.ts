import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { get } from '../store/db.js'
import { config } from '../config.js'
import { log, UserError } from '../util/log.js'
import type { ListingRecord, Marketplace } from '../types.js'
import * as ebay from '../marketplaces/ebay/client.js'
import * as etsy from '../marketplaces/etsy/client.js'
import * as ebayAuth from '../marketplaces/ebay/auth.js'
import * as etsyAuth from '../marketplaces/etsy/auth.js'
import { gate } from '../makerworld/license.js'
import { tagHygiene } from '../seo/coverage.js'
import { assessPrice, priceHint } from '../seo/price.js'
import { planAspects, factsFromProduct, ASPECT_TARGET } from '../marketplaces/ebay/aspects.js'
import { auditEbayTitle } from '../marketplaces/ebay/title.js'
import { auditEbayDescription } from '../marketplaces/ebay/description.js'
import { imageDimensions } from '../util/image-meta.js'
import { resolveEbayCategory } from './aspects.js'

/**
 * Checks a draft before it goes live.
 *
 * Two kinds of problem end up here. Some are mechanical — a missing shipping
 * policy, a title over the limit — and merely cause a failed publish. Others
 * put the seller's *account* at risk: reusing a designer's photos, quoting a
 * licence that forbids the sale, listing commercially from a private account.
 * Those are the reason this command exists, because a failed publish is
 * recoverable and a suspension is not.
 *
 * What cannot be verified from here is stated plainly rather than assumed.
 */

type Severity = 'blocker' | 'warning'

export interface Finding {
  severity: Severity
  title: string
  detail: string
  fix?: string
}

export class Report {
  readonly findings: Finding[] = []
  readonly passed: string[] = []

  ok(title: string): void {
    this.passed.push(title)
  }

  block(title: string, detail: string, fix?: string): void {
    this.findings.push({ severity: 'blocker', title, detail, ...(fix ? { fix } : {}) })
  }

  warn(title: string, detail: string, fix?: string): void {
    this.findings.push({ severity: 'warning', title, detail, ...(fix ? { fix } : {}) })
  }

  get blockers(): Finding[] {
    return this.findings.filter((f) => f.severity === 'blocker')
  }

  /** Folds another report in, so a sub-check can be run and shown on its own too. */
  absorb(other: Report): void {
    this.findings.push(...other.findings)
    this.passed.push(...other.passed)
  }
}

/** Hosts that serve MakerWorld's own media. */
const MAKERWORLD_HOSTS = /(^|\.)(makerworld\.com|bblmw\.com|bblmw\.cn)$/i

function isMakerWorldAsset(url: string): boolean {
  try {
    return MAKERWORLD_HOSTS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Licence names that must never appear in copy sold under separate rights. */
const LICENCE_MENTION =
  /standard digital file license|creative commons|\bCC[\s-]?BY\b|\bCC0\b|makerworld exclusive/i

// ---------------------------------------------------------------------------
// Checks that need no network
// ---------------------------------------------------------------------------

/**
 * The offline half of preflight, split out so it is directly testable: these
 * are the checks that decide whether a listing is safe to publish, and they
 * must not need a token to exercise.
 */
export function auditContent(listing: ListingRecord, marketplaces: Marketplace[]): Report {
  const report = new Report()
  checkContent(listing, marketplaces, report)
  return report
}

/**
 * Checks the item specifics against what the category actually defines.
 *
 * A sibling of `auditContent` rather than part of it, because it needs the
 * network — but exported on its own so the **web UI can call it**. Living only
 * inside `checkEbay` made it CLI-exclusive, and a blocker the UI never shows is
 * a blocker that never stops anything.
 */
export async function auditEbayAspects(listing: ListingRecord, categoryId: string): Promise<Report> {
  const report = new Report()

  const fetch = await ebay.getAspectSpecs(categoryId)
  if (!fetch.specs.length) {
    report.warn(
      `Category ${categoryId} returned no item specifics`,
      'It may not be a leaf category, or the taxonomy call failed. Nothing can be checked against it.',
    )
    return report
  }

  const plan = planAspects({
    specs: fetch.specs,
    current: listing.copy.ebay.aspects,
    facets: listing.seo?.ebay?.aspectFacets,
    facts: factsFromProduct(listing.product),
    now: new Date(),
  })

  // A short headline per code, so the title never repeats the detail verbatim —
  // the report renders both, and a doubled sentence reads like a bug.
  const HEADLINE: Record<string, string> = {
    'value-not-allowed': 'value not accepted by this category',
    'value-too-long': 'value too long for this category',
    'cardinality-trimmed': 'only one value allowed',
    'required-soon': 'becoming required',
    'below-target': 'Fewer item specifics than eBay recommends',
  }

  for (const finding of plan.findings) {
    const headline = HEADLINE[finding.code] ?? finding.code
    const title = finding.aspect ? `${finding.aspect} — ${headline}` : headline
    // Stale metadata may not block: a taxonomy outage is not evidence that the
    // listing is wrong. Same rule the regulatory lookup already follows.
    if (finding.severity === 'blocker' && !fetch.stale) {
      report.block(
        `Missing required item specific: ${finding.aspect}`,
        finding.detail,
        'Add it in the editor, or run `lister aspects <id>` for the values eBay accepts.',
      )
    } else if (finding.severity === 'blocker') {
      report.warn(`${finding.aspect} looks required, but the metadata is stale`, finding.detail)
    } else if (finding.severity === 'warning') {
      report.warn(title, finding.detail)
    }
  }

  if (!plan.missingRequired.length) {
    report.ok(`All required item specifics for category ${categoryId} are present`)
  }
  if (plan.filled >= ASPECT_TARGET) {
    report.ok(`${plan.filled} item specifics — at or above eBay's target of ${ASPECT_TARGET}`)
  }
  if (fetch.stale) {
    report.warn('eBay category metadata is stale', `Last fetched ${fetch.fetchedAt}. Verdicts below are advisory.`)
  }

  return report
}

function checkContent(listing: ListingRecord, marketplaces: Marketplace[], report: Report): void {
  // --- Rights-related, the ones that can cost an account -------------------

  // The image-rights check keys off the licence decision, NOT off the override
  // flag. Gating it on `licenseOverridden` — as it once was — meant the safest
  // case got checked and the most dangerous one did not: a seller who claims
  // separate rights was warned, while a listing under a personal-use-only
  // licence sailed through with the designer's photos attached.
  const decision = gate(listing.source.license, listing.licenseOverridden, listing.sourceImagesLicensed)

  // The sale itself, before any field-level check. A record created before the
  // hard gate existed — or edited by hand — can still carry a forbidden licence
  // with no override, and no photo or title is going to fix that.
  if (listing.source.license.commercialUse === 'no' && !listing.licenseOverridden) {
    report.block(
      'The licence forbids selling prints',
      `The source page licence ("${listing.source.license.raw}") does not permit commercial use. ` +
        'Listing anyway is a licence breach the designer can enforce — on eBay typically via VeRO, against the account. ' +
        'Drafting is fine; this only stops the publish.',
      "Once you hold the creator's commercial licence, tick the rights box under \"Herkunft und Rechte\" on the listing page.",
    )
  } else {
    report.ok(
      listing.licenseOverridden
        ? 'Sale runs on rights you asserted separately'
        : 'Licence permits selling prints',
    )
  }

  if (!decision.mayReuseImages) {
    const reused = listing.imageUrls.filter(isMakerWorldAsset)
    if (reused.length) {
      report.block(
        "Listing uses the designer's own images",
        `${reused.length} image URL(s) point at MakerWorld's CDN. ` +
          (listing.licenseOverridden
            ? 'A commercial licence bought from a creator covers the model; their photos and renders are separate content that stays theirs.'
            : `The licence on the source page ("${listing.source.license.raw}") does not permit selling prints at all, and it certainly does not hand over the designer's photographs.`) +
          ' Third-party product images are a common VeRO takedown trigger, and those complaints go against the account, not just the listing.',
        'Photograph your own printed item and pass --image / --image-url.',
      )
    } else {
      report.ok("Images are your own, not the designer's")
    }
  }

  if (listing.licenseOverridden) {
    const quotesLicence =
      LICENCE_MENTION.test(listing.copy.ebay.descriptionHtml) || LICENCE_MENTION.test(listing.copy.etsy.description)
    if (quotesLicence) {
      report.block(
        'Listing text names a licence',
        `The copy mentions a licence, but this sale runs under rights you hold separately — not the one shown on the source page. ` +
          `The page says "${listing.source.license.raw}", which forbids selling prints; printing that in the listing states a violation that is not actually happening.`,
        'Delete the licence sentence in the editor, or re-run `create` — the line is not emitted for a listing marked as licensed.',
      )
    } else {
      report.ok('Listing text makes no licence claim')
    }
  }

  // --- Mechanical checks ---------------------------------------------------

  if (marketplaces.includes('ebay')) {
    if (!listing.imageUrls.length) {
      report.block(
        'eBay has no images',
        'eBay fetches images from public HTTPS URLs; it cannot read a local file.',
        'Re-run `create` with --image-url https://…',
      )
    } else if (listing.imageUrls.some((u) => !u.startsWith('https://'))) {
      report.block('An eBay image URL is not HTTPS', 'eBay rejects plain http image URLs.')
    } else if (listing.imageUrls.length === 1) {
      report.warn(
        'eBay listing has a single image',
        'Up to 24 are free, and eBay weighs listing quality in Best Match. A size reference and a surface close-up cost nothing and cut returns.',
      )
    } else {
      report.ok(`eBay has ${listing.imageUrls.length} image URL(s)`)
    }

    const title = listing.copy.ebay.title
    if (title.length > 80) {
      report.block('eBay title too long', `${title.length} characters; the limit is 80.`)
    } else {
      report.ok(`eBay title fits (${title.length}/80)`)
    }

    // Active content fails the publish outright; off-eBay links risk removal.
    const descriptionFindings = auditEbayDescription(listing.copy.ebay.descriptionHtml)
    for (const finding of descriptionFindings) {
      if (finding.severity === 'blocker') report.block(finding.title, finding.detail)
      else report.warn(finding.title, finding.detail)
    }
    if (!descriptionFindings.length) {
      report.ok('eBay description carries no active content or external links')
    }

    // The strongest researched phrase, checked against the mobile cut-off. Only
    // the eBay evidence is usable here — the Etsy candidates are English.
    const strongest = listing.seo?.ebay?.candidates.find((c) => c.usableAsTag)?.phrase ?? null
    for (const finding of auditEbayTitle(title, strongest)) {
      report.warn(finding.title, finding.detail)
    }

    const hasBrand = Object.keys(listing.copy.ebay.aspects).some((k) => k.toLowerCase() === 'marke')
    if (!hasBrand) {
      report.block('eBay item specifics have no "Marke"', 'Most categories require a brand; unbranded prints use "Markenlos".')
    } else {
      report.ok('eBay item specifics include a brand')
    }

    if (listing.variants?.length) {
      if (listing.variants.length === 1) {
        report.warn(
          'Only one eBay colour variant is defined',
          'The listing would carry a dropdown with a single choice. Add the other colours, or clear the variants field for a plain listing.',
        )
      } else {
        report.ok(`eBay variation listing: ${listing.variants.length} colours, one shared item ID`)
      }
      const shared = listing.imageUrls.length
      const withoutOwn = listing.variants.filter((v) => !v.imageUrls.length).length
      if (withoutOwn && shared) {
        report.warn(
          'Variants share the same photos',
          `${withoutOwn} of ${listing.variants.length} variant(s) have no own images and fall back to the shared set — ` +
            'the gallery will not change when the buyer picks a colour.',
        )
      }
    }
  }

  checkPrice(listing, marketplaces, report)

  if (marketplaces.includes('etsy')) {
    // The blocker that outranks every other Etsy check. Since 10.06.2025 Etsy's
    // Creativity Standards require items "produced based on a seller's original
    // design". A commercial licence from the designer does not satisfy it: Etsy
    // asks for authorship, not for usage rights. Listing anyway means removal
    // with the fees still owed, and repeat findings reach the shop.
    if (!listing.ownDesign) {
      report.block(
        'Etsy does not permit third-party designs',
        `This model is by ${listing.source.designer}. Since 10 June 2025 Etsy requires items to be produced from ` +
          "the seller's own original design — a commercial licence does not change that, because Etsy asks for " +
          'authorship rather than usage rights.',
        'Only list your own designs on Etsy. eBay has no equivalent restriction and stays available.',
      )
    } else {
      report.ok('Marked as your own design, which is what Etsy requires')
    }

    const missing = listing.imagePaths.filter((p) => !existsSync(p))
    if (!listing.imagePaths.length) {
      report.block('Etsy has no images', 'Etsy uploads actual files and refuses to activate a listing without one.')
    } else if (missing.length) {
      report.block('Staged Etsy images are gone from disk', missing.join('\n'), 'Re-run `create` to stage them again.')
    } else {
      report.ok(`Etsy has ${listing.imagePaths.length} staged image file(s)`)
      checkEtsyImageFiles(listing, report)
    }

    const titleWords = listing.copy.etsy.title.split(/\s+/).filter(Boolean).length
    if (titleWords > 15) {
      report.warn(
        'Etsy title runs past 15 words',
        `${titleWords} words. Etsy's own guidance is under 15 — a keyword-list title reads badly in results and converts worse.`,
      )
    }

    if (listing.copy.etsy.tags.length < 13) {
      report.warn(
        'Etsy listing uses fewer than 13 tags',
        `${listing.copy.etsy.tags.length}/13 used. Tags are the main way buyers find a listing, so unused slots are wasted reach.`,
      )
    } else {
      report.ok('Etsy uses all 13 tags')
    }

    // Thirteen tags is the budget, and two tags built on the same word spend
    // two slots to cover one search. Filling all thirteen is no use if four of
    // them say "3d print", "3d printed", "3d printing" and "3d prints".
    const overlaps = tagHygiene(listing.copy.etsy.tags).repeated
    if (overlaps.length) {
      report.warn(
        'Etsy tags overlap on the same words',
        overlaps
          .slice(0, 5)
          .map((o) => `"${o.stem}" appears in: ${o.tags.join(', ')}`)
          .join('\n'),
        'Rewrite the duplicates to cover different searches — `lister keywords <id> --apply` proposes replacements from real listing data.',
      )
    } else if (listing.copy.etsy.tags.length) {
      report.ok('Etsy tags cover distinct searches')
    }

    // A one-word tag can only ever broad-match, which every longer tag built on
    // the word already does — the slot buys nothing a multi-word tag would not.
    const singleWord = listing.copy.etsy.tags.filter((t) => t.trim().split(/\s+/).length === 1)
    if (singleWord.length) {
      report.warn(
        'Etsy tags include single words',
        `${singleWord.map((t) => `"${t}"`).join(', ')} — Etsy's own advice is multi-word phrases: ` +
          'a phrase matches exactly and still broad-matches its words, a single word only does the latter.',
      )
    }
  }
}

/**
 * Whether a staged file looks like a MakerWorld download rather than a photo.
 *
 * `downloadImages` names its files `01.jpg`, `02.png`, … while seller uploads
 * are `own-01.jpg` or arbitrary paths. A heuristic, and labelled as one — but
 * Etsy's seller policy explicitly forbids "artistic renderings" as listing
 * photos, and a downloaded render is the default failure mode of this pipeline.
 */
function looksDownloaded(path: string): boolean {
  return /^\d{2}\.(jpe?g|png|gif|webp)$/i.test(path.split(/[\\/]/).pop() ?? '')
}

/** Etsy image constraints that can be checked from the staged files alone. */
function checkEtsyImageFiles(listing: ListingRecord, report: Report): void {
  const downloaded = listing.imagePaths.filter(looksDownloaded)
  if (downloaded.length) {
    report.warn(
      'Staged Etsy images look like downloaded renders',
      `${downloaded.length} file(s) carry the staging names the MakerWorld download uses. Etsy's seller policy ` +
        'forbids stock photos and artistic renderings as listing images — the first photo especially must show ' +
        'the finished physical product.',
      'Photograph your printed item and replace the downloads.',
    )
  }

  // Etsy does not take WebP; a staged .webp fails at upload time with an
  // unhelpful error, so it is called out while renaming is still cheap.
  const webp = listing.imagePaths.filter((p) => extname(p).toLowerCase() === '.webp')
  if (webp.length) {
    report.warn(
      'Staged Etsy images include WebP files',
      `${webp.length} file(s). Etsy accepts JPG, PNG, GIF and HEIC only — the upload will fail.`,
      'Convert them to JPG before publishing.',
    )
  }

  // Etsy's help pages disagree with each other on the ceiling (300 KB vs 1 MB);
  // the stricter figure is the one its upload endpoint is documented to time
  // out at, so that is the one worth flagging.
  const oversized = listing.imagePaths.filter((p) => {
    try {
      return statSync(p).size > 300 * 1024
    } catch {
      return false
    }
  })
  if (oversized.length) {
    report.warn(
      'Etsy images are over 300 KB',
      `${oversized.length} of ${listing.imagePaths.length} file(s). Etsy documents that uploads above 300 KB may time out; ` +
        'at 2000px width that means aggressive JPEG compression.',
    )
  }

  // The first photo is the one Etsy's search-visibility page actually measures.
  const first = listing.imagePaths[0]
  if (!first) return
  let dims: ReturnType<typeof imageDimensions> = null
  try {
    dims = imageDimensions(readFileSync(first))
  } catch {
    return // unreadable file is already reported as missing above
  }
  if (!dims) return

  if (dims.width < 635 || dims.height < 635) {
    report.warn(
      'Etsy primary photo is below 635×635 px',
      `${dims.width}×${dims.height}. Below this floor Etsy places the listing worse in search — not a rejection, a demotion.`,
      'Re-shoot or re-export the first photo larger.',
    )
  } else if (dims.width < 2000) {
    report.warn(
      'Etsy primary photo is narrower than 2000 px',
      `${dims.width}×${dims.height}. Etsy's search-visibility check asks for at least 2000 px width on the first photo.`,
    )
  } else {
    report.ok(`Etsy primary photo is ${dims.width}×${dims.height} px`)
  }
}

/**
 * Compares the asking price against what the research measured.
 *
 * Never a blocker. What a thing is worth is the seller's call, and a tool that
 * refuses to publish over a price would be wrong far more often than right.
 * The job here is only to make sure the number was chosen rather than inherited
 * from a guess made before anyone looked at the market.
 */
function checkPrice(listing: ListingRecord, marketplaces: Marketplace[], report: Report): void {
  for (const marketplace of marketplaces) {
    const band = listing.seo?.[marketplace]?.priceBandEur
    if (!band) continue

    const verdict = assessPrice(listing.product.priceEur, band)
    if (!verdict.notable) {
      report.ok(`Price is in line with the ${marketplace} market (median EUR ${band.median.toFixed(2)})`)
      continue
    }

    report.warn(
      `Price is ${verdict.position === 'above' || verdict.position === 'high' ? 'above' : 'below'} the ${marketplace} market`,
      verdict.summary,
      priceHint(verdict),
    )
  }
}

// ---------------------------------------------------------------------------
// Checks that talk to the marketplaces
// ---------------------------------------------------------------------------

async function checkEbay(listing: ListingRecord, categoryId: string | undefined, report: Report): Promise<void> {
  if (!ebayAuth.storedTokens()) {
    report.block(`Not connected to eBay (${config.ebay.env})`, 'No stored token.', 'Run `lister auth ebay`.')
    return
  }
  report.ok(`Connected to eBay (${config.ebay.env})`)

  try {
    await ebay.ensureBusinessPoliciesOptIn()
    const policies = await ebay.resolveBusinessPolicies()
    report.ok(
      `Business policies present (shipping ${policies.fulfillmentPolicyId}, payment ${policies.paymentPolicyId}, returns ${policies.returnPolicyId})`,
    )
  } catch (error) {
    report.block(
      'eBay business policies incomplete',
      error instanceof Error ? error.message.split('\n')[0]! : String(error),
      "Create shipping, payment and return policies in eBay's seller settings. This tool reads them; it will not invent your terms.",
    )
  }

  // Resolve exactly the way publish does. Bailing out here whenever
  // `--category-id` was omitted is what made the item-specific checks
  // unreachable on the default path — preflight passed, publish then listed
  // into a category nothing had been checked against.
  let resolved: string
  try {
    resolved = (await resolveEbayCategory(listing, categoryId)).categoryId
  } catch (error) {
    report.warn(
      'Category could not be resolved',
      error instanceof Error ? error.message : String(error),
      'Pass --category-id once; it is stored on the listing and reused afterwards.',
    )
    return
  }

  try {
    const aspectReport = await auditEbayAspects(listing, resolved)
    report.absorb(aspectReport)

    const regulatory = await ebay.getRegulatoryRequirements(resolved)
    const requiredReg = regulatory.filter((r) => r.usage === 'REQUIRED')
    if (requiredReg.length && !config.seller.manufacturer) {
      report.block(
        'EU product safety data required for this category',
        `eBay marks ${requiredReg.map((r) => r.name).join(', ')} as required, and no manufacturer is configured.`,
        'Fill in the SELLER_* fields in .env. Printing the item yourself makes you the manufacturer under GPSR.',
      )
    } else if (regulatory.length && !config.seller.manufacturer) {
      report.warn(
        'EU product safety data accepted but not configured',
        'This category takes GPSR manufacturer data and none is set.',
        'Fill in the SELLER_* fields in .env.',
      )
    } else if (config.seller.manufacturer) {
      report.ok(`GPSR manufacturer configured (${config.seller.manufacturer.companyName})`)
    }
  } catch (error) {
    report.warn('Could not check the category', error instanceof Error ? error.message.split('\n')[0]! : String(error))
  }
}

async function checkEtsy(report: Report): Promise<void> {
  if (!etsyAuth.storedTokens()) {
    report.block('Not connected to Etsy', 'No stored token.', 'Run `lister auth etsy`.')
    return
  }
  try {
    const { shopId } = await etsy.getIdentity()
    report.ok(`Connected to Etsy (shop ${shopId})`)

    const profiles = await etsy.listShippingProfiles(shopId)
    if (!profiles.length) {
      report.block(
        'Etsy shop has no shipping profile',
        'A physical listing cannot be activated without one.',
        'Create one in Shop Manager → Settings → Shipping settings.',
      )
    } else {
      report.ok(`Etsy shipping profile present (${profiles[0]!.title})`)
    }
  } catch (error) {
    report.block('Etsy check failed', error instanceof Error ? error.message.split('\n')[0]! : String(error))
  }
}

// ---------------------------------------------------------------------------

/**
 * Things no API can confirm. Printed every run rather than hidden behind a
 * flag, because the most expensive failures in this workflow are exactly the
 * ones a program cannot see.
 */
function manualResponsibilities(listing: ListingRecord): string[] {
  const items = [
    'Your eBay account is registered as a business seller, with Impressum, Widerrufsbelehrung and AGB. ' +
      'Selling self-made new goods with intent to profit is commercial regardless of volume, and listing it privately risks both a warning letter and account restriction.',
  ]

  if (listing.licenseOverridden) {
    items.push(
      `You hold current commercial rights for "${listing.source.title}" by ${listing.source.designer}. ` +
        'A MakerWorld membership licence runs only for the billing period, while an eBay listing is Good \'Til Cancelled and outlives it.',
      "Your licence tier has no quantity or revenue cap you are about to exceed — creators set those themselves.",
    )
  }

  return items
}

export interface PreflightOptions {
  id: string
  marketplaces: Marketplace[]
  categoryId?: string | undefined
}

export async function preflightCommand(options: PreflightOptions): Promise<boolean> {
  const listing = get(options.id)
  if (!listing) {
    throw new UserError(`No listing with id "${options.id}".`, 'Run `lister list` to see what you have.')
  }

  log.step(`Preflight for ${listing.id} — "${listing.source.title}"`)
  log.detail(`Marketplaces: ${options.marketplaces.join(', ')} · eBay environment: ${config.ebay.env}`)
  log.blank()

  const report = new Report()
  checkContent(listing, options.marketplaces, report)
  if (options.marketplaces.includes('ebay')) await checkEbay(listing, options.categoryId, report)
  if (options.marketplaces.includes('etsy')) await checkEtsy(report)

  for (const name of report.passed) log.ok(name)

  const warnings = report.findings.filter((f) => f.severity === 'warning')
  if (warnings.length) {
    log.blank()
    for (const w of warnings) {
      log.warn(w.title)
      log.detail(w.detail)
      if (w.fix) log.detail(`→ ${w.fix}`)
    }
  }

  if (report.blockers.length) {
    log.blank()
    for (const b of report.blockers) {
      log.error(b.title)
      log.detail(b.detail)
      if (b.fix) log.detail(`→ ${b.fix}`)
    }
  }

  log.blank()
  log.step('Not checkable from here — your responsibility')
  for (const item of manualResponsibilities(listing)) log.info(`· ${item}`)

  log.blank()
  if (report.blockers.length) {
    log.error(`${report.blockers.length} blocker(s). Publishing would fail or put the account at risk.`)
    return false
  }
  log.ok(`No blockers. ${warnings.length} warning(s).`)
  return true
}

