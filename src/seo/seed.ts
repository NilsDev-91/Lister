import type { ListingRecord, Marketplace } from '../types.js'
import { normaliseTag, phrasesFromTitle } from './mine.js'

/**
 * Picks the searches a research run starts from.
 *
 * The seeds come from the draft copy rather than from the MakerWorld page, and
 * that is the important choice. MakerWorld titles are English; the copy here is
 * German on both marketplaces. Seeding research from the source page would
 * search a German-speaking market with English words and mine whatever scraps
 * came back.
 *
 * Reading the draft instead means each marketplace is seeded in its own
 * language by construction — and it makes research a refinement pass over an
 * existing listing, which is when there is something to improve.
 */

/** Round one is deliberately narrow: each seed costs calls and the second round widens. */
const DEFAULT_SEEDS = 4

/**
 * A single word is almost never worth searching: it is either so broad the
 * ranking is meaningless or so rare it returns nothing. Two words is the floor
 * for a phrase a buyer actually types.
 */
const MIN_WORDS = 2

function wordCount(phrase: string): number {
  return phrase.split(' ').filter(Boolean).length
}

/**
 * Drops a phrase already covered by one we kept.
 *
 * Searching "dragon desk toy" and "desk toy" in the same round returns
 * overlapping rankings and spends two queries to learn one thing.
 *
 * Containment is word-aligned: raw substring matching read "art print" as
 * contained in "dart printer" and threw away a genuinely different query.
 */
function isRedundant(phrase: string, kept: string[]): boolean {
  const padded = ` ${phrase} `
  return kept.some((k) => ` ${k} `.includes(padded) || padded.includes(` ${k} `))
}

export interface SeedArgs {
  listing: ListingRecord
  marketplace: Marketplace
  max?: number
}

export function seedQueries(args: SeedArgs): string[] {
  const { listing, marketplace } = args
  const max = args.max ?? DEFAULT_SEEDS

  // Order matters: whatever comes first in this list gets searched first.
  // Explicit tags outrank mined title fragments because a seller chose them.
  const raw =
    marketplace === 'etsy'
      ? [...listing.copy.etsy.tags, ...phrasesFromTitle(listing.copy.etsy.title), listing.copy.etsy.taxonomyHint]
      : [...phrasesFromTitle(listing.copy.ebay.title), listing.copy.ebay.categoryHint]

  const kept: string[] = []
  for (const candidate of raw) {
    const phrase = normaliseTag(candidate)
    if (!phrase || wordCount(phrase) < MIN_WORDS) continue
    if (isRedundant(phrase, kept)) continue
    kept.push(phrase)
    if (kept.length >= max) break
  }

  // A listing whose copy is all single words would otherwise research nothing.
  // The material plus the category guess is a weak query, but it is a query.
  if (!kept.length) {
    const hint = marketplace === 'etsy' ? listing.copy.etsy.taxonomyHint : listing.copy.ebay.categoryHint
    const fallback = normaliseTag(`${listing.product.material} ${hint}`)
    if (fallback && wordCount(fallback) >= MIN_WORDS) kept.push(fallback)
  }

  return kept
}

/**
 * Picks the second round's queries from what the first round mined.
 *
 * The point of a second round is not more candidates — it is *competition
 * numbers*. `totalMatches` is a property of a query, so a phrase only ever gets
 * a competition figure by being searched. Round two turns the strongest
 * candidates into queries so their scores stop resting on a neutral guess.
 */
export function followUpQueries(
  candidates: { phrase: string; usableAsTag: boolean; competition: number | null }[],
  alreadyQueried: string[],
  max = 3,
): string[] {
  const seen = alreadyQueried.map(normaliseTag)
  const out: string[] = []

  for (const candidate of candidates) {
    if (out.length >= max) break
    // Already measured, or unusable as a keyword anyway — no reason to spend a
    // call confirming it.
    if (candidate.competition !== null || !candidate.usableAsTag) continue
    if (wordCount(candidate.phrase) < MIN_WORDS) continue
    if (seen.includes(candidate.phrase) || isRedundant(candidate.phrase, out)) continue
    out.push(candidate.phrase)
  }

  return out
}
