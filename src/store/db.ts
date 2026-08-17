import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DATA_DIR, ensureDataDir } from '../util/paths.js'
import { withFileLock, replaceFile } from './file-lock.js'
import { ListingRecordSchema, type ListingRecord, type Marketplace, type MarketplaceRecord } from '../types.js'

/**
 * A JSON-file store.
 *
 * This tool tracks tens of listings, not millions, and the file being readable
 * is a feature: when Claude's copy needs a manual tweak, you can open the file
 * and fix it. `node:sqlite` would work but still prints an ExperimentalWarning
 * on every run, and a native driver is a build dependency this doesn't need.
 */

const STORE_FILE = join(DATA_DIR, 'listings.json')

const StoreSchema = z.object({
  version: z.literal(1),
  listings: z.array(ListingRecordSchema),
})
type Store = z.infer<typeof StoreSchema>

const EMPTY: Store = { version: 1, listings: [] }

function read(): Store {
  ensureDataDir()
  if (!existsSync(STORE_FILE)) return structuredClone(EMPTY)

  const raw = readFileSync(STORE_FILE, 'utf8')

  // Refuse to silently drop the user's data. Back it up and start clean so the
  // failure is visible and recoverable — for a syntactically broken file just
  // as for one that fails the schema. Both are the same situation for the user:
  // the store is unreadable, and the original bytes must survive.
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    const backup = `${STORE_FILE}.corrupt-${Date.now()}`
    renameSync(STORE_FILE, backup)
    throw new Error(
      `listings.json is not valid JSON and was moved to ${backup}. ` +
        `Starting from an empty store.\n${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const parsed = StoreSchema.safeParse(json)
  if (!parsed.success) {
    const backup = `${STORE_FILE}.corrupt-${Date.now()}`
    renameSync(STORE_FILE, backup)
    throw new Error(
      `listings.json failed validation and was moved to ${backup}. ` +
        `Starting from an empty store.\n${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data
}

/** Write via a temp file + rename so an interrupted run cannot truncate the store. */
function write(store: Store): void {
  ensureDataDir()
  // Include the pid: two processes must not share a temp file, or one truncates
  // the other's half-written content.
  const tmp = `${STORE_FILE}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  replaceFile(tmp, STORE_FILE)
}

export function listAll(): ListingRecord[] {
  return read().listings
}

export function get(id: string): ListingRecord | undefined {
  return read().listings.find((l) => l.id === id)
}

/** Finds a prior listing for the same MakerWorld model, so we can warn about duplicates. */
export function findBySourceUrl(sourceUrl: string): ListingRecord | undefined {
  return read().listings.find((l) => l.sourceUrl === sourceUrl)
}

export function upsert(record: ListingRecord): void {
  withFileLock(STORE_FILE, () => {
    // Read inside the lock: a copy fetched earlier could already be stale.
    const store = read()
    const idx = store.listings.findIndex((l) => l.id === record.id)
    const next = { ...record, updatedAt: new Date().toISOString() }
    if (idx === -1) store.listings.push(next)
    else store.listings[idx] = next
    write(store)
  })
}

/**
 * Updates one marketplace's row on a listing, leaving the other untouched.
 *
 * Takes a patch rather than a whole record, and re-reads the file inside the
 * lock before applying it. That is what makes the call correct even when the
 * caller has been holding its own copy across several seconds of network work,
 * as `publish` does.
 */
export function updateMarketplace(
  id: string,
  marketplace: Marketplace,
  patch: Partial<Omit<MarketplaceRecord, 'marketplace' | 'updatedAt'>>,
): ListingRecord {
  return withFileLock(STORE_FILE, () => {
    const store = read()
    const listing = store.listings.find((l) => l.id === id)
    if (!listing) throw new Error(`No listing with id "${id}"`)

    const idx = listing.marketplaces.findIndex((m) => m.marketplace === marketplace)
    const base: MarketplaceRecord = listing.marketplaces[idx] ?? {
      marketplace,
      state: 'draft',
      remoteId: null,
      liveId: null,
      url: null,
      error: null,
      updatedAt: new Date().toISOString(),
    }

    const updated: MarketplaceRecord = { ...base, ...patch, updatedAt: new Date().toISOString() }
    if (idx === -1) listing.marketplaces.push(updated)
    else listing.marketplaces[idx] = updated

    listing.updatedAt = new Date().toISOString()
    write(store)
    return listing
  })
}

export function remove(id: string): boolean {
  return withFileLock(STORE_FILE, () => {
    const store = read()
    const before = store.listings.length
    store.listings = store.listings.filter((l) => l.id !== id)
    if (store.listings.length === before) return false
    write(store)
    return true
  })
}

export const storeFile = STORE_FILE
