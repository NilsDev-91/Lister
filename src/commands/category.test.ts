import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { ListingRecordSchema, type ListingRecord } from '../types.js'

/**
 * Taking a researched category.
 *
 * The seam worth pinning is Etsy's: the pick is stored as a *name* in
 * `taxonomyHint`, because that is the field the publish path already resolves.
 * A name that resolves back to a different node would list the item somewhere
 * the seller never chose — quietly, at publish time, long after the click.
 *
 * Dynamic imports after LISTER_DATA_DIR is set, as everywhere: the store
 * freezes its path at module load.
 */

vi.mock('../marketplaces/etsy/client.js', () => ({
  listTaxonomyNodes: async () => [
    { id: 1, name: 'Home & Living', path: ['Home & Living'], leaf: false, level: 0 },
    { id: 68, name: 'Figurines', path: ['Home & Living', 'Home Decor', 'Figurines'], leaf: true, level: 2 },
    // Deliberately ambiguous: two leaves share a name under different roots,
    // which is exactly the case the roundtrip check has to catch.
    { id: 70, name: 'Ornaments', path: ['Home & Living', 'Home Decor', 'Ornaments'], leaf: true, level: 2 },
    { id: 71, name: 'Ornaments', path: ['Art & Collectibles', 'Ornaments'], leaf: true, level: 1 },
  ],
  lastRateLimit: () => ({ remainingToday: null, perDay: null }),
}))

const dir = mkdtempSync(join(tmpdir(), 'lister-category-'))
const NOW = '2026-08-21T00:00:00.000Z'

let categoryCommand: typeof import('./category.js').categoryCommand
let get: (id: string) => ListingRecord | undefined
let upsert: (l: ListingRecord) => void

function record(id: string, candidates: { id: string; name: string | null; count: number; share: number }[], marketplace: 'ebay' | 'etsy'): ListingRecord {
  const evidence = {
    marketplace,
    language: 'de',
    generatedAt: NOW,
    queries: ['x'],
    sampleSize: 20,
    relevance: { anchors: ['benchy'], sampled: 20, kept: 20, sufficient: true },
    candidates: [],
    categoryCandidates: candidates,
    priceBandEur: null,
    aspectFacets: [],
    notes: [],
  }
  return ListingRecordSchema.parse({
    id,
    sourceUrl: 'https://makerworld.com/en/models/1',
    source: {
      sourceUrl: 'https://makerworld.com/en/models/1',
      externalId: '1',
      title: 'Benchy',
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
      ebay: { title: 'Benchy', descriptionHtml: '<p>x</p>', categoryHint: 'Deko', aspects: {} },
      etsy: { title: 'Benchy', description: 'x', tags: [], materials: [], taxonomyHint: 'Home Decor' },
    },
    imagePaths: [],
    imageUrls: [],
    marketplaces: [],
    seo: { ebay: marketplace === 'ebay' ? evidence : null, etsy: marketplace === 'etsy' ? evidence : null },
    createdAt: NOW,
    updatedAt: NOW,
  })
}

beforeAll(async () => {
  process.env['LISTER_DATA_DIR'] = dir
  const db = await import('../store/db.js')
  get = db.get
  upsert = db.upsert
  categoryCommand = (await import('./category.js')).categoryCommand
})

afterAll(() => {
  delete process.env['LISTER_DATA_DIR']
  rmSync(dir, { recursive: true, force: true })
})

const quiet = () => ({
  lines: [] as { level: string; message: string }[],
  step(m: string) { this.lines.push({ level: 'step', message: m }) },
  info(m: string) { this.lines.push({ level: 'info', message: m }) },
  detail(m: string) { this.lines.push({ level: 'detail', message: m }) },
  ok(m: string) { this.lines.push({ level: 'ok', message: m }) },
  warn(m: string) { this.lines.push({ level: 'warn', message: m }) },
  error(m: string) { this.lines.push({ level: 'error', message: m }) },
  async confirm() { return true },
  async ask() { return '' },
})

describe('taking a researched category', () => {
  it('stores the eBay category and says the item specifics must be re-planned', async () => {
    upsert(record('e1', [{ id: '261636', name: 'Figuren', count: 12, share: 0.6 }], 'ebay'))
    const io = quiet()
    await categoryCommand({ id: 'e1', marketplace: 'ebay', use: 1, io: io as never })

    expect(get('e1')?.ebayCategoryId).toBe('261636')
    // Not cosmetic: every category defines its own required specifics, and the
    // plan made for the previous one says nothing about this one.
    expect(io.lines.filter((l) => l.level === 'warn').map((l) => l.message).join(' ')).toContain('aspects')
  })

  it('stores the Etsy pick as the name the publish path resolves', async () => {
    upsert(record('t1', [{ id: '68', name: 'Home & Living > Home Decor > Figurines', count: 9, share: 0.45 }], 'etsy'))
    await categoryCommand({ id: 't1', marketplace: 'etsy', use: 1, io: quiet() as never })

    expect(get('t1')?.copy.etsy.taxonomyHint).toBe('Figurines')
  })

  it('refuses a name that resolves back to a different category', async () => {
    // "Ornaments" exists twice. Storing it would publish into whichever one
    // matchTaxonomy prefers — a different category than the one clicked.
    // Picked the shallower of the two: matchTaxonomy prefers the deepest leaf,
    // so this name comes back as the *other* Ornaments.
    upsert(record('t2', [{ id: '71', name: 'Art & Collectibles > Ornaments', count: 9, share: 0.45 }], 'etsy'))
    await expect(categoryCommand({ id: 't2', marketplace: 'etsy', use: 1, io: quiet() as never })).rejects.toThrow(
      /does not resolve back/,
    )
    expect(get('t2')?.copy.etsy.taxonomyHint).toBe('Home Decor')
  })

  it('refuses an option the research never offered', async () => {
    upsert(record('t3', [{ id: '68', name: 'Figurines', count: 9, share: 0.45 }], 'etsy'))
    await expect(categoryCommand({ id: 't3', marketplace: 'etsy', use: 4, io: quiet() as never })).rejects.toThrow(
      /no option 4/,
    )
  })

  it('refuses when nothing was researched for that marketplace', async () => {
    upsert(record('t4', [{ id: '68', name: 'Figurines', count: 9, share: 0.45 }], 'etsy'))
    await expect(categoryCommand({ id: 't4', marketplace: 'ebay', use: 1, io: quiet() as never })).rejects.toThrow(
      /No researched categories/,
    )
  })
})
