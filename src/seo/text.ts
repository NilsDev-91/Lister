/**
 * Turning marketplace text into comparable words.
 *
 * Split out of `mine.ts` so `relevance.ts` can use the same tokenisation
 * without the two importing each other in a circle — the same reason
 * `marketplace.ts` exists. Phrase handling has to happen exactly one way: an
 * anchor mined from the seller's own title and an n-gram mined from a
 * competitor's have to be comparable, and two tokenisers drifting apart would
 * make that silently false.
 */

/**
 * Words that carry no search intent on their own.
 *
 * Both languages live in one set because a title sample is not reliably
 * monolingual — Etsy sellers in Germany write English titles with German words
 * left in, and vice versa.
 */
export const STOPWORDS = new Set([
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'eines', 'und', 'oder',
  'aber', 'mit', 'für', 'von', 'zu', 'zum', 'zur', 'im', 'in', 'am', 'an', 'auf', 'aus', 'bei',
  'beim', 'vom', 'nach', 'über', 'unter', 'vor', 'zwischen', 'ist', 'sind', 'war', 'waren', 'wird',
  'werden', 'kann', 'können', 'als', 'wie', 'auch', 'nur', 'noch', 'schon', 'sehr', 'sich', 'es',
  'ins', 'durch', 'ohne', 'gegen', 'um', 'bis', 'seit', 'dass', 'wenn', 'weil', 'man', 'inkl',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'with', 'for', 'of', 'to', 'in', 'on', 'at', 'from', 'by',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'will', 'can', 'could', 'this', 'that', 'these',
  'those', 'it', 'its', 'your', 'you', 'we', 'our', 'they', 'their', 'my', 'me', 'not', 'no', 'so',
  'if', 'then', 'than', 'there', 'here', 'about', 'into', 'over', 'under', 'out', 'up', 'down',
  'more', 'most', 'very', 'just', 'also', 'only', 'per',
])

/**
 * Marketplace titles are lists, not sentences: sellers separate keyword groups
 * with pipes, slashes, commas and dashes. Splitting on those first stops an
 * n-gram from spanning a boundary and inventing a phrase nobody wrote —
 * "organizer 3d" out of "Desk Organizer | 3D Printed".
 */
const SEGMENT_BREAK = /[|/,;:•·–—()[\]{}!?"“”„]+|\s-\s|\s+&\s+/u

/** Keeps letters (incl. umlauts), digits, and word-internal hyphen/apostrophe. */
const TOKEN = /[\p{L}\p{Nd}]+(?:['’-][\p{L}\p{Nd}]+)*/gu

function tokenise(segment: string): string[] {
  return (segment.toLowerCase().match(TOKEN) ?? []).filter(
    // "3d" and "4k" are two characters and load-bearing; "st" and "cm" are not.
    // Two-letter STOPWORDS survive on purpose: dropping "to" before the n-grams
    // are built would fuse "made to order" into the phantom "made order" — the
    // edge-refusal below is where stopwords are handled, not here.
    (t) => t.length >= 3 || /\d/.test(t) || STOPWORDS.has(t),
  )
}

const MAX_NGRAM = 3

/**
 * Every 1..3-word phrase in a title, minus the ones that only look like
 * phrases.
 *
 * Stopwords are dropped at the *edges* rather than removed up front: strip
 * "for" out of "gift for mom" beforehand and you mine "gift mom", which nobody
 * searches for. Keeping them inside and refusing them at the ends preserves the
 * real phrase and discards the fragments around it.
 */
export function phrasesFromTitle(title: string): string[] {
  const out: string[] = []
  for (const segment of title.split(SEGMENT_BREAK)) {
    const tokens = tokenise(segment)
    for (let n = 1; n <= MAX_NGRAM; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n)
        if (STOPWORDS.has(gram[0]!) || STOPWORDS.has(gram[n - 1]!)) continue
        // Any bare number, not just an all-number phrase. Digits in marketplace
        // titles are sizes, quantities and set counts — "12 cm", "set of 3" —
        // and the fragments they produce ("personalised 9") read like phrases
        // while matching nothing. Losing the occasional real one, such as the
        // darts term "9 dart finish", is the cheaper mistake.
        if (gram.some((t) => /^\d+$/.test(t))) continue
        out.push(gram.join(' '))
      }
    }
  }
  return out
}

/**
 * Tags are already phrases; they only need normalising to match title n-grams.
 * `tokenise` drops punctuation on its own, so no separator pass is needed.
 */
export function normaliseTag(tag: string): string {
  return tokenise(tag).join(' ')
}
