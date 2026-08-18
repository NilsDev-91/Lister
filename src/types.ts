import { z } from 'zod'
import { MarketplaceSchema } from './marketplace.js'
import { SeoEvidenceSchema } from './seo/types.js'

/**
 * The domain model. Everything crossing a module boundary is validated here, so
 * a bad MakerWorld parse or a hallucinated field from Claude fails at the seam
 * rather than as a 400 from eBay half a pipeline later.
 */

// ---------------------------------------------------------------------------
// Source-platform data
// ---------------------------------------------------------------------------

/** Which platform a model page came from. */
export const PlatformSchema = z.enum(['MAKERWORLD', 'CULTS3D', 'PRINTABLES'])
export type Platform = z.infer<typeof PlatformSchema>

/**
 * How a model's licence answers "may I sell prints of this?".
 *
 * `unknown` is deliberately distinct from `no`: it means we could not read the
 * licence, which is a prompt-the-user state, not a denial.
 */
export const CommercialUseSchema = z.enum(['yes', 'no', 'unknown'])
export type CommercialUse = z.infer<typeof CommercialUseSchema>

export const LicenseInfoSchema = z.object({
  /** Raw licence identifier as MakerWorld reports it, e.g. "CC BY-NC 4.0". */
  raw: z.string(),
  /** Normalised SPDX-ish code where we recognise one, e.g. "CC-BY-NC-4.0". */
  code: z.string().nullable(),
  commercialUse: CommercialUseSchema,
  /** Why we reached that verdict — surfaced to the user, so keep it readable. */
  reason: z.string(),
})
export type LicenseInfo = z.infer<typeof LicenseInfoSchema>

export const SourceImageSchema = z.object({
  url: z.string().url(),
  /** The source platform's own ordering; 0 is the cover image. */
  rank: z.number().int().nonnegative(),
})
export type SourceImage = z.infer<typeof SourceImageSchema>

/**
 * Records stored before the multi-platform rename carry `designId` and no
 * `platform`. The rename must not strand them: the store validates on read,
 * and a parse failure there moves the user's entire listings.json aside.
 * `platform` needs no migration — its `.default('MAKERWORLD')` is correct by
 * construction, since every pre-rename record came from MakerWorld.
 */
function migrateLegacySourceModel(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (!('externalId' in record) && 'designId' in record) {
      const { designId, ...rest } = record
      return { ...rest, externalId: designId }
    }
  }
  return value
}

export const SourceModelSchema = z.preprocess(
  migrateLegacySourceModel,
  z.object({
    sourceUrl: z.string().url(),
    platform: PlatformSchema.default('MAKERWORLD'),
    /** The platform's own id for the model, kept as a string — it is an identifier, not a quantity. */
    externalId: z.string(),
    title: z.string().min(1),
    description: z.string(),
    designer: z.string(),
    tags: z.array(z.string()),
    images: z.array(SourceImageSchema),
    license: LicenseInfoSchema,
    /** ISO 8601, when the platform exposes it. */
    fetchedAt: z.string(),
  }),
)
export type SourceModel = z.infer<typeof SourceModelSchema>

// ---------------------------------------------------------------------------
// Seller-supplied facts
// ---------------------------------------------------------------------------

/**
 * What the tool cannot know from MakerWorld: what *you* are actually selling.
 * A MakerWorld page describes a model; a listing describes a physical object
 * you printed, with a material, a size, a weight and a price.
 */
export const ProductInputSchema = z.object({
  /**
   * Upper bound is not pedantry: `(1e21).toFixed(2)` returns the string
   * "1e+21", which is what would be sent to eBay as the price. A cap keeps the
   * value in the range where `toFixed` produces plain decimal notation, and
   * catches a fat-fingered price before it reaches a marketplace.
   */
  priceEur: z.number().positive().max(1_000_000),
  quantity: z.number().int().positive().max(100_000),
  /** e.g. "PLA", "PETG", "PLA Silk" — feeds both copy and Etsy's materials field. */
  material: z.string().min(1),
  colour: z.string().nullable(),
  /** Millimetres. Used for copy, eBay package size and Etsy item dimensions. */
  dimensionsMm: z
    .object({ length: z.number().positive(), width: z.number().positive(), height: z.number().positive() })
    .nullable(),
  weightGrams: z.number().positive().nullable(),
  /** Business days from order to dispatch. Made-to-order prints are not same-day. */
  processingDays: z.number().int().positive().default(3),
  /** Free-form notes the copywriter should work in, e.g. "layer height 0.16mm". */
  notes: z.string().default(''),
})
export type ProductInput = z.infer<typeof ProductInputSchema>

// ---------------------------------------------------------------------------
// Generated listing copy
// ---------------------------------------------------------------------------

/**
 * eBay caps titles at 80 characters and rejects the listing outright if you
 * exceed it, so the limit is enforced here rather than discovered at publish.
 */
/**
 * Emoji, matched by their Unicode property rather than a hand-built list.
 *
 * eBay measures titles carrying symbols at up to **four times lower** click
 * rate. That is a ranking effect rather than an API rejection, but the gap is
 * wide enough to treat like one.
 */
const EBAY_TITLE_EMOJI = /\p{Extended_Pictographic}/u

/**
 * The eBay title, with the two rules that are not merely advice.
 *
 * Everything else eBay warns about — stray symbols, shouted words, repeated
 * keywords, the strongest term buried past the mobile cut-off — is a ranking
 * cost rather than a rejection, so it belongs in preflight as a warning. The
 * split is the same one `EtsyTitleSchema` makes: the schema encodes what gets
 * the listing thrown out, preflight encodes what makes it perform badly.
 */
export const EbayTitleSchema = z
  .string()
  .min(1)
  .max(80)
  .refine((t) => !EBAY_TITLE_EMOJI.test(t), {
    message: 'eBay titles must not contain emoji — they cut the click rate by up to a factor of four',
  })
  .refine((t) => !t.includes('?'), {
    message: 'eBay forbids question marks in titles (search-manipulation policy id=4243)',
  })

export const EbayCopySchema = z.object({
  title: EbayTitleSchema,
  /** HTML. eBay renders a subset; keep it to headings, paragraphs and lists. */
  descriptionHtml: z.string().min(1),
  /** Free-text category guess; resolved to a real categoryId via the Taxonomy API. */
  categoryHint: z.string().min(1),
  /** Item specifics, e.g. { Material: ["PLA"], Marke: ["Markenlos"] }. */
  aspects: z.record(z.string(), z.array(z.string())),
})
export type EbayCopy = z.infer<typeof EbayCopySchema>

/**
 * Etsy enforces these server-side but declares none of them in its OpenAPI
 * schema — there is not a single `maxItems` in the whole spec — so a violation
 * surfaces as an opaque 400 at publish time. Validating here instead means a
 * bad generation fails at the seam, with a message naming the actual rule.
 */

/** Letters, digits, punctuation, math symbols, whitespace, and ™ © ®. */
const ETSY_TITLE_ILLEGAL = /[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/u
/** Letters, digits, whitespace, hyphen, apostrophe, and ™ © ®. No commas. */
const ETSY_TAG_ILLEGAL = /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/u
/** Letters, digits and whitespace only — "PLA-Plus" is rejected, "PLA Plus" is fine. */
const ETSY_MATERIAL_ILLEGAL = /[^\p{L}\p{Nd}\p{Zs}]/u

/** Etsy permits each of these characters at most once in a title. */
const ETSY_TITLE_ONCE_ONLY = ['%', ':', '&', '+'] as const

export const EtsyTitleSchema = z
  .string()
  .min(1)
  .max(140)
  .refine((t) => !ETSY_TITLE_ILLEGAL.test(t), {
    message: 'Title contains a character Etsy rejects (allowed: letters, digits, punctuation, math symbols, whitespace, ™ © ®)',
  })
  .superRefine((t, ctx) => {
    for (const ch of ETSY_TITLE_ONCE_ONLY) {
      const count = t.split(ch).length - 1
      if (count > 1) {
        ctx.addIssue({
          code: 'custom',
          message: `Etsy allows "${ch}" at most once in a title; found ${count}`,
        })
      }
    }
  })

/**
 * One Etsy tag. Named and exported because keyword research has to know whether
 * a mined phrase could be used as a tag *before* proposing it — asking the same
 * schema is what stops research and validation from drifting apart.
 */
export const EtsyTagSchema = z
  .string()
  .min(1)
  .max(20)
  .refine((t) => !ETSY_TAG_ILLEGAL.test(t), {
    message: 'Tag may contain only letters, digits, spaces, hyphens and apostrophes',
  })
  .refine((t) => !/^['-]/.test(t), {
    message: 'Etsy rejects tags that start with a hyphen or apostrophe',
  })

export const EtsyCopySchema = z.object({
  title: EtsyTitleSchema,
  description: z.string().min(1),
  /** At most 13 tags, 20 characters each, no commas. */
  tags: z.array(EtsyTagSchema).max(13),
  materials: z
    .array(
      z
        .string()
        .min(1)
        .max(45)
        .refine((m) => !ETSY_MATERIAL_ILLEGAL.test(m), {
          message: 'Material may contain only letters, digits and spaces — no hyphens or punctuation',
        }),
    )
    .max(13),
  /** Free-text category guess; resolved to a real taxonomy_id. */
  taxonomyHint: z.string().min(1),
})
export type EtsyCopy = z.infer<typeof EtsyCopySchema>

export const ListingCopySchema = z.object({
  ebay: EbayCopySchema,
  etsy: EtsyCopySchema,
})
export type ListingCopy = z.infer<typeof ListingCopySchema>

// ---------------------------------------------------------------------------
// eBay variations
// ---------------------------------------------------------------------------

/**
 * The safe subset of eBay's SKU alphabet, applied to the group key too.
 *
 * eBay caps SKUs at 50 characters and chokes on whitespace; the exact set of
 * tolerated special characters is not documented anywhere trustworthy, so this
 * sticks to the characters every marketplace system accepts. A SKU is the
 * seller's own warehouse handle — it has to survive CSV exports, label
 * printers and the Trading API alike.
 */
export const EbaySkuSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Za-z0-9._-]+$/, 'SKU may contain only letters, digits, dots, hyphens and underscores — no spaces')

/**
 * One colour variant of an eBay listing.
 *
 * A variant is its own inventory item on eBay: own SKU, own price, own
 * quantity, optionally its own photos (the gallery swaps on colour). Everything
 * else — title, description, the other aspects — is shared through the
 * inventory item group.
 */
export const EbayVariantSchema = z.object({
  /** Seller-entered. Also the eBay inventory SKU, so the charset is eBay's. */
  sku: EbaySkuSchema,
  /** The `Farbe` aspect value buyers pick from the dropdown. */
  colour: z.string().min(1).max(65),
  priceEur: z.number().positive().max(1_000_000),
  quantity: z.number().int().positive().max(100_000),
  /** HTTPS URLs for this colour's photos. Empty falls back to the shared set. */
  imageUrls: z.array(z.string()).default([]),
})
export type EbayVariant = z.infer<typeof EbayVariantSchema>

/**
 * The variant list, with the two uniqueness rules that would otherwise surface
 * as opaque eBay 400s: one inventory item per SKU, one dropdown entry per
 * colour.
 */
export const EbayVariantsSchema = z
  .array(EbayVariantSchema)
  .min(1)
  .superRefine((variants, ctx) => {
    const skus = new Set<string>()
    const colours = new Set<string>()
    for (const variant of variants) {
      const sku = variant.sku.toLowerCase()
      const colour = variant.colour.trim().toLowerCase()
      if (skus.has(sku)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate SKU "${variant.sku}" — each variant needs its own` })
      }
      if (colours.has(colour)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate colour "${variant.colour}" — one dropdown entry per colour` })
      }
      skus.add(sku)
      colours.add(colour)
    }
  })

/**
 * Rewritten copy waiting for a decision.
 *
 * A proposal is a *state*, not a side effect. Generating one must not touch the
 * live copy, and accepting it must apply exactly the text that was reviewed —
 * regenerating on acceptance would silently swap in something the seller never
 * saw, because the same prompt does not produce the same words twice.
 */
export const ProposalSchema = z.object({
  copy: ListingCopySchema,
  createdAt: z.string(),
  /** Which marketplaces' research it was written against. Empty means none. */
  basedOn: z.array(MarketplaceSchema),
})
export type Proposal = z.infer<typeof ProposalSchema>

/**
 * Alternative titles to choose between.
 *
 * Held separately from `proposal`: a proposal is a whole rewrite awaiting one
 * yes-or-no, whereas these are options for a single field that the seller picks
 * from and edits. Merging the two would force an all-or-nothing decision onto
 * the field where a choice is most useful.
 */
export const TitleOptionsSchema = z.object({
  ebay: z.array(z.string()),
  etsy: z.array(z.string()),
  createdAt: z.string(),
})
export type TitleOptions = z.infer<typeof TitleOptionsSchema>

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

// Defined in its own module to keep this file and `seo/types.ts` from importing
// each other; re-exported so every existing importer stays unchanged.
export { MarketplaceSchema }
export type { Marketplace } from './marketplace.js'

export const PublishStateSchema = z.enum(['draft', 'published', 'failed'])
export type PublishState = z.infer<typeof PublishStateSchema>

export const MarketplaceRecordSchema = z.object({
  marketplace: MarketplaceSchema,
  state: PublishStateSchema,
  /** eBay: offerId. Etsy: listing_id. Null until the remote draft exists. */
  remoteId: z.string().nullable(),
  /** eBay: the live listingId from publishOffer. Etsy: same as remoteId once active. */
  liveId: z.string().nullable(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
})
export type MarketplaceRecord = z.infer<typeof MarketplaceRecordSchema>

export const ListingRecordSchema = z.object({
  /** Local id, also used as the eBay SKU. */
  id: z.string(),
  sourceUrl: z.string().url(),
  source: SourceModelSchema,
  product: ProductInputSchema,
  copy: ListingCopySchema,
  /** Local paths of images staged for Etsy's multipart upload. */
  imagePaths: z.array(z.string()),
  /** Public HTTPS URLs for eBay, which fetches images itself rather than accepting uploads. */
  imageUrls: z.array(z.string()).default([]),
  /**
   * Whether the seller asserted rights the source page does not show.
   *
   * Persisted because later steps depend on it: with an override the listing
   * must not quote the page's licence, and the designer's own media stays
   * off-limits. `preflight` checks both.
   */
  licenseOverridden: z.boolean().default(false),
  /**
   * Whether the seller designed this model themselves.
   *
   * Authored, not derived — hence no `.catch()`. It gates Etsy entirely: since
   * 10.06.2025 Etsy's Creativity Standards require items to be "produced based
   * on a seller's original design", and a commercial licence from the designer
   * does not satisfy that. Etsy asks for authorship, not for usage rights —
   * two different things. Default `false` is the safe side.
   */
  ownDesign: z.boolean().default(false),
  /**
   * Whether the seller asserted that their licence covers the designer's
   * *images*, not only the model.
   *
   * Deliberately separate from `licenseOverridden`, because the two are
   * different claims and the common case grants only the first. MakerWorld's
   * membership agreement (§6.5.1/6.5.2) licenses "Model Collateral" — photos,
   * renders, descriptions — to MakerWorld itself and not to subscribers, so a
   * standard commercial membership does not carry the pictures. A creator can
   * grant them separately, and CC-BY-style licences carry them outright; both
   * are cases only the seller can know about.
   *
   * Authored, so no `.catch()`: a rights assertion that silently defaulted
   * itself back to `false` after a schema change would be confusing, and one
   * that silently defaulted to `true` would be indefensible.
   */
  sourceImagesLicensed: z.boolean().default(false),
  /**
   * The seller's explicit, per-listing acceptance of the Etsy own-design risk.
   *
   * Etsy's Creativity Standards ask for authorship; a commercial licence from
   * the designer answers a different question (whether the designer permits
   * the sale) and cannot satisfy them. This field records the seller's
   * deliberate decision to carry that platform risk anyway — for THIS listing.
   * It unlocks nothing but the own-design gate: the licence default-deny,
   * media reuse and every money invariant stay untouched.
   *
   * Recorded with the moment and the source URL so that, in a dispute, it is
   * provable on what basis the listing went live. Never global, never from a
   * config file; a draft without it stays blocked for Etsy.
   *
   * Authored, so no `.catch()` — the same rule as the two assertions above.
   */
  etsyDesignRiskAccepted: z
    .object({
      /** ISO 8601 — when the seller made the claim. */
      at: z.string(),
      /** The model page the claim was made for. */
      sourceUrl: z.string(),
    })
    .nullable()
    .default(null),
  /**
   * The keyword research the copy was written against, per marketplace.
   *
   * Persisted so a tag can be traced back to the evidence that justified it,
   * and so re-running the copywriter costs no further marketplace calls.
   * Defaulted rather than required, like `imageUrls` and `licenseOverridden`:
   * records written before research existed must still parse.
   */
  //
  // The three fields below are DERIVED and use `.catch(null)`, which the
  // authored fields above deliberately do not.
  //
  // Research output, a pending rewrite and title options are all regenerable
  // from a command. Their shapes will keep changing as the research improves,
  // and an older record carrying an older shape must not take the whole store
  // with it — which is exactly what happened when `priceBandEur` gained
  // required fields: one stale sub-object failed validation and `read()`
  // moved the user's entire listings.json aside.
  //
  // Degrading a regenerable field to null costs one command to rebuild.
  // Applying the same leniency to `copy`, `product` or `source` would lose work
  // that cannot be recovered, so those still fail loudly.
  seo: SeoEvidenceSchema.nullable().catch(null).default(null),
  /** Rewritten copy awaiting accept-or-discard. Never applied implicitly. */
  proposal: ProposalSchema.nullable().catch(null).default(null),
  /** Alternative titles offered in the editor. */
  titleOptions: TitleOptionsSchema.nullable().catch(null).default(null),
  /**
   * The resolved eBay leaf category.
   *
   * Persisted so preflight and publish stop resolving it independently — they
   * could otherwise check one category and list into another.
   */
  ebayCategoryId: z.string().nullable().catch(null).default(null),
  /**
   * Seller-entered SKU for the single-variant case. Null means the local id is
   * used, which was the only behaviour before this field existed.
   *
   * Authored — a warehouse identifier that silently reverted to the local id
   * would break the seller's own bookkeeping, so no `.catch()`.
   */
  sku: EbaySkuSchema.nullable().default(null),
  /**
   * Colour variants, eBay only for now. Null means a single-variant listing.
   *
   * Authored like `copy` and `product`: prices, quantities and SKUs the seller
   * typed must fail loudly rather than degrade — a variant list that silently
   * became null would publish a single listing where five were intended.
   */
  variants: EbayVariantsSchema.nullable().default(null),
  marketplaces: z.array(MarketplaceRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ListingRecord = z.infer<typeof ListingRecordSchema>
