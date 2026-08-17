import { describe, it, expect } from 'vitest'
import { matchTaxonomy, requireSaleRights } from './publish.js'
import type { TaxonomyNode } from '../marketplaces/etsy/client.js'
import type { ListingRecord } from '../types.js'

/**
 * The taxonomy matcher works on the *flattened* tree. The regression pinned
 * here: the API returns fifteen root nodes with the real categories nested in
 * `children`, and matching against the roots alone meant a hint like "Desk
 * Organizer" found nothing — the Etsy publish path failed for every specific
 * category.
 */

function node(id: number, name: string, path: string[], leaf: boolean): TaxonomyNode {
  return { id, name, path, leaf, level: path.length - 1 }
}

const NODES: TaxonomyNode[] = [
  node(1, 'Home & Living', ['Home & Living'], false),
  node(2, 'Storage & Organization', ['Home & Living', 'Storage & Organization'], false),
  node(3, 'Desk Organizers', ['Home & Living', 'Storage & Organization', 'Desk Organizers'], true),
  node(4, 'Home Decor', ['Home & Living', 'Home Decor'], false),
  node(5, 'Ornaments & Accents', ['Home & Living', 'Home Decor', 'Ornaments & Accents'], true),
]

describe('matchTaxonomy', () => {
  it('finds a nested category by exact name', () => {
    expect(matchTaxonomy(NODES, 'Desk Organizers')?.id).toBe(3)
  })

  it('prefers the deepest leaf over a shallower containment match', () => {
    // "organiz" is contained in both node 2 (branch) and node 3 (leaf).
    expect(matchTaxonomy(NODES, 'Organiz')?.id).toBe(3)
  })

  it('matches a hint that contains the category name', () => {
    expect(matchTaxonomy(NODES, 'Modern Home Decor')?.id).toBe(4)
  })

  it('returns undefined for an empty or unmatched hint', () => {
    expect(matchTaxonomy(NODES, '')).toBeUndefined()
    expect(matchTaxonomy(NODES, 'Bicycle Parts')).toBeUndefined()
  })
})

/**
 * Where the licence gate lives, and where it deliberately does not.
 *
 * Drafting under a restrictive licence is allowed — a draft is local and
 * publishes nothing, and the licence is often bought once the listing is ready.
 * That makes this function the whole protection, so it is pinned here: it must
 * hold even when preflight was skipped.
 */
function withLicence(commercialUse: 'yes' | 'no' | 'unknown', overridden = false): ListingRecord {
  return {
    source: { license: { raw: 'Standard Digital File License', commercialUse } },
    licenseOverridden: overridden,
  } as unknown as ListingRecord
}

describe('requireSaleRights', () => {
  it('refuses a licence that forbids the sale', () => {
    expect(() => requireSaleRights(withLicence('no'))).toThrow(/does not permit selling prints/i)
  })

  it('points at the rights switch rather than telling the seller to start over', () => {
    // The draft already exists by this point; sending them back to `create`
    // would throw away their edits for a field they can simply set.
    expect(() => requireSaleRights(withLicence('no'))).toThrow()
    try {
      requireSaleRights(withLicence('no'))
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/rights box on the listing page/i)
    }
  })

  it('lets the seller through once they have asserted the rights', () => {
    expect(() => requireSaleRights(withLicence('no', true))).not.toThrow()
  })

  it('does not stand in the way of a licence that permits the sale', () => {
    expect(() => requireSaleRights(withLicence('yes'))).not.toThrow()
  })

  it('lets an unreadable licence through — that is the confirm case, not a denial', () => {
    // `unknown` means we could not read the licence, which is a prompt-the-user
    // state. Treating it as a refusal here would block every model whose page
    // shape we do not recognise.
    expect(() => requireSaleRights(withLicence('unknown'))).not.toThrow()
  })
})
