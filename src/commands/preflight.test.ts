import { describe, it, expect } from 'vitest'
import { auditContent } from './preflight.js'
import { EbayTitleSchema, ListingRecordSchema, type ListingRecord } from '../types.js'

/**
 * The rights checks are the reason preflight exists, so they are pinned here.
 * Everything in this file runs offline — the marketplace checks need a token
 * and are exercised by running the command.
 */

/**
 * Built through the schema so optional fields take their declared defaults —
 * otherwise every new one added to the record breaks this fixture.
 */
function listing(overrides: Partial<ListingRecord> = {}): ListingRecord {
  const now = new Date().toISOString()
  return ListingRecordSchema.parse({
    id: 'mw-1-abc',
    sourceUrl: 'https://makerworld.com/en/models/1',
    source: {
      sourceUrl: 'https://makerworld.com/en/models/1',
      externalId: '1',
      title: 'Dart Holder',
      description: '',
      designer: 'OMMO',
      tags: [],
      images: [],
      license: {
        raw: 'Standard Digital File License',
        code: 'BAMBU-SDFL',
        commercialUse: 'no',
        reason: 'personal use only',
      },
      fetchedAt: now,
    },
    product: {
      priceEur: 20.99,
      quantity: 1,
      material: 'PLA',
      colour: 'Schwarz',
      dimensionsMm: null,
      weightGrams: null,
      processingDays: 3,
      notes: '',
    },
    copy: {
      ebay: {
        title: 'Dartpfeilhalter Wandhalterung 3D-Druck',
        descriptionHtml: '<p>Von mir gedruckt.</p>',
        categoryHint: 'Dart Zubehör',
        aspects: { Marke: ['Markenlos'] },
      },
      etsy: {
        title: 'Dart Holder Wall Mount',
        description: 'Printed by me.',
        tags: Array.from({ length: 13 }, (_, i) => `tag${i}`),
        materials: ['PLA'],
        taxonomyHint: 'Home Decor',
      },
    },
    imagePaths: [],
    imageUrls: ['https://cdn.example.com/own-photo.jpg'],
    licenseOverridden: false,
    marketplaces: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}

/** The fixture under a licence that permits the sale, for the mechanical checks. */
function permitted(overrides: Partial<ListingRecord> = {}): ListingRecord {
  const record = listing(overrides)
  record.source.license = { raw: 'BY', code: 'CC-BY-4.0', commercialUse: 'yes', reason: 'ok' }
  return record
}

describe('preflight rights checks', () => {
  it("blocks reuse of the designer's images when rights were asserted separately", () => {
    const report = auditContent(
      listing({
        licenseOverridden: true,
        imageUrls: ['https://makerworld.bblmw.com/makerworld/model/x/design/a.png'],
      }),
      ['ebay'],
    )

    const blocker = report.blockers.find((b) => /designer's own images/i.test(b.title))
    expect(blocker, 'MakerWorld-hosted images must be blocked').toBeDefined()
    expect(blocker?.detail).toMatch(/VeRO/)
  })

  it("blocks the designer's images when the licence itself forbids reuse", () => {
    // The regression this guards: the check used to run only for listings the
    // seller had overridden, so a personal-use-only licence — the case with the
    // least right to those photos — was never examined at all. A listing went
    // live carrying seven MakerWorld CDN images because of it.
    const report = auditContent(
      listing({
        licenseOverridden: false,
        imageUrls: ['https://makerworld.bblmw.com/makerworld/model/x/design/a.png'],
      }),
      ['ebay'],
    )
    expect(report.blockers.map((b) => b.title)).toContain("Listing uses the designer's own images")
  })

  it('names the licence rather than a purchase when there was no override', () => {
    const report = auditContent(
      listing({
        licenseOverridden: false,
        imageUrls: ['https://makerworld.bblmw.com/makerworld/model/x/design/a.png'],
      }),
      ['ebay'],
    )
    const finding = report.blockers.find((b) => b.title === "Listing uses the designer's own images")
    expect(finding?.detail).toContain('Standard Digital File License')
  })

  it('accepts the seller\'s own hosted images under the same override', () => {
    const report = auditContent(listing({ licenseOverridden: true }), ['ebay'])
    expect(report.blockers.map((b) => b.title)).not.toContain("Listing uses the designer's own images")
  })

  it("blocks Cults3D-hosted images the same way as MakerWorld's", () => {
    // The host list is per source platform, not per MakerWorld: a designer's
    // render is a designer's render whichever CDN serves it. These are the
    // three hosts real Cults3D responses actually use (see
    // sources/cults3d/__fixtures__/creation-flexi-turtle.json).
    for (const url of [
      'https://images.cults3d.com/abc=/516x516/filters:no_upscale()/https://fbi.cults3d.com/x/img.png',
      'https://videos.cults3d.com/abc=/516x516/x/turtle.gif',
      'https://fbi.cults3d.com/uploaders/1/illustration-file/x/img.png',
    ]) {
      const report = auditContent(listing({ licenseOverridden: true, imageUrls: [url] }), ['ebay'])
      expect(report.blockers.map((b) => b.title), url).toContain("Listing uses the designer's own images")
    }
  })

  it('blocks copy that names a Cults3D licence under separate rights', () => {
    const withLicence = listing({ licenseOverridden: true })
    withLicence.copy.ebay.descriptionHtml = '<p>Lizenz: CULTS PU - Private Use.</p>'
    const report = auditContent(withLicence, ['ebay'])
    expect(report.blockers.some((b) => /names a licence/i.test(b.title))).toBe(true)
  })

  it('blocks copy that names a licence when the sale runs under separate rights', () => {
    const withLicence = listing({ licenseOverridden: true })
    withLicence.copy.ebay.descriptionHtml = '<p>Gedruckt unter der Standard Digital File License.</p>'

    const report = auditContent(withLicence, ['ebay'])
    expect(report.blockers.some((b) => /names a licence/i.test(b.title))).toBe(true)
  })

  it('leaves licence mentions alone when the page licence really is the operative one', () => {
    // A CC-BY model genuinely is sold under that licence, and naming it is the
    // attribution the licence asks for — not a contradiction.
    const ccBy = permitted()
    ccBy.copy.ebay.descriptionHtml = '<p>Design by X, CC BY 4.0.</p>'

    const report = auditContent(ccBy, ['ebay'])
    expect(report.blockers).toHaveLength(0)
  })
})

describe('Etsy eligibility', () => {
  const isGate = (title: string) => /third-party designs/i.test(title)

  it('blocks a third-party design on Etsy', () => {
    expect(auditContent(listing({ ownDesign: false }), ['etsy']).blockers.some((b) => isGate(b.title))).toBe(true)
  })

  it('leaves eBay alone — it has no equivalent restriction', () => {
    expect(auditContent(listing({ ownDesign: false }), ['ebay']).blockers.some((b) => isGate(b.title))).toBe(false)
  })

  it('lets the seller own design through', () => {
    expect(auditContent(listing({ ownDesign: true }), ['etsy']).blockers.some((b) => isGate(b.title))).toBe(false)
  })

  it('is not cured by a commercial licence', () => {
    // The whole point: Etsy asks for authorship, the override is about usage
    // rights. Holding a commercial licence changes nothing here.
    const report = auditContent(listing({ ownDesign: false, licenseOverridden: true }), ['etsy'])
    expect(report.blockers.some((b) => isGate(b.title))).toBe(true)
  })
})

describe('preflight mechanical checks', () => {
  it('blocks a missing eBay image URL and a non-HTTPS one', () => {
    expect(auditContent(listing({ imageUrls: [] }), ['ebay']).blockers.some((b) => /no images/i.test(b.title))).toBe(true)
    expect(
      auditContent(listing({ imageUrls: ['http://cdn.example.com/a.jpg'] }), ['ebay']).blockers.some((b) =>
        /not HTTPS/i.test(b.title),
      ),
    ).toBe(true)
  })

  it('blocks an over-long eBay title but treats a full one as correct', () => {
    const tooLong = listing()
    tooLong.copy.ebay.title = 'x'.repeat(81)
    expect(auditContent(tooLong, ['ebay']).blockers.some((b) => /too long/i.test(b.title))).toBe(true)

    // A near-full title used to draw a warning for having "no room left". That
    // is backwards: eBay's own advice is to use the full 80 characters, so the
    // warning belongs on an under-used title instead.
    const full = permitted()
    full.copy.ebay.title = 'Dartshalter schlank 3D-Druck PLA schwarz Dartpfeile Halter Dart Zubehoer Deko'
    const report = auditContent(full, ['ebay'])
    expect(report.blockers).toHaveLength(0)
    expect(report.findings.some((f) => /unused/i.test(f.title))).toBe(false)
  })

  it('warns about an under-used title, not a full one', () => {
    const short = listing()
    short.copy.ebay.title = 'Dartshalter'
    expect(auditContent(short, ['ebay']).findings.some((f) => /unused/i.test(f.title))).toBe(true)
  })

  it('rejects a question mark and an emoji in the eBay title at the schema', () => {
    // Policy id=4243 forbids the question mark outright; emoji cost up to four
    // times the click rate. Both are hard rules, so they never reach preflight.
    expect(EbayTitleSchema.safeParse('Dartshalter kaputt?').success).toBe(false)
    expect(EbayTitleSchema.safeParse('Dartshalter 🎯 schlank').success).toBe(false)
    expect(EbayTitleSchema.safeParse('Dartshalter schlank 3D-Druck PLA schwarz').success).toBe(true)
  })

  it('warns about symbols, shouting and repeated words', () => {
    const noisy = listing()
    noisy.copy.ebay.title = 'DARTSHALTER! Dart Halter Dart Zubehoer | PLA'
    const findings = auditContent(noisy, ['ebay']).findings.map((f) => f.title)
    expect(findings.some((t) => /symbols/i.test(t))).toBe(true)
    expect(findings.some((t) => /capitals/i.test(t))).toBe(true)
    expect(findings.some((t) => /repeats/i.test(t))).toBe(true)
  })

  it('does not mistake a material acronym for shouting', () => {
    // PETG is four capitals and spelt correctly — flagging it told the seller
    // to miswrite their own material.
    const petg = permitted()
    petg.copy.ebay.title = 'Dartshalter schlank aus PETG schwarz Dartpfeile Wandhalterung Zubehoer'
    expect(auditContent(petg, ['ebay']).findings.some((f) => /capitals/i.test(f.title))).toBe(false)
  })

  it('blocks missing eBay brand specifics', () => {
    const noBrand = listing()
    noBrand.copy.ebay.aspects = { Farbe: ['Schwarz'] }
    expect(auditContent(noBrand, ['ebay']).blockers.some((b) => /Marke/.test(b.title))).toBe(true)
  })

  it('blocks Etsy without staged image files', () => {
    expect(auditContent(listing(), ['etsy']).blockers.some((b) => /Etsy has no images/i.test(b.title))).toBe(true)
  })

  it('only checks the marketplaces asked for', () => {
    // No Etsy images staged, but Etsy was not requested.
    expect(auditContent(permitted(), ['ebay']).blockers).toHaveLength(0)
  })

  it('blocks active content and off-eBay links in the eBay description', () => {
    const scripted = listing()
    scripted.copy.ebay.descriptionHtml = '<p>Hi</p><script>alert(1)</script>'
    expect(auditContent(scripted, ['ebay']).blockers.some((b) => /active content/i.test(b.title))).toBe(true)

    const linked = listing()
    linked.copy.ebay.descriptionHtml = '<a href="https://example.com/shop">Mein Shop</a>'
    expect(auditContent(linked, ['ebay']).blockers.some((b) => /links away/i.test(b.title))).toBe(true)
  })

  it('warns when an eBay listing rides on a single image', () => {
    const report = auditContent(permitted({ imageUrls: ['https://cdn.example.com/only-one.jpg'] }), ['ebay'])
    expect(report.blockers).toHaveLength(0)
    expect(report.findings.some((f) => /single image/i.test(f.title))).toBe(true)
  })

  it('warns about an Etsy title past 15 words', () => {
    const wordy = listing({ ownDesign: true })
    wordy.copy.etsy.title = Array.from({ length: 16 }, (_, i) => `word${i}`).join(' ')
    expect(auditContent(wordy, ['etsy']).findings.some((f) => /15 words/i.test(f.title))).toBe(true)
  })

  it('warns about single-word Etsy tags — a phrase covers strictly more searches', () => {
    const single = listing({ ownDesign: true })
    single.copy.etsy.tags = ['dragon', 'articulated dragon']
    const report = auditContent(single, ['etsy'])
    const finding = report.findings.find((f) => /single words/i.test(f.title))
    expect(finding).toBeDefined()
    expect(finding?.detail).toContain('"dragon"')
    expect(finding?.detail).not.toContain('"articulated dragon"')
  })
})

describe('licence sale gate', () => {
  it('blocks a forbidden licence outright, on both marketplaces', () => {
    // The fixture's licence is SDFL with commercialUse "no" and no override —
    // the sale itself is the violation, before any field is examined.
    for (const marketplace of ['ebay', 'etsy'] as const) {
      const report = auditContent(listing(), [marketplace])
      expect(report.blockers.some((b) => /forbids selling/i.test(b.title)), marketplace).toBe(true)
    }
  })

  it('accepts the same listing once rights are asserted separately', () => {
    const report = auditContent(listing({ licenseOverridden: true }), ['ebay'])
    expect(report.blockers.some((b) => /forbids selling/i.test(b.title))).toBe(false)
  })

  it('does not block a licence that permits the sale', () => {
    const permitted = listing()
    permitted.source.license = { raw: 'BY', code: 'CC-BY-4.0', commercialUse: 'yes', reason: 'ok' }
    const report = auditContent(permitted, ['ebay'])
    expect(report.blockers.some((b) => /forbids selling/i.test(b.title))).toBe(false)
  })

  it('leaves an unknown licence at a warning-free pass-through — routing, not judgement', () => {
    const unknown = listing()
    unknown.source.license = { raw: 'Bespoke terms', code: null, commercialUse: 'unknown', reason: 'unrecognised' }
    const report = auditContent(unknown, ['ebay'])
    expect(report.blockers.some((b) => /forbids selling/i.test(b.title))).toBe(false)
  })
})

describe('the Etsy design-risk override', () => {
  const isGate = (title: string) => /third-party designs/i.test(title)
  const RISK = { at: '2026-08-18T10:00:00.000Z', sourceUrl: 'https://makerworld.com/en/models/1' }

  it('clears the design gate when the risk is recorded', () => {
    const report = auditContent(listing({ ownDesign: false, etsyDesignRiskAccepted: RISK }), ['etsy'])
    expect(report.blockers.some((b) => isGate(b.title))).toBe(false)
  })

  it('keeps the assertion visible as a warning on every run', () => {
    // Deliberately a warning, never an ok: the listing stands on a claim, not
    // on a verified condition, and that difference must not fade.
    const report = auditContent(listing({ ownDesign: false, etsyDesignRiskAccepted: RISK }), ['etsy'])
    const warning = report.findings.find((f) => /accepted design risk/i.test(f.title))
    expect(warning?.severity).toBe('warning')
    expect(warning?.detail).toContain('2026-08-18')
  })

  it('does not touch the licence gate — SDFL still blocks the sale', () => {
    const report = auditContent(listing({ ownDesign: false, etsyDesignRiskAccepted: RISK }), ['etsy'])
    expect(report.blockers.some((b) => /licence forbids selling/i.test(b.title))).toBe(true)
  })

  it('does not unlock the designer media — their images still block', () => {
    const report = auditContent(
      listing({
        etsyDesignRiskAccepted: RISK,
        imageUrls: ['https://makerworld.bblmw.com/makerworld/model/x/design/a.png'],
      }),
      ['ebay', 'etsy'],
    )
    expect(report.blockers.map((b) => b.title)).toContain("Listing uses the designer's own images")
  })

  it('changes nothing on eBay', () => {
    const withRisk = auditContent(listing({ etsyDesignRiskAccepted: RISK }), ['ebay'])
    const without = auditContent(listing({}), ['ebay'])
    expect(withRisk.findings.map((f) => f.title)).toEqual(without.findings.map((f) => f.title))
  })

  it('the commercial-rights override still does not open the design gate', () => {
    const report = auditContent(listing({ ownDesign: false, licenseOverridden: true }), ['etsy'])
    expect(report.blockers.some((b) => isGate(b.title))).toBe(true)
  })
})

describe('the Etsy own-images rule', () => {
  const RISK = { at: '2026-08-18T10:00:00.000Z', sourceUrl: 'https://makerworld.com/en/models/1' }

  it('blocks when every staged file is a source-platform download — override or not', () => {
    const report = auditContent(
      listing({ etsyDesignRiskAccepted: RISK, imagePaths: ['C:\\stage\\01.png', 'C:\\stage\\02.jpg'] }),
      ['etsy'],
    )
    const finding = report.blockers.find((b) => /no images of your own/i.test(b.title))
    expect(finding).toBeDefined()
    expect(finding?.detail).toMatch(/source-platform downloads/)
  })

  it('still blocks an Etsy draft with no images at all', () => {
    const report = auditContent(listing({ etsyDesignRiskAccepted: RISK, imagePaths: [] }), ['etsy'])
    expect(report.blockers.some((b) => /no images/i.test(b.title))).toBe(true)
  })
})
