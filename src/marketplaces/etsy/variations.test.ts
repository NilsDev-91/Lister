import { describe, it, expect } from 'vitest'
import { buildVariationInventory, ETSY_CUSTOM_VARIATION_PROPERTY } from './client.js'

/**
 * The contract pinned here is the `*_on_property` coupling: Etsy rejects the
 * whole inventory update when products differ in sku, price or quantity while
 * the matching `*_on_property` array does not name the property they differ
 * by. Getting one of the three arrays wrong is a 400 with a one-line error.
 */

const VARIANTS = [
  { sku: 'WW-MOOS-40-SW', colour: 'Schwarz', priceEur: 8.9, quantity: 5 },
  { sku: 'WW-MOOS-40-WS', colour: 'Weiss', priceEur: 9.9, quantity: 3 },
]

describe('buildVariationInventory', () => {
  it('builds one product per colour with sku, price and quantity', () => {
    const body = buildVariationInventory(VARIANTS)
    expect(body.products).toEqual([
      {
        sku: 'WW-MOOS-40-SW',
        property_values: [
          { property_id: ETSY_CUSTOM_VARIATION_PROPERTY, property_name: 'Farbe', values: ['Schwarz'] },
        ],
        offerings: [{ price: 8.9, quantity: 5, is_enabled: true }],
      },
      {
        sku: 'WW-MOOS-40-WS',
        property_values: [
          { property_id: ETSY_CUSTOM_VARIATION_PROPERTY, property_name: 'Farbe', values: ['Weiss'] },
        ],
        offerings: [{ price: 9.9, quantity: 3, is_enabled: true }],
      },
    ])
  })

  it('declares price, quantity AND sku as varying by the colour property', () => {
    // All three vary per colour in this tool, so all three arrays must name the
    // property — omitting one is the documented failure mode of the endpoint.
    const body = buildVariationInventory(VARIANTS)
    expect(body.price_on_property).toEqual([ETSY_CUSTOM_VARIATION_PROPERTY])
    expect(body.quantity_on_property).toEqual([ETSY_CUSTOM_VARIATION_PROPERTY])
    expect(body.sku_on_property).toEqual([ETSY_CUSTOM_VARIATION_PROPERTY])
  })

  it('sends the price as a plain float, not a Money object', () => {
    const body = buildVariationInventory([{ sku: 'A-1', colour: 'Rot', priceEur: 12.5, quantity: 1 }])
    const offering = (body.products[0] as { offerings: { price: unknown }[] }).offerings[0]
    expect(offering?.price).toBe(12.5)
  })
})
