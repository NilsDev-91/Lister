import { describe, it, expect } from 'vitest'
import { EtsyCopySchema, EtsyTitleSchema } from './types.js'

/**
 * These rules are enforced by Etsy's server but appear nowhere in its OpenAPI
 * schema, so they are exactly the ones that bite at publish time. Pinning them
 * here means a regression shows up in CI rather than as a 400.
 */

describe('Etsy title rules', () => {
  it('accepts a normal listing title', () => {
    expect(EtsyTitleSchema.safeParse('Articulated Dragon | 3D Printed Flexi Desk Toy').success).toBe(true)
  })

  it('allows a single ampersand but not two', () => {
    expect(EtsyTitleSchema.safeParse('Red & Blue Dragon').success).toBe(true)
    const twice = EtsyTitleSchema.safeParse('Red & Blue & Green Dragon')
    expect(twice.success).toBe(false)
    expect(JSON.stringify(twice.error?.issues)).toContain('at most once')
  })

  it('applies the once-only rule to % : and + as well', () => {
    expect(EtsyTitleSchema.safeParse('Dragon: Large: Teal').success).toBe(false)
    expect(EtsyTitleSchema.safeParse('100% PLA 50% Infill').success).toBe(false)
    expect(EtsyTitleSchema.safeParse('Dragon + Stand + Base').success).toBe(false)
  })

  it('rejects titles over 140 characters', () => {
    expect(EtsyTitleSchema.safeParse('a'.repeat(141)).success).toBe(false)
    expect(EtsyTitleSchema.safeParse('a'.repeat(140)).success).toBe(true)
  })

  it('rejects emoji, which Etsy does not permit in titles', () => {
    expect(EtsyTitleSchema.safeParse('Dragon Toy 🐉').success).toBe(false)
  })
})

describe('Etsy tag and material rules', () => {
  const base = {
    title: 'Articulated Dragon 3D Printed Toy',
    description: 'Printed to order.',
    taxonomyHint: 'Toys & Games',
  }

  it('accepts hyphens in tags but not in materials', () => {
    expect(
      EtsyCopySchema.safeParse({ ...base, tags: ['3d-printed'], materials: ['PLA'] }).success,
    ).toBe(true)

    const badMaterial = EtsyCopySchema.safeParse({ ...base, tags: [], materials: ['PLA-Plus'] })
    expect(badMaterial.success).toBe(false)
    expect(JSON.stringify(badMaterial.error?.issues)).toContain('no hyphens')
  })

  it('accepts the spaced form of a hyphenated material', () => {
    expect(EtsyCopySchema.safeParse({ ...base, tags: [], materials: ['PLA Plus'] }).success).toBe(true)
  })

  it('rejects a tag containing a comma', () => {
    expect(EtsyCopySchema.safeParse({ ...base, tags: ['dragon, toy'], materials: [] }).success).toBe(false)
  })

  it('rejects a tag starting with a hyphen or apostrophe, which Etsy refuses', () => {
    expect(EtsyCopySchema.safeParse({ ...base, tags: ['-dragon'], materials: [] }).success).toBe(false)
    expect(EtsyCopySchema.safeParse({ ...base, tags: ["'dragon"], materials: [] }).success).toBe(false)
    // In the middle both stay legal.
    expect(EtsyCopySchema.safeParse({ ...base, tags: ["dragon's lair"], materials: [] }).success).toBe(true)
  })

  it('caps tags at 13 and 20 characters each', () => {
    expect(
      EtsyCopySchema.safeParse({ ...base, tags: Array(14).fill('dragon'), materials: [] }).success,
    ).toBe(false)
    expect(
      EtsyCopySchema.safeParse({ ...base, tags: ['a'.repeat(21)], materials: [] }).success,
    ).toBe(false)
    expect(
      EtsyCopySchema.safeParse({ ...base, tags: ['a'.repeat(20)], materials: [] }).success,
    ).toBe(true)
  })
})
