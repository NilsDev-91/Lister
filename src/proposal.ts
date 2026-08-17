import type { ListingCopy, Marketplace } from './types.js'

/**
 * Turns two versions of the copy into a reviewable list of fields.
 *
 * Pure and shared, for the same reason the commands are shared: the CLI and the
 * web UI must show the *same* comparison. A preview that disagrees with what
 * gets written is worse than no preview, because it is trusted.
 */

export interface CopyField {
  /** Stable identifier, used by the UI for anchors and by tests. */
  key: string
  label: string
  marketplace: Marketplace
  before: string
  after: string
  changed: boolean
  /** Character ceiling where the marketplace enforces one. */
  limit?: number
  /** Long prose; renders as a block rather than side by side. */
  multiline: boolean
}

/**
 * Aspects are a map, and a map has no order.
 *
 * `Object.entries` follows insertion order, so a regenerated set with the same
 * content but a different key order would read as a change. Sorting makes the
 * comparison about content, which is what a reviewer is deciding on.
 */
function renderAspects(aspects: Record<string, string[]>): string {
  return Object.entries(aspects)
    .map(([name, values]) => [name, [...values].sort().join(', ')] as const)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, values]) => `${name}: ${values}`)
    .join('\n')
}

/**
 * Lists are compared as content, not as arrangement — but the *order* of Etsy
 * tags does not affect search, so a reordering is genuinely not a change.
 */
function renderList(values: string[]): string {
  return [...values].sort().join(', ')
}

export function diffCopy(before: ListingCopy, after: ListingCopy): CopyField[] {
  const fields: Omit<CopyField, 'changed'>[] = [
    {
      key: 'ebayTitle',
      label: 'eBay — Titel',
      marketplace: 'ebay',
      before: before.ebay.title,
      after: after.ebay.title,
      limit: 80,
      multiline: false,
    },
    {
      key: 'ebayDesc',
      label: 'eBay — Beschreibung',
      marketplace: 'ebay',
      before: before.ebay.descriptionHtml,
      after: after.ebay.descriptionHtml,
      multiline: true,
    },
    {
      key: 'ebayAspects',
      label: 'eBay — Merkmale',
      marketplace: 'ebay',
      before: renderAspects(before.ebay.aspects),
      after: renderAspects(after.ebay.aspects),
      multiline: true,
    },
    {
      // In the diff because `mergeCopy` applies it: a field the accept step
      // writes but the review never showed would be an unreviewed change — and
      // a proposal changing *only* the hint would read as "identical" and be
      // impossible to accept.
      key: 'ebayCategoryHint',
      label: 'eBay — Kategorie-Hinweis',
      marketplace: 'ebay',
      before: before.ebay.categoryHint,
      after: after.ebay.categoryHint,
      multiline: false,
    },
    {
      key: 'etsyTitle',
      label: 'Etsy — Titel',
      marketplace: 'etsy',
      before: before.etsy.title,
      after: after.etsy.title,
      limit: 140,
      multiline: false,
    },
    {
      key: 'etsyDesc',
      label: 'Etsy — Beschreibung',
      marketplace: 'etsy',
      before: before.etsy.description,
      after: after.etsy.description,
      multiline: true,
    },
    {
      key: 'etsyTags',
      label: 'Etsy — Tags',
      marketplace: 'etsy',
      before: renderList(before.etsy.tags),
      after: renderList(after.etsy.tags),
      multiline: false,
    },
    {
      key: 'etsyMaterials',
      label: 'Etsy — Materialien',
      marketplace: 'etsy',
      before: renderList(before.etsy.materials),
      after: renderList(after.etsy.materials),
      multiline: false,
    },
    {
      key: 'etsyTaxonomyHint',
      label: 'Etsy — Kategorie-Hinweis',
      marketplace: 'etsy',
      before: before.etsy.taxonomyHint,
      after: after.etsy.taxonomyHint,
      multiline: false,
    },
  ]

  return fields.map((f) => ({ ...f, changed: f.before !== f.after }))
}

/** Only the marketplaces a proposal would actually alter. */
export function changedMarketplaces(fields: CopyField[]): Marketplace[] {
  const out = new Set<Marketplace>()
  for (const field of fields) if (field.changed) out.add(field.marketplace)
  return [...out].sort()
}

/**
 * Keeps one marketplace's proposed copy and leaves the other as it was.
 *
 * The case this exists for: research ran for Etsy but not for eBay, so the eBay
 * half of the rewrite rests on nothing but the model's judgement. Accepting the
 * evidenced half and declining the rest should not require regenerating either.
 */
export function mergeCopy(current: ListingCopy, proposed: ListingCopy, accept: Marketplace[]): ListingCopy {
  return {
    ebay: accept.includes('ebay') ? proposed.ebay : current.ebay,
    etsy: accept.includes('etsy') ? proposed.etsy : current.etsy,
  }
}
