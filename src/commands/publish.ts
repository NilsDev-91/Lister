import { get, updateMarketplace, upsert } from '../store/db.js'
import { UserError } from '../util/log.js'
import { terminalIo, type Io } from '../util/io.js'
import type { ListingRecord, Marketplace } from '../types.js'
import * as ebay from '../marketplaces/ebay/client.js'
import type { AspectSpec } from '../marketplaces/ebay/aspect-spec.js'
import { planAspects, factsFromProduct } from '../marketplaces/ebay/aspects.js'
import { resolveEbayCategory } from './aspects.js'
import * as etsy from '../marketplaces/etsy/client.js'
import { config } from '../config.js'

/**
 * Publishing.
 *
 * Both marketplaces charge real money at the final step — Etsy takes a listing
 * fee on activation, and an eBay publish creates a live listing with fees
 * attached. So every path here is explicit and confirmed, nothing publishes as
 * a side effect of another command, and the final call is never retried
 * automatically: a retried publish can produce a duplicate listing.
 */

export interface PublishOptions {
  id: string
  marketplaces: Marketplace[]
  /** Stop after creating the remote draft, before it costs anything. */
  draftOnly: boolean
  yes: boolean
  /** eBay only: inventory location key, created on demand. */
  locationKey: string
  /** eBay only: skip category lookup and use this leaf category id. Required in the sandbox. */
  categoryId?: string | undefined
  /** eBay only: VAT percentage to declare, when the seller charges VAT. */
  vatPercentage?: number | undefined
  /** How to prompt and report progress. Defaults to the terminal. */
  io?: Io
}

function requireListing(id: string): ListingRecord {
  const listing = get(id)
  if (!listing) {
    throw new UserError(`No listing with id "${id}".`, 'Run `lister list` to see what you have.')
  }
  return listing
}

/**
 * The licence gate, enforced at the last door — and only at the last door.
 *
 * Drafting a listing under a restrictive licence is allowed: it is local, costs
 * nothing, and the copy that has to be written is the same either way. The
 * licence question is frequently settled afterwards, by buying the creator's
 * commercial membership once the listing is ready. So the whole weight sits
 * here, at the one moment that puts something on a marketplace.
 *
 * Preflight blocks it too, but publish can run with `--skip-preflight`, and
 * this is not a check a flag should get past — same rule as `requireOwnDesign`.
 * The one way through is the seller's explicit rights assertion, made either at
 * create time or with the rights switch on the listing page.
 */
export function requireSaleRights(listing: ListingRecord): void {
  if (listing.source.license.commercialUse !== 'no' || listing.licenseOverridden) return
  throw new UserError(
    `The licence on this model ("${listing.source.license.raw}") does not permit selling prints.`,
    "Once you hold the creator's commercial licence, tick the rights box on the listing page — or create with --i-have-commercial-rights.",
  )
}

// ---------------------------------------------------------------------------
// eBay
// ---------------------------------------------------------------------------

async function publishToEbay(listing: ListingRecord, options: PublishOptions): Promise<void> {
  const io = options.io ?? terminalIo

  requireSaleRights(listing)

  // A listing that is already live is *revised*, never re-published. The item
  // ID carries the watchers, the sales history and what eBay's own VP calls
  // "SEO authority" — ending and relisting throws all three away, so this path
  // updates the inventory item and the offer in place and stops there.
  //
  // Two consequences worth being explicit about:
  //  - The confirmation comes FIRST. On a published offer,
  //    `createOrReplaceInventoryItem` alone already changes the live listing;
  //    asking after it would be asking about the past.
  //  - `--draft` is refused rather than reinterpreted, for the same reason:
  //    there is no "draft" stage of a revise, the first write goes live.
  const ebayRow = listing.marketplaces.find((m) => m.marketplace === 'ebay')
  const liveId = ebayRow?.liveId ?? null

  // A live listing cannot change shape. Single and multi-variation listings
  // are different objects to eBay — different publish calls, different remote
  // structure — and "revising" one into the other would mean ending the live
  // listing and relisting, which is exactly the move this tool refuses to
  // make. The stored remoteId records which shape went live (`group:` prefix).
  const liveAsGroup = ebayRow?.remoteId?.startsWith('group:') ?? false
  if (liveId && Boolean(listing.variants?.length) !== liveAsGroup) {
    throw new UserError(
      listing.variants?.length
        ? `This listing is live as a single-variant listing (${liveId}); variants cannot be added to it in place.`
        : `This listing is live as a variation listing (${liveId}); it cannot be revised down to a single variant.`,
      'eBay has no revise between the two shapes — that would take end-and-relist, losing the item ID and its history. ' +
        'Keep the live shape, or create a new listing for the other one.',
    )
  }

  if (liveId && options.draftOnly) {
    throw new UserError(
      `This listing is already live on eBay (${liveId}), so --draft cannot apply.`,
      'Changes to a published listing take effect immediately. Re-run without --draft to revise it.',
    )
  }
  if (liveId && !options.yes) {
    io.warn(`This updates the live eBay listing ${liveId} in place. No fees; the item ID and its history stay.`)
    if (!(await io.confirm('Revise the live listing now?'))) {
      io.info('Left unchanged.')
      return
    }
  }

  if (!listing.imageUrls.length) {
    throw new UserError(
      'eBay needs at least one HTTPS image URL and this listing has none.',
      'eBay fetches images itself, so a local file will not do. Re-run `create` with --image-url.',
    )
  }

  io.step('eBay: checking seller prerequisites…')
  await ebay.ensureBusinessPoliciesOptIn()
  const policies = await ebay.resolveBusinessPolicies()
  await ebay.ensureInventoryLocation(options.locationKey)
  io.detail(`Policies: fulfillment ${policies.fulfillmentPolicyId}, payment ${policies.paymentPolicyId}, return ${policies.returnPolicyId}`)

  // One resolver for preflight and publish, so they can no longer check one
  // category and list into another.
  const resolved = await resolveEbayCategory(listing, options.categoryId)
  const categoryId = resolved.categoryId
  io.detail(`Category ${categoryId}${resolved.name ? ` — ${resolved.name}` : ''} (${resolved.source})`)

  // Persist what was just resolved — the research and suggestion paths are not
  // guaranteed to answer the same way twice, and the stored id is what keeps
  // preflight and the next publish looking at the same category.
  if (listing.ebayCategoryId !== categoryId) {
    const fresh = get(listing.id)
    if (fresh) upsert({ ...fresh, ebayCategoryId: categoryId })
  }

  // Item specifics decide whether the listing appears in the filtered search at
  // all, so they are planned rather than passed through: values are matched
  // against what the category actually accepts, and the seller's own facts fill
  // what the copywriter left empty.
  const fetch = await ebay.getAspectSpecs(categoryId)
  const plan = planAspects({
    specs: fetch.specs,
    current: listing.copy.ebay.aspects,
    facets: listing.seo?.ebay?.aspectFacets,
    facts: factsFromProduct(listing.product),
    now: new Date(),
  })

  for (const finding of plan.findings) {
    const where = finding.aspect ? `${finding.aspect}: ` : ''
    if (finding.severity === 'blocker') io.warn(`${where}${finding.detail}`)
    else if (finding.severity === 'warning') io.warn(`${where}${finding.detail}`)
    else io.detail(`${where}${finding.detail}`)
  }
  io.detail(`${plan.filled} item specific(s) will be sent.`)

  if (plan.missingRequired.length && !fetch.stale) {
    throw new UserError(
      `eBay requires these item specifics for category ${categoryId}: ${plan.missingRequired.join(', ')}.`,
      'Add them in the editor or with `lister aspects <id>`; eBay rejects the publish without them.',
    )
  }
  if (plan.missingRequired.length && fetch.stale) {
    io.warn('Required item specifics look missing, but the category metadata is stale — publishing anyway.')
  }

  // GPSR is required per category rather than per marketplace, so ask.
  const regulatory = await ebay.getRegulatoryRequirements(categoryId)
  const requiredRegulatory = regulatory.filter((r) => r.usage === 'REQUIRED')
  if (requiredRegulatory.length && !config.seller.manufacturer) {
    throw new UserError(
      `This eBay category requires EU product-safety data: ${requiredRegulatory.map((r) => r.name).join(', ')}.`,
      'Fill in the SELLER_* fields in .env. As the person who prints the item you are the manufacturer under GPSR, ' +
        'so those fields are your own name and address.',
    )
  }
  if (config.seller.manufacturer) {
    io.detail(`GPSR manufacturer block included (${config.seller.manufacturer.companyName}).`)
  } else if (regulatory.length) {
    io.warn('This category accepts EU product-safety data and none is configured. Set the SELLER_* fields in .env.')
  }

  if (listing.variants?.length) {
    await publishEbayVariants(listing, options, io, { categoryId, policies, plan, specs: fetch.specs, liveId })
    return
  }

  // The seller's own SKU when one was entered; the local id — stable and under
  // 50 characters — otherwise.
  const sku = (listing.sku ?? listing.id).slice(0, 50)

  io.step('eBay: creating inventory item…')
  await ebay.putInventoryItem({
    sku,
    // The planned aspects, not the stored ones: this is the only place the
    // normalisation can still take effect.
    copy: { ...listing.copy.ebay, aspects: plan.aspects },
    product: listing.product,
    imageUrls: listing.imageUrls,
  })

  // Reuse the offer from an earlier --draft run rather than creating a second
  // one. eBay allows only one offer per sku/marketplace/format, and publishing
  // has to be safe to re-run: a duplicate listing costs the seller fees.
  const existingOfferId = listing.marketplaces.find((m) => m.marketplace === 'ebay')?.remoteId

  let offerId: string
  if (existingOfferId) {
    offerId = existingOfferId
    io.step(`eBay: updating existing offer ${offerId}…`)
    await ebay.updateOffer(offerId, {
      sku,
      copy: listing.copy.ebay,
      product: listing.product,
      categoryId,
      policies,
      merchantLocationKey: options.locationKey,
      vatPercentage: options.vatPercentage,
    })
  } else {
    io.step('eBay: creating offer…')
    offerId = await ebay.createOffer({
      sku,
      copy: listing.copy.ebay,
      product: listing.product,
      categoryId,
      policies,
      merchantLocationKey: options.locationKey,
      vatPercentage: options.vatPercentage,
    })
    io.ok(`eBay offer created: ${offerId}`)
  }
  // The revise ends here: inventory item and offer are rewritten, and on a
  // published offer both changes are already live. Publishing again would be
  // wrong — the offer *is* published, and the listing it carries just changed.
  if (liveId) {
    updateMarketplace(listing.id, 'ebay', { state: 'published', error: null })
    io.ok(`Live listing revised: ${ebay.listingUrl(liveId)} — same item ID, history and watchers kept.`)
    return
  }

  updateMarketplace(listing.id, 'ebay', { remoteId: offerId, state: 'draft', error: null })

  if (options.draftOnly) {
    io.info('Stopping before publish (--draft). The offer exists but is not live.')
    return
  }

  if (!options.yes) {
    io.warn(`Publishing creates a live eBay listing at EUR ${listing.product.priceEur.toFixed(2)}, with eBay's fees.`)
    if (!(await io.confirm('Publish to eBay now?'))) {
      io.info('Left as an unpublished offer. Publish later with the same command.')
      return
    }
  }

  io.step('eBay: publishing…')
  const listingId = await ebay.publishOffer(offerId)
  const url = ebay.listingUrl(listingId)
  updateMarketplace(listing.id, 'ebay', { state: 'published', liveId: listingId, url, error: null })
  io.ok(`Live on eBay: ${url}`)
}

/**
 * The multi-variation half of the eBay publish.
 *
 * Structure mirrors eBay's model: one inventory item and one offer per colour
 * (own SKU, price, quantity, photos), one inventory item group as the shared
 * shell, and ONE publish call for the whole group — the result is a single
 * listing with a colour dropdown, not five listings.
 *
 * Re-running is safe by construction: items and the group are full-replace
 * PUTs, and `createOffer` recovers an already-existing offer per SKU instead
 * of failing on it. On a live group the final call *revises* — eBay keeps the
 * listing id — which is what makes editing a published variation listing work
 * at all.
 */
async function publishEbayVariants(
  listing: ListingRecord,
  options: PublishOptions,
  io: Io,
  context: {
    categoryId: string
    policies: ebay.BusinessPolicies
    plan: ReturnType<typeof planAspects>
    specs: AspectSpec[]
    liveId: string | null
  },
): Promise<void> {
  const variants = listing.variants!
  const { categoryId, policies, plan, specs, liveId } = context

  // The colour aspect in eBay's own spelling for this category — aspects match
  // literally, so "Farbe" must not be sent where the category says "Colour".
  const colourSpec = specs.find((s) => ['farbe', 'colour', 'color'].includes(s.name.trim().toLowerCase()))
  const colourAspect = colourSpec?.name ?? 'Farbe'

  // Refuse only on an explicit no. eBay's taxonomy states per category whether
  // an aspect may drive variations; where it says nothing, eBay's own publish
  // error is the authority — but where it says `false`, failing here with a
  // reason beats failing there with an error code.
  if (colourSpec?.enabledForVariations === false) {
    throw new UserError(
      `Category ${categoryId} does not allow listings to vary by ${colourAspect}.`,
      'eBay enables variation aspects per category. Pick a category that supports colour variations, or list the colours separately.',
    )
  }
  if (variants.length < 2) {
    io.warn('Only one variant is defined — the listing will carry a dropdown with a single choice.')
  }

  const groupKey = (listing.sku ?? listing.id).slice(0, 50)

  for (const [index, variant] of variants.entries()) {
    io.step(`eBay: inventory item ${index + 1}/${variants.length} — ${variant.sku} (${variant.colour})…`)
    await ebay.putInventoryItem({
      sku: variant.sku,
      copy: { ...listing.copy.ebay, aspects: { ...plan.aspects, [colourAspect]: [variant.colour] } },
      product: { ...listing.product, quantity: variant.quantity },
      // Variation listings cap at 12 pictures per variant, not 24.
      imageUrls: (variant.imageUrls.length ? variant.imageUrls : listing.imageUrls).slice(0, ebay.GROUP_MAX_IMAGES),
    })
    await ebay.createOffer({
      sku: variant.sku,
      copy: listing.copy.ebay,
      product: { ...listing.product, priceEur: variant.priceEur, quantity: variant.quantity },
      categoryId,
      policies,
      merchantLocationKey: options.locationKey,
      vatPercentage: options.vatPercentage,
    })
  }

  io.step(`eBay: inventory item group "${groupKey}"…`)
  // Listing-level specifics live on the group; the varying aspect must not be
  // among them — its values come from the items, one per variant.
  const sharedAspects = Object.fromEntries(Object.entries(plan.aspects).filter(([name]) => name !== colourAspect))
  await ebay.putInventoryItemGroup({
    groupKey,
    variantSkus: variants.map((v) => v.sku),
    title: listing.copy.ebay.title,
    descriptionHtml: listing.copy.ebay.descriptionHtml,
    imageUrls: listing.imageUrls,
    aspects: sharedAspects,
    variesBy: { aspect: colourAspect, values: variants.map((v) => v.colour) },
  })
  updateMarketplace(listing.id, 'ebay', { remoteId: `group:${groupKey}`, state: liveId ? 'published' : 'draft', error: null })

  if (liveId) {
    // The revise confirmation already happened at the top of publishToEbay,
    // before the first write. Republishing the group applies the changes to
    // the existing listing — same id, dropdown updated in place.
    io.step('eBay: applying changes to the live variation listing…')
    const listingId = await ebay.publishOfferByInventoryItemGroup(groupKey)
    updateMarketplace(listing.id, 'ebay', { state: 'published', liveId: listingId, url: ebay.listingUrl(listingId), error: null })
    io.ok(`Live variation listing revised: ${ebay.listingUrl(listingId)}`)
    return
  }

  if (options.draftOnly) {
    io.info(`Stopping before publish (--draft). ${variants.length} offers and the group exist; nothing is live.`)
    return
  }

  if (!options.yes) {
    const prices = variants.map((v) => v.priceEur)
    io.warn(
      `Publishing creates ONE live eBay listing with ${variants.length} colour variant(s), ` +
        `EUR ${Math.min(...prices).toFixed(2)}–${Math.max(...prices).toFixed(2)}, with eBay's fees.`,
    )
    if (!(await io.confirm('Publish the variation listing now?'))) {
      io.info('Left unpublished. The offers and the group exist; publish later with the same command.')
      return
    }
  }

  io.step('eBay: publishing the variation listing…')
  const listingId = await ebay.publishOfferByInventoryItemGroup(groupKey)
  updateMarketplace(listing.id, 'ebay', { state: 'published', liveId: listingId, url: ebay.listingUrl(listingId), error: null })
  io.ok(`Live on eBay with ${variants.length} variant(s): ${ebay.listingUrl(listingId)}`)
}

// ---------------------------------------------------------------------------
// Etsy
// ---------------------------------------------------------------------------

/**
 * Picks the taxonomy node a category hint means.
 *
 * Preference order: exact name match, then a containment match — and within
 * each, the deepest leaf wins. Etsy's own guidance is to categorise as
 * specifically as possible, and its search-visibility page checks for it; when
 * "Desk Organizer" matches both the node and a subtree above it, the subtree is
 * never the better listing category.
 */
export function matchTaxonomy(nodes: etsy.TaxonomyNode[], hint: string): etsy.TaxonomyNode | undefined {
  const wanted = hint.trim().toLowerCase()
  if (!wanted) return undefined

  const best = (candidates: etsy.TaxonomyNode[]): etsy.TaxonomyNode | undefined =>
    candidates.sort(
      (a, b) => Number(b.leaf) - Number(a.leaf) || b.level - a.level || a.name.localeCompare(b.name),
    )[0]

  const exact = nodes.filter((n) => n.name.toLowerCase() === wanted)
  if (exact.length) return best(exact)

  const contains = nodes.filter((n) => {
    const name = n.name.toLowerCase()
    return name.includes(wanted) || wanted.includes(name)
  })
  return best(contains)
}

/**
 * Etsy is closed to third-party designs, and no licence reopens it.
 *
 * Enforced here as well as in preflight because publish can be run with
 * `--skip-preflight`, and this is not a check worth letting a flag past: the
 * penalty is listing removal with the fees retained.
 */
function requireOwnDesign(listing: ListingRecord): void {
  if (listing.ownDesign) return
  throw new UserError(
    `Etsy does not accept third-party designs, and this model is by ${listing.source.designer}.`,
    "Since 10 June 2025 Etsy requires items produced from the seller's own original design. A commercial licence " +
      'does not satisfy it — Etsy asks for authorship, not usage rights. eBay has no such restriction.',
  )
}

async function publishToEtsy(listing: ListingRecord, options: PublishOptions): Promise<void> {
  const io = options.io ?? terminalIo

  requireSaleRights(listing)
  requireOwnDesign(listing)

  if (!listing.imagePaths.length) {
    throw new UserError(
      'Etsy requires at least one image and this listing has none staged.',
      'Re-run `create` with --image <file>, or with a model whose licence permits reusing its renders.',
    )
  }

  io.step('Etsy: identifying shop…')
  const { shopId } = await etsy.getIdentity()

  const profiles = await etsy.listShippingProfiles(shopId)
  const profile = profiles[0]
  if (!profile) {
    throw new UserError(
      'Your Etsy shop has no shipping profile.',
      'Create one in Etsy (Shop Manager → Settings → Shipping settings), then re-run. Shipping costs are a commercial decision this tool will not make for you.',
    )
  }
  io.detail(`Shipping profile: ${profile.title} (${profile.shipping_profile_id})`)

  io.step('Etsy: resolving category…')
  const nodes = await etsy.listTaxonomyNodes()
  const match = matchTaxonomy(nodes, listing.copy.etsy.taxonomyHint)
  if (!match) {
    throw new UserError(
      `No Etsy category matched "${listing.copy.etsy.taxonomyHint}".`,
      'Edit the listing copy to use a more standard Etsy category name.',
    )
  }
  io.detail(`Taxonomy ${match.id} — ${match.path.join(' > ')}`)
  if (!match.leaf) {
    io.warn(
      'The matched Etsy category is not a leaf. Etsy rewards the most specific category; consider a deeper taxonomyHint.',
    )
  }

  // A return policy is not required for an EU shop — but Etsy names shop
  // policies as a positive search-placement signal, and even "no returns"
  // counts as long as the field is set. So attach one when the shop has one,
  // and say so when it does not, rather than silently listing without.
  let returnPolicyId: number | undefined
  try {
    const policies = await etsy.listReturnPolicies(shopId)
    returnPolicyId = policies[0]?.return_policy_id
    if (returnPolicyId === undefined) {
      io.warn(
        'The shop has no return policy. Etsy treats a set policy — even "no returns" — as a positive ' +
          'ranking signal; create one in Shop Manager → Settings → Policy settings.',
      )
    }
  } catch {
    io.detail('Could not read the shop return policies; listing without one.')
  }

  // Reuse an existing remote draft rather than creating a second one — the
  // mirror of the eBay offer-reuse above. Without this, every re-run after
  // `--draft` (or after a failed activation) minted another draft and orphaned
  // the previous one in Shop Manager.
  const storedRemoteId = listing.marketplaces.find((m) => m.marketplace === 'etsy')?.remoteId
  let existingDraftId: number | undefined
  // The catch covers only the lookup, on purpose. A revise that fails further
  // down must surface as the failure it is — falling through to "create a
  // fresh draft" would turn one broken update into a duplicate listing.
  let remote: etsy.EtsyListing | undefined
  if (storedRemoteId) {
    try {
      remote = await etsy.getListing(Number(storedRemoteId))
    } catch {
      io.detail(`Stored Etsy listing ${storedRemoteId} no longer exists; creating a fresh draft.`)
    }
  }

  if (remote?.state === 'draft') existingDraftId = remote.listing_id

  if (remote?.state === 'active') {
    // Already live: this run is a revise. The four text fields are updated in
    // place — editing does not reset Etsy's recency boost, so the only thing
    // that changes is the relevance base the listing matches on.
    if (options.draftOnly) {
      throw new UserError(
        `This listing is already active on Etsy (${storedRemoteId}), so --draft cannot apply.`,
        'Changes to an active listing take effect immediately. Re-run without --draft to revise it.',
      )
    }
    if (!options.yes) {
      io.warn(`This updates the active Etsy listing ${storedRemoteId} in place. No new listing fee.`)
      if (!(await io.confirm('Revise the active listing now?'))) {
        io.info('Left unchanged.')
        return
      }
    }
    io.step('Etsy: revising active listing…')
    await etsy.updateListingContent({ shopId, listingId: remote.listing_id, copy: listing.copy.etsy })
    if (listing.variants?.length) {
      io.step('Etsy: updating colour variations…')
      await etsy.updateListingVariations(remote.listing_id, listing.variants)
    }
    updateMarketplace(listing.id, 'etsy', {
      state: 'published',
      liveId: String(remote.listing_id),
      url: etsy.listingUrl(remote.listing_id),
      error: null,
    })
    io.ok(
      `Active listing revised: ${etsy.listingUrl(remote.listing_id)}` +
        (listing.variants?.length ? '.' : ' (price and quantity untouched).'),
    )
    return
  }

  let draftId: number
  if (existingDraftId !== undefined) {
    draftId = existingDraftId
    io.step(`Etsy: reusing existing draft ${draftId}…`)
  } else {
    io.step('Etsy: creating draft listing…')
    const draft = await etsy.createDraftListing({
      shopId,
      copy: listing.copy.etsy,
      product: listing.product,
      taxonomyId: match.id,
      shippingProfileId: profile.shipping_profile_id,
      returnPolicyId,
    })
    draftId = draft.listing_id
    updateMarketplace(listing.id, 'etsy', { remoteId: String(draftId), state: 'draft', error: null })
    io.ok(`Etsy draft created: ${draftId} (no fee charged yet)`)

    // The colour variations replace the single-product inventory the draft was
    // born with. Etsy renders them as a "Farbe" dropdown with per-colour price,
    // quantity and SKU — the counterpart of eBay's inventory item group, minus
    // the shape lock: on Etsy a listing may gain or lose variations freely.
    if (listing.variants?.length) {
      io.step(`Etsy: setting ${listing.variants.length} colour variation(s)…`)
      await etsy.updateListingVariations(draftId, listing.variants)
      io.detail(listing.variants.map((v) => `${v.colour} — EUR ${v.priceEur.toFixed(2)}, ${v.quantity}x (${v.sku})`).join('\n'))
    }

    // Images belong to the draft, so a reused draft already carries them —
    // uploading again would append duplicates, not replace.
    // Etsy accepts up to 20 photos per listing (doubled from 10 in late 2025).
    const toUpload = listing.imagePaths.slice(0, 20)
    if (listing.imagePaths.length > toUpload.length) {
      io.warn(`Etsy takes 20 photos per listing; the last ${listing.imagePaths.length - toUpload.length} are skipped.`)
    }
    io.step(`Etsy: uploading ${toUpload.length} image(s)…`)
    for (const [index, path] of toUpload.entries()) {
      // rank is 1-based on Etsy; rank 1 is the primary image.
      await etsy.uploadListingImage({
        shopId,
        listingId: draftId,
        filePath: path,
        rank: index + 1,
        altText: listing.copy.etsy.title,
      })
      io.detail(`Uploaded image ${index + 1}`)
    }
  }

  if (options.draftOnly) {
    io.info('Stopping before activation (--draft). No listing fee has been charged.')
    return
  }

  if (!options.yes) {
    io.warn('Activating charges Etsy\'s per-listing fee (about EUR 0.18–0.20) and makes the listing public.')
    if (!(await io.confirm('Activate the Etsy listing now?'))) {
      io.info('Left as a draft. Activate later with the same command.')
      return
    }
  }

  io.step('Etsy: activating…')
  const active = await etsy.activateListing(shopId, draftId)
  const url = etsy.listingUrl(draftId)
  updateMarketplace(listing.id, 'etsy', {
    state: 'published',
    liveId: String(active.listing_id ?? draftId),
    url,
    error: null,
  })
  io.ok(`Live on Etsy: ${url}`)
}

// ---------------------------------------------------------------------------

export async function publishCommand(options: PublishOptions): Promise<void> {
  const io = options.io ?? terminalIo
  const listing = requireListing(options.id)

  io.info(`Listing ${listing.id} — "${listing.source.title}"`)
  io.detail(`eBay environment: ${config.ebay.env}`)

  for (const marketplace of options.marketplaces) {
    // Re-read between marketplaces: the previous iteration wrote to the store,
    // so the copy captured above is stale. Nothing reads a field the other
    // marketplace changes today, but relying on that is a trap for later.
    const current = get(listing.id) ?? listing

    try {
      if (marketplace === 'ebay') await publishToEbay(current, options)
      else await publishToEtsy(current, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Record the failure only on a row that exists. `updateMarketplace`
      // creates missing rows, and a refused attempt — the Etsy own-design gate,
      // say — must not mint the very row whose absence encodes "this channel is
      // not available for this listing".
      const hasRow = (get(listing.id) ?? listing).marketplaces.some((m) => m.marketplace === marketplace)
      if (hasRow) updateMarketplace(listing.id, marketplace, { state: 'failed', error: message })
      // One marketplace failing must not abort the other.
      io.warn(`${marketplace}: ${message}`)
      if (error instanceof UserError && error.hint) io.detail(error.hint)
    }
  }
}
