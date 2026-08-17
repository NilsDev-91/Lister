import { describe, it, expect } from 'vitest'
import { changedMarketplaces, diffCopy, mergeCopy } from './proposal.js'
import type { ListingCopy } from './types.js'

function copy(over: { ebay?: Partial<ListingCopy['ebay']>; etsy?: Partial<ListingCopy['etsy']> } = {}): ListingCopy {
  return {
    ebay: {
      title: 'Dartshalter schlank 3D-Druck PLA schwarz',
      descriptionHtml: '<p>Ein Halter.</p>',
      categoryHint: 'Dartzubehör',
      aspects: { Marke: ['Markenlos'], Material: ['PLA'] },
      ...over.ebay,
    },
    etsy: {
      title: 'Slim Dart Holder, 3D Printed in Black PLA',
      description: 'A slim dart holder.',
      tags: ['dart holder', 'dart display'],
      materials: ['PLA'],
      taxonomyHint: 'Home Decor',
      ...over.etsy,
    },
  }
}

function field(fields: ReturnType<typeof diffCopy>, key: string) {
  return fields.find((f) => f.key === key)
}

describe('diffCopy', () => {
  it('reports nothing changed when the copy is identical', () => {
    const fields = diffCopy(copy(), copy())
    expect(fields.every((f) => !f.changed)).toBe(true)
    expect(changedMarketplaces(fields)).toEqual([])
  })

  it('does not treat a reordered aspect map as a change', () => {
    // `Object.entries` follows insertion order, so a regenerated set with the
    // same content in a different order would otherwise read as an edit and ask
    // the seller to approve nothing.
    const before = copy({ ebay: { aspects: { Marke: ['Markenlos'], Material: ['PLA'] } } })
    const after = copy({ ebay: { aspects: { Material: ['PLA'], Marke: ['Markenlos'] } } })
    expect(field(diffCopy(before, after), 'ebayAspects')?.changed).toBe(false)
  })

  it('does treat a changed aspect value as a change', () => {
    const after = copy({ ebay: { aspects: { Marke: ['Markenlos'], Material: ['PETG'] } } })
    expect(field(diffCopy(copy(), after), 'ebayAspects')?.changed).toBe(true)
  })

  it('does not treat reordered tags as a change', () => {
    // Tag order does not affect Etsy search, so a reshuffle is genuinely not an
    // edit worth a decision.
    const after = copy({ etsy: { tags: ['dart display', 'dart holder'] } })
    expect(field(diffCopy(copy(), after), 'etsyTags')?.changed).toBe(false)
  })

  it('does treat a different tag as a change', () => {
    const after = copy({ etsy: { tags: ['dart holder', 'dart stand'] } })
    expect(field(diffCopy(copy(), after), 'etsyTags')?.changed).toBe(true)
  })

  it('carries the character limit the marketplace enforces', () => {
    const fields = diffCopy(copy(), copy())
    expect(field(fields, 'ebayTitle')?.limit).toBe(80)
    expect(field(fields, 'etsyTitle')?.limit).toBe(140)
    // Descriptions have no hard ceiling, so claiming one would be a fiction.
    expect(field(fields, 'etsyDesc')?.limit).toBeUndefined()
  })

  it('names only the marketplaces the rewrite actually touches', () => {
    const after = copy({ etsy: { title: 'Dart Holder in Black PLA, Slim 3D Printed Display' } })
    expect(changedMarketplaces(diffCopy(copy(), after))).toEqual(['etsy'])
  })
})

describe('mergeCopy', () => {
  it('accepts one marketplace and leaves the other exactly as it was', () => {
    // The case this exists for: Etsy research ran, eBay research did not, so
    // half the rewrite is evidenced and half is the model's guess.
    const current = copy()
    const proposed = copy({
      ebay: { title: 'Anderer eBay-Titel' },
      etsy: { title: 'A different Etsy title' },
    })

    const merged = mergeCopy(current, proposed, ['etsy'])
    expect(merged.etsy.title).toBe('A different Etsy title')
    expect(merged.ebay.title).toBe(current.ebay.title)
  })

  it('accepts both when both are named', () => {
    const proposed = copy({ ebay: { title: 'Neu' }, etsy: { title: 'New' } })
    const merged = mergeCopy(copy(), proposed, ['ebay', 'etsy'])
    expect(merged.ebay.title).toBe('Neu')
    expect(merged.etsy.title).toBe('New')
  })

  it('changes nothing when no marketplace is named', () => {
    const current = copy()
    expect(mergeCopy(current, copy({ ebay: { title: 'Neu' } }), [])).toEqual(current)
  })
})
