import { normaliseTag } from './mine.js'
import type { KeywordEvidence } from './types.js'

/**
 * Checks copy against the research that was supposed to inform it.
 *
 * Deliberately measured rather than asked. The copywriter could be told to
 * report which keywords it used, but then the report is a claim; comparing the
 * finished text against the evidence is a fact. A model that ignored the
 * research entirely cannot hide it here.
 */

/** How far down the ranked candidates counts as "recommended". */
const RECOMMENDED = 15

function titleHaystack(title: string): string {
  // Padded so `includes` cannot match across a word boundary: " dragon " will
  // not be found inside " dragonfly ".
  return ` ${normaliseTag(title)} `
}

export interface Coverage {
  /** Recommended phrases that made it into the title or the tags. */
  used: string[]
  /** Recommended phrases that did not, strongest first. */
  missed: string[]
  /**
   * Tags with no support in the research.
   *
   * Not an error. A seller knows things the sample does not, and a tag that
   * describes the item truthfully earns its place whether or not competitors
   * chose it. It is listed so the difference is visible.
   */
  unevidenced: string[]
}

export interface CoverageArgs {
  title: string
  tags: string[]
  evidence: KeywordEvidence
  /** How many top candidates to hold the copy against. */
  top?: number
}

export function coverage(args: CoverageArgs): Coverage {
  const top = args.top ?? RECOMMENDED
  const haystack = titleHaystack(args.title)
  const tags = args.tags.map(normaliseTag).filter(Boolean)
  const tagSet = new Set(tags)

  const recommended = args.evidence.candidates.filter((c) => c.usableAsTag).slice(0, top)

  const used: string[] = []
  const missed: string[] = []
  for (const candidate of recommended) {
    const inCopy = tagSet.has(candidate.phrase) || haystack.includes(` ${candidate.phrase} `)
    ;(inCopy ? used : missed).push(candidate.phrase)
  }

  const known = new Set(args.evidence.candidates.map((c) => c.phrase))
  const unevidenced = tags.filter((t) => !known.has(t))

  return { used, missed, unevidenced }
}

// ---------------------------------------------------------------------------
// Tag hygiene
// ---------------------------------------------------------------------------

/**
 * Etsy gives every listing thirteen tags. Leaving some empty is unused reach,
 * and spending two of them on the same word is the same waste in a different
 * shape.
 */
export const ETSY_TAG_SLOTS = 13

/**
 * Crude suffix stripping, on purpose.
 *
 * A real stemmer would be a dependency for one job. This only has to notice
 * that "3d print", "3d printed" and "3d prints" cover the same ground within a
 * single listing's thirteen tags. It leans English, which is where it is used:
 * eBay has no tag field, so this never sees German.
 */
export function crudeStem(word: string): string {
  if (word.length >= 6 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length >= 5 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length >= 4 && word.endsWith('s')) return word.slice(0, -1)
  return word
}

export interface RepeatedWord {
  stem: string
  tags: string[]
}

export interface TagHygiene {
  repeated: RepeatedWord[]
  unusedSlots: number
}

export function tagHygiene(tags: string[]): TagHygiene {
  const byStem = new Map<string, Set<string>>()

  for (const tag of tags) {
    const normalised = normaliseTag(tag)
    if (!normalised) continue
    // Within one tag a word counts once; "dragon dragon" is one tag's problem,
    // not two tags overlapping.
    for (const stem of new Set(normalised.split(' ').map(crudeStem))) {
      const bucket = byStem.get(stem) ?? new Set<string>()
      bucket.add(tag)
      byStem.set(stem, bucket)
    }
  }

  const repeated: RepeatedWord[] = []
  for (const [stem, owners] of byStem) {
    if (owners.size > 1) repeated.push({ stem, tags: [...owners] })
  }
  repeated.sort((a, b) => b.tags.length - a.tags.length || a.stem.localeCompare(b.stem))

  return { repeated, unusedSlots: Math.max(0, ETSY_TAG_SLOTS - tags.length) }
}
