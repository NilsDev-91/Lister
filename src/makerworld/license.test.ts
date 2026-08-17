import { describe, it, expect } from 'vitest'
import { normaliseLicense, gate, requiresAttribution } from './license.js'

describe('normaliseLicense', () => {
  it('treats plain CC BY as commercial-friendly', () => {
    const l = normaliseLicense('CC BY 4.0')
    expect(l.code).toBe('CC-BY-4.0')
    expect(l.commercialUse).toBe('yes')
  })

  it('does not mistake CC BY-NC-SA for CC BY-NC or CC BY', () => {
    const l = normaliseLicense('CC BY-NC-SA 4.0')
    expect(l.code).toBe('CC-BY-NC-SA-4.0')
    expect(l.commercialUse).toBe('no')
  })

  it('does not mistake CC BY-SA for plain CC BY', () => {
    const l = normaliseLicense('Creative Commons — Attribution-ShareAlike')
    expect(l.code).toBe('CC-BY-SA-4.0')
    expect(l.commercialUse).toBe('yes')
  })

  it('blocks the NonCommercial variants', () => {
    for (const raw of ['CC BY-NC 4.0', 'CC BY-NC-ND 4.0', 'cc-by-nc-sa']) {
      expect(normaliseLicense(raw).commercialUse).toBe('no')
    }
  })

  it('blocks the Bambu Standard Digital File License', () => {
    const l = normaliseLicense('Standard Digital File License')
    expect(l.code).toBe('BAMBU-SDFL')
    expect(l.commercialUse).toBe('no')
  })

  it('allows CC0', () => {
    expect(normaliseLicense('CC0 1.0 Universal').commercialUse).toBe('yes')
  })

  it('reports unknown rather than guessing', () => {
    expect(normaliseLicense('Some Bespoke Licence v2').commercialUse).toBe('unknown')
    expect(normaliseLicense('').commercialUse).toBe('unknown')
  })

  it('is not fooled by licence strings that name Object.prototype members', () => {
    // The string comes off a web page. A plain-object lookup would return the
    // inherited `constructor` function here and break every field after it.
    for (const raw of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(normaliseLicense(raw).commercialUse, raw).toBe('unknown')
    }
  })
})

describe("MakerWorld's own licence vocabulary", () => {
  // These are the literal strings that appear in design.license. The Creative
  // Commons ones are BARE — no "CC" prefix — which is exactly what a
  // CC-anchored regex would miss.
  it('reads the bare commercial-friendly values', () => {
    for (const [raw, code] of [
      ['CC0', 'CC0-1.0'],
      ['BY', 'CC-BY-4.0'],
      ['BY-SA', 'CC-BY-SA-4.0'],
      ['BY-ND', 'CC-BY-ND-4.0'],
    ] as const) {
      const l = normaliseLicense(raw)
      expect(l.code, `${raw} should map to ${code}`).toBe(code)
      expect(l.commercialUse, `${raw} permits commercial use`).toBe('yes')
    }
  })

  it('reads the bare NonCommercial values', () => {
    for (const raw of ['BY-NC', 'BY-NC-SA', 'BY-NC-ND']) {
      const l = normaliseLicense(raw)
      expect(l.commercialUse, `${raw} forbids commercial use`).toBe('no')
      expect(l.code).not.toBeNull()
    }
  })

  it('blocks every Bambu and MakerWorld proprietary licence', () => {
    for (const raw of [
      'Standard Digital File License',
      'Standard Digital File License - Community Use',
      'Standard Digital File License - Platform Print Only (SDFL-PPO)',
      'MakerWorld Exclusive License',
    ]) {
      expect(normaliseLicense(raw).commercialUse, `${raw} forbids selling prints`).toBe('no')
    }
  })

  it('never returns unknown for a value MakerWorld can actually emit', () => {
    const all = [
      'CC0', 'BY', 'BY-SA', 'BY-ND', 'BY-NC', 'BY-NC-SA', 'BY-NC-ND',
      'Standard Digital File License',
      'Standard Digital File License - Community Use',
      'Standard Digital File License - Platform Print Only (SDFL-PPO)',
      'MakerWorld Exclusive License',
    ]
    for (const raw of all) {
      expect(normaliseLicense(raw).commercialUse, `${raw} must resolve`).not.toBe('unknown')
    }
  })
})

describe('gate', () => {
  it('unlocks image and text reuse only for commercial licences', () => {
    const d = gate(normaliseLicense('CC BY 4.0'))
    expect(d.mayReuseImages).toBe(true)
    expect(d.mayReuseText).toBe(true)
    expect(d.needsConfirmation).toBe(false)
  })

  it('falls back to manual selection for NonCommercial', () => {
    const d = gate(normaliseLicense('CC BY-NC 4.0'))
    expect(d.mayReuseImages).toBe(false)
    expect(d.needsConfirmation).toBe(true)
  })

  it('treats unknown as blocked, not as allowed', () => {
    const d = gate(normaliseLicense('mystery licence'))
    expect(d.mayReuseImages).toBe(false)
    expect(d.mayReuseText).toBe(false)
  })

  it('still asks for confirmation when overridden', () => {
    const d = gate(normaliseLicense('CC BY-NC 4.0'), true)
    expect(d.needsConfirmation).toBe(true)
    expect(d.overridden).toBe(true)
  })

  it('does not unlock the designer\'s media just because selling rights were bought', () => {
    // A commercial licence bought from a creator covers the model. The photos
    // and description on the page are separate content that stays theirs —
    // MakerWorld's own agreement licenses that "Model Collateral" to MakerWorld,
    // not to subscribers. Reusing it is a takedown risk of its own.
    const d = gate(normaliseLicense('Standard Digital File License'), true)
    expect(d.mayReuseImages).toBe(false)
    expect(d.mayReuseText).toBe(false)
  })

  it('marks non-overridden decisions as such, so copy can name the licence', () => {
    expect(gate(normaliseLicense('CC BY 4.0')).overridden).toBe(false)
    expect(gate(normaliseLicense('BY-NC')).overridden).toBe(false)
  })
})

describe('the separate claim on the designer\'s images', () => {
  const sdfl = normaliseLicense('Standard Digital File License')

  it('unlocks the images only when both claims are made', () => {
    // Two assertions, deliberately not one. Selling rights are the common case;
    // rights to the creator's photographs are the rare one, and a seller who
    // ticks the first must not silently be saying the second.
    expect(gate(sdfl, true, true).mayReuseImages).toBe(true)
    expect(gate(sdfl, true, false).mayReuseImages).toBe(false)
  })

  it('is inert without the selling claim it depends on', () => {
    // Pictures cannot be licensed for a sale that is not.
    expect(gate(sdfl, false, true).mayReuseImages).toBe(false)
  })

  it('never unlocks the description text, which was not what was claimed', () => {
    expect(gate(sdfl, true, true).mayReuseText).toBe(false)
  })

  it('says in its reason which claims the sale rests on', () => {
    expect(gate(sdfl, true, true).reason).toMatch(/images are both on you/i)
    expect(gate(sdfl, true, false).reason).toMatch(/images and text remain off-limits/i)
  })

  it('changes nothing where the licence already permits reuse', () => {
    for (const asserted of [false, true]) {
      expect(gate(normaliseLicense('CC BY 4.0'), false, asserted).mayReuseImages).toBe(true)
    }
  })
})

describe('requiresAttribution', () => {
  it('is false only for CC0', () => {
    expect(requiresAttribution(normaliseLicense('CC0 1.0'))).toBe(false)
    expect(requiresAttribution(normaliseLicense('CC BY 4.0'))).toBe(true)
    expect(requiresAttribution(normaliseLicense('unknown'))).toBe(true)
  })
})

describe('NoDerivatives plural (CC 4.0 official spelling)', () => {
  it('keeps the ND flag for "Attribution-NoDerivatives"', () => {
    const info = normaliseLicense('Attribution-NoDerivatives')
    expect(info.code).toBe('CC-BY-ND-4.0')
  })
})
