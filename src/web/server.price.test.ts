import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ListingRecordSchema, type ListingRecord } from '../types.js'

/**
 * The price is money, and it is edited through the same form as the copy.
 *
 * Three rules worth pinning: a German decimal comma is normal input, a third
 * decimal is refused rather than rounded (`toFixed(2)` at the marketplace
 * would charge a price nobody typed), and a submission without the field at
 * all leaves the stored price alone — a hand-built request must not be able
 * to reset it.
 *
 * Dynamic imports after LISTER_DATA_DIR is set, as everywhere: the store
 * freezes its path at module load.
 */

const dir = mkdtempSync(join(tmpdir(), 'lister-price-'))
// 4325x: the host test owns 43241 and 43242 (it boots a second server there).
const PORT = 43251
const NOW = '2026-08-21T00:00:00.000Z'
const ID = 'mw-1-price'

let close: (() => Promise<void>) | undefined
let token: string
let get: (id: string) => ListingRecord | undefined

function record(): ListingRecord {
  return ListingRecordSchema.parse({
    id: ID,
    sourceUrl: 'https://makerworld.com/en/models/1',
    source: {
      sourceUrl: 'https://makerworld.com/en/models/1',
      externalId: '1',
      title: 'Dart Holder',
      description: '',
      designer: 'OMMO',
      tags: [],
      images: [],
      license: { raw: 'CC BY 4.0', code: 'CC-BY-4.0', commercialUse: 'yes', reason: 'ok' },
      fetchedAt: NOW,
    },
    product: {
      priceEur: 20.99,
      quantity: 1,
      material: 'PLA',
      colour: null,
      dimensionsMm: null,
      weightGrams: null,
      processingDays: 3,
      notes: '',
    },
    copy: {
      ebay: { title: 'Dartshalter', descriptionHtml: '<p>x</p>', categoryHint: 'Deko', aspects: {} },
      etsy: { title: 'Dart Holder', description: 'x', tags: [], materials: [], taxonomyHint: 'Home Decor' },
    },
    imagePaths: [],
    imageUrls: [],
    marketplaces: [],
    createdAt: NOW,
    updatedAt: NOW,
  })
}

/** The editor form as the browser sends it, minus whatever the case drops. */
async function save(extra: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams({
    ebayTitle: 'Dartshalter',
    ebayDesc: '<p>x</p>',
    etsyTitle: 'Dart Holder',
    etsyDesc: 'x',
    etsyTags: '',
    etsyMaterials: '',
    ...extra,
  })
  return fetch(`http://127.0.0.1:${PORT}/listing/${ID}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: `http://127.0.0.1:${PORT}`,
      cookie: `lister_session=${token}`,
    },
    body,
  })
}

beforeAll(async () => {
  process.env['LISTER_DATA_DIR'] = dir
  const { startServer } = await import('./server.js')
  const handle = await startServer({ port: PORT, openBrowser: false })
  close = handle.close
  token = readFileSync(join(dir, 'session-token'), 'utf8').trim()
  const db = await import('../store/db.js')
  get = db.get
  db.upsert(record())
})

afterAll(async () => {
  await close?.()
  delete process.env['LISTER_DATA_DIR']
  rmSync(dir, { recursive: true, force: true })
})

describe('editing the Etsy category', () => {
  // It rides on the same form as the copy, and it is the field a researched
  // category lands in. Before it was rendered, taking a suggestion wrote a
  // value the page never showed — which looked exactly like nothing happening.
  it('saves an edited category', async () => {
    const res = await save({ etsyTaxonomy: 'Figurines & Knick Knacks' })
    expect(res.status).toBe(303)
    expect(get(ID)?.copy.etsy.taxonomyHint).toBe('Figurines & Knick Knacks')
  })

  it('keeps the stored category when the field is absent', async () => {
    const res = await save({})
    expect(res.status).toBe(303)
    expect(get(ID)?.copy.etsy.taxonomyHint).toBe('Figurines & Knick Knacks')
  })
})

describe('editing the eBay category', () => {
  it('stores a category id and warns that the item specifics are now stale', async () => {
    const res = await save({ ebayCategory: '59890' })
    expect(get(ID)?.ebayCategoryId).toBe('59890')
    // A moved category means different required specifics — saying "gespeichert"
    // alone would let the seller believe the plan still fits.
    expect(res.headers.get('location')).toContain('kind=warn')
  })

  it('refuses anything that is not a category id', async () => {
    const res = await save({ ebayCategory: 'Dekofiguren' })
    expect(res.headers.get('location')).toContain('kind=bad')
    expect(get(ID)?.ebayCategoryId).toBe('59890')
  })

  it('clears the category when the field is emptied, so a wrong one can be undone', async () => {
    await save({ ebayCategory: '' })
    expect(get(ID)?.ebayCategoryId).toBeNull()
  })

  it('leaves the stored category alone when the field is absent', async () => {
    await save({ ebayCategory: '59890' })
    await save({})
    expect(get(ID)?.ebayCategoryId).toBe('59890')
  })
})

describe('editing the price', () => {
  it('takes a German decimal comma', async () => {
    const res = await save({ price: '24,50' })
    expect(res.status).toBe(303)
    expect(get(ID)?.product.priceEur).toBe(24.5)
  })

  it('refuses a third decimal instead of rounding it away', async () => {
    const res = await save({ price: '24,999' })
    expect(res.headers.get('location')).toContain('kind=bad')
    expect(get(ID)?.product.priceEur).toBe(24.5)
  })

  it('refuses zero and other non-prices', async () => {
    for (const price of ['0', '-5', 'zwanzig']) {
      const res = await save({ price })
      expect(res.headers.get('location')).toContain('kind=bad')
    }
    expect(get(ID)?.product.priceEur).toBe(24.5)
  })

  it('leaves the stored price alone when the field is absent', async () => {
    // A form from before this input existed, or a hand-built request: silence
    // about a field can only mean "unchanged".
    const res = await save({})
    expect(res.status).toBe(303)
    expect(get(ID)?.product.priceEur).toBe(24.5)
  })
})
