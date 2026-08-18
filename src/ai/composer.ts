import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { log, UserError } from '../util/log.js'
import {
  EbayCopySchema,
  EtsyTitleSchema,
  ListingCopySchema,
  type ListingCopy,
  type MakerWorldModel,
  type ProductInput,
} from '../types.js'
import { requiresAttribution } from '../makerworld/license.js'
import type { LicenseGateDecision } from '../makerworld/license.js'
import type { KeywordEvidence, SeoEvidence } from '../seo/types.js'

/**
 * Turns a MakerWorld model plus the seller's facts into marketplace copy.
 *
 * Structured outputs constrain the *shape* of the response but not its content
 * rules: the Anthropic API's JSON-Schema subset drops string/array length
 * constraints (they become description hints) and cannot express `refine` at
 * all. So the flow here is generate → validate against the strict schema →
 * feed the validation errors back and let the model repair its own output.
 * That keeps the marketplace 400s in-process, where they are cheap.
 */

/**
 * The language Etsy copy is written in — German, not English.
 *
 * The seller ships within Germany only for now: packaging-law (VerpackG)
 * registration and EPR duties are per country, so an international audience is
 * not addressable yet, and copy aimed at one would attract exactly the orders
 * that cannot be fulfilled. eBay was always German; Etsy now matches it.
 *
 * Two places have to agree with this and are commented to say so: the research
 * language in `seo/research.ts` (which decides what the miner searches for) and
 * the `etsyBuyerCountry` default in `settings.ts`. Change all three together.
 */
const ETSY_LANGUAGE = 'German'

/**
 * The schema sent to the API. Deliberately looser than `ListingCopySchema`:
 * describing the limits in prose gets better compliance than relying on
 * constraints the API will silently drop.
 */
const GenerationSchema = z.object({
  ebay: z.object({
    title: z.string().describe('At most 80 characters. Keyword-rich, no ALL CAPS, no emoji.'),
    descriptionHtml: z
      .string()
      .describe('HTML using only <p>, <h3>, <ul>, <li>, <strong>, <br>. No <script>, no inline styles.'),
    categoryHint: z.string().describe('A short German category phrase, e.g. "Dekofigur" or "Schreibtisch-Organizer".'),
    // A list of pairs rather than a map: a JSON-Schema object with open keys
    // needs `additionalProperties`, which structured outputs does not support —
    // asking for a record yields an empty object every time.
    aspects: z
      .array(
        z.object({
          name: z.string().describe('German aspect name, e.g. "Marke", "Material", "Farbe", "Produktart".'),
          values: z.array(z.string()).describe('Usually one value.'),
        }),
      )
      .describe(
        'German item specifics. ALWAYS include {"name":"Marke","values":["Markenlos"]} — eBay requires a brand and this is unbranded. Add Material, Farbe and Produktart where you know them.',
      ),
  }),
  etsy: z.object({
    title: z
      .string()
      .describe(
        `At most 140 characters. Each of % : & + may appear AT MOST ONCE in the whole title. No emoji. ${ETSY_LANGUAGE}.`,
      ),
    description: z.string().describe(`Plain text, no HTML. Line breaks are fine. ${ETSY_LANGUAGE}.`),
    tags: z
      .array(z.string())
      .describe(
        'Exactly 13 tags if possible. Each at most 20 characters. Letters, digits, spaces, hyphens and apostrophes only — no commas, no emoji, no other punctuation.',
      ),
    materials: z
      .array(z.string())
      .describe(
        'Up to 13 materials. Letters, digits and SPACES ONLY — no hyphens or punctuation. Write "PLA Plus", never "PLA-Plus".',
      ),
    // The hint is matched against Etsy's taxonomy, whose node names are
    // English — so this one field stays English even though the copy is not.
    taxonomyHint: z
      .string()
      .describe(
        'A short ENGLISH category phrase, e.g. "Home Decor" or "Desk Organizer" — this is matched against Etsy\'s own category tree, which is in English. English here even though the listing copy is not.',
      ),
  }),
})

const SYSTEM_PROMPT = `You write marketplace listings for 3D-printed products, sold by a small independent maker in Germany who ships within Germany only.

You are given a MakerWorld model page and the seller's own facts about the physical item they print from it. Produce listing copy for eBay (German marketplace, German language) and Etsy (${ETSY_LANGUAGE} language, German buyers).

What matters:

- Describe the PHYSICAL PRINTED OBJECT the buyer receives, not the digital model and not the MakerWorld page. The buyer is not downloading a file.
- Be concrete and honest. Use the seller's stated material, dimensions, weight and processing time. Never invent a specification you were not given — no made-up dimensions, print times, or claims about strength, food safety, or weather resistance.
- BOTH marketplaces are German-language. Write each natively for its marketplace — same language, different voice — never a word-for-word translation of the other.
- eBay titles are keyword-dense because eBay search is literal. Etsy titles read more naturally and lead with what the thing is.
- Etsy tags are search phrases German buyers actually type, not single generic words. Prefer "3d druck drache" over "drache".
- German compounds run long and Etsy tags are capped at 20 characters. Prefer the two-word form a buyer would type ("moosstab pflanzen") over one compound that busts the limit ("zimmerpflanzenmoosstab"). Count the characters.
- Write real German on BOTH marketplaces: "für", "Küche", "Größe", "Füße" — NEVER transliterate to "fuer", "Kueche", "Groesse", not even in an eBay title. Umlauts and ß are ordinary letters and are accepted in every field (titles, tags, materials, item specifics); spelling them out reads like a broken import to a German buyer, and both marketplaces match the two forms alike, so it buys nothing.
- No emoji anywhere. No ALL CAPS. No invented brand names — this is an unbranded handmade item.

When keyword research is supplied, it lists phrases that listings currently ranking for this kind of item actually use, how many of them use it, how crowded the phrase is, and how much traffic it carries. Use it:

- A keyword must be TRUE of the item, and that outranks every ranking consideration. Never add a phrase describing a material, size, feature or use the seller did not state. A high-scoring phrase that does not fit this object is not a keyword, it is a false claim — and a listing that oversells gets returns and defect rates, which cost more than the traffic was worth.
- Descriptive keywords (what the object is, what it is made of, how big it is) must be literally accurate. Occasion and audience keywords ("gift for", "desk decor") only need to be plausible.
- Front-load the strongest phrase. Both marketplaces weight the start of a title most, and a title truncated in a results list still shows it.
- Prefer the phrases the research supports over ones you invent. A phrase ranked highly there is one buyers type and sellers do not yet crowd.
- Etsy gives 13 tags — use all 13, and do not spend two of them on the same word. "3d printed dragon" and "3d printed toy" overlap on two words out of three and together cover less ground than either one plus something different.
- Where the research reports eBay item specifics with counts, reuse those exact spellings in \`aspects\`. Buyers filter on those values; a spelling that does not match the filter is invisible to it.
- Do not stuff. A title reading as a keyword list converts worse, and both marketplaces demote it.

Character rules that will cause a hard API rejection if broken. They restrict PUNCTUATION and symbols, never letters: umlauts and ß count as letters and are always safe.
- eBay title: 80 characters maximum, hard limit.
- Etsy title: 140 characters maximum, and each of % : & + may appear at most ONCE in the entire title.
- Etsy tags: 20 characters maximum each, letters/digits/spaces/hyphens/apostrophes only. No commas.
- Etsy materials: letters, digits and spaces only. No hyphens. "PLA Plus", never "PLA-Plus".`

/**
 * Renders one marketplace's research as a compact table.
 *
 * A table rather than prose because the model has to compare rows on three
 * numbers at once, and prose makes that harder for no benefit. Missing figures
 * print as "?" rather than 0 — the difference between "no competition" and
 * "not measured" changes which phrase is the better bet.
 */
function formatEvidence(evidence: KeywordEvidence): string {
  const num = (n: number | null, digits = 0) => (n === null ? '?' : n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }))

  const rows = evidence.candidates
    .slice(0, 20)
    .map((c) => {
      const share = `${Math.round(c.rankerShare * 100)}%`
      const usable = c.usableAsTag ? '' : '  (too long for a tag)'
      return `  ${c.phrase} — used by ${share} of ranked listings, ${num(c.competition)} competing, ${num(c.demandPerDay, 1)} views/day${usable}`
    })
    .join('\n')

  const lines = [
    `KEYWORD RESEARCH — ${evidence.marketplace.toUpperCase()}`,
    `${evidence.sampleSize} competing listings sampled across ${evidence.queries.length} searches.`,
    'Ranked by opportunity, which favours phrases with demand that are not yet crowded — not the busiest phrases.',
    '',
    rows || '  (no candidates met the evidence threshold)',
  ]

  if (evidence.categoryConsensus) {
    lines.push(
      '',
      `Category most ranked listings sit in: ${evidence.categoryConsensus.id} ` +
        `(${Math.round(evidence.categoryConsensus.share * 100)}% of the sample).`,
    )
  }
  if (evidence.priceBandEur) {
    const { count, min, p25, median, p75, max } = evidence.priceBandEur
    lines.push(
      `Competitor prices across ${count} listings: EUR ${min.toFixed(2)} to ${max.toFixed(2)}, ` +
        `middle half ${p25.toFixed(2)}–${p75.toFixed(2)}, median ${median.toFixed(2)}. ` +
        'Context only — the seller sets the price. Never mention it, compare to it, or call the item cheap or a bargain.',
    )
  }
  if (evidence.aspectFacets.length) {
    const facets = evidence.aspectFacets
      .slice(0, 12)
      .map((f) => `${f.name}=${f.value} (${f.count})`)
      .join(', ')
    lines.push('', `Item specifics buyers filter on, with match counts: ${facets}`)
  }
  if (evidence.notes.length) {
    lines.push('', `Limits of this research: ${evidence.notes.join(' ')}`)
  }

  return lines.join('\n')
}

interface PromptArgs {
  model: MakerWorldModel
  product: ProductInput
  gate: LicenseGateDecision
  credit: boolean
  evidence?: SeoEvidence | null | undefined
}

/**
 * The facts, the licence position and the research — everything except what to
 * do with them.
 *
 * `task` is the closing instruction, so writing full copy and writing title
 * options share one description of the item. Two prompts drifting apart is how
 * the variants end up describing something slightly different from the listing.
 */
function buildUserPrompt(args: PromptArgs, task: string): string {
  const { model, product, gate } = args

  const sourceBlock = gate.mayReuseText
    ? `Designer's own description of the model (you may draw on this):
"""
${model.description.slice(0, 4000)}
"""`
    : `The model's licence does not permit reusing the designer's text, so the description is withheld.
Write from the title, the seller's facts, and the images alone. Do not paraphrase the designer's wording.`

  // No marketplace requires a licence to be disclosed in a listing — the
  // obligation, where it exists at all, comes from the licence itself. CC-BY
  // variants require naming the designer; a creator's commercial terms may or
  // may not. So the credit is on by default as cheap insurance and can be
  // switched off when the terms do not ask for it.
  //
  // What the credit may *say* depends on which licence the sale runs under.
  // With rights bought separately, the licence printed on the page is not that
  // licence, and naming it would put a statement in the listing that forbids
  // the very sale being made.
  let attribution = ''
  if (!args.credit) {
    attribution = ''
  } else if (gate.overridden) {
    attribution =
      `\nCredit the designer "${model.designer}" in one short line at the end of both descriptions. ` +
      'Do NOT name, quote or describe any licence: the seller holds separate commercial rights, and the licence shown on the source page is not the one this sale runs under. A bare credit is what is wanted.'
  } else if (requiresAttribution(model.license)) {
    attribution =
      `\nAttribution is required by the licence. Include a short credit line at the end of both descriptions, naming the designer "${model.designer}" and the licence "${model.license.raw}".`
  }

  const dims = product.dimensionsMm
    ? `${product.dimensionsMm.length} × ${product.dimensionsMm.width} × ${product.dimensionsMm.height} mm`
    : 'not measured — do not state dimensions'
  const weight = product.weightGrams !== null ? `${product.weightGrams} g` : 'not weighed — do not state a weight'

  // Both marketplaces' research goes in together. They are researched in
  // different languages against different markets, and the model needs to see
  // which block belongs to which — that is what the heading is for.
  const research = [args.evidence?.ebay, args.evidence?.etsy]
    .filter((e): e is KeywordEvidence => Boolean(e))
    .map(formatEvidence)
    .join('\n\n')

  return `SOURCE MODEL
Title: ${model.title}
Designer: ${model.designer}
Licence: ${model.license.raw} (${model.license.code ?? 'unrecognised'})
Tags on MakerWorld: ${model.tags.join(', ') || '(none)'}

${sourceBlock}

THE PHYSICAL ITEM BEING SOLD
Material: ${product.material}
Colour: ${product.colour ?? 'not specified — do not name a colour'}
Dimensions: ${dims}
Weight: ${weight}
Price: EUR ${product.priceEur.toFixed(2)}
Quantity available: ${product.quantity}
Dispatch time: ${product.processingDays} business days (made to order)
Seller notes: ${product.notes || '(none)'}${attribution}
${research ? `\n${research}\n` : ''}
${task}`
}

/** Formats zod issues into instructions the model can act on. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
}

export interface ComposeArgs {
  model: MakerWorldModel
  product: ProductInput
  gate: LicenseGateDecision
  /**
   * Add a credit line naming the designer.
   *
   * No marketplace requires this — the obligation comes from the licence, and
   * only some licences impose one. Defaults on because a credit costs nothing
   * and satisfies the licences that do.
   */
  credit: boolean
  /**
   * Keyword research to write against.
   *
   * Optional throughout: a listing can be composed with no research at all, and
   * the copy is simply unevidenced rather than broken. That keeps `create` from
   * depending on a marketplace being reachable.
   */
  evidence?: SeoEvidence | null | undefined
  /** Attempts including the first. Each repair round costs one more API call. */
  maxAttempts?: number
}

// ---------------------------------------------------------------------------
// Title options
// ---------------------------------------------------------------------------

const TitleOptionsGenerationSchema = z.object({
  ebay: z
    .array(z.string())
    .describe('German eBay titles, at most 80 characters each. Strongest first. No emoji, no ALL CAPS.'),
  etsy: z
    .array(z.string())
    .describe(
      `${ETSY_LANGUAGE} Etsy titles, at most 140 characters each. Each of % : & + at most ONCE per title. Strongest first.`,
    ),
})

export interface TitleOptionsArgs extends ComposeArgs {
  /** How many options to ask for per marketplace. */
  count?: number
  /** The titles in use, so the model proposes alternatives rather than repeats. */
  current: { ebay: string; etsy: string }
}

export interface TitleOptions {
  ebay: string[]
  etsy: string[]
  /** Options the model returned that broke a marketplace rule and were dropped. */
  rejected: number
}

/**
 * Proposes several titles per marketplace instead of one.
 *
 * The title is the field where a single generation is least trustworthy: it is
 * the highest-leverage line in a listing and there is no way to tell a good one
 * from a bad one by inspection. Offering a handful turns an unverifiable
 * judgement into a choice the seller can actually make.
 *
 * Invalid options are dropped rather than repaired. The repair loop exists in
 * `composeListingCopy` because one bad field there fails the whole listing;
 * here a rejected title just leaves the others, and a round trip to rescue one
 * option out of five is not worth the call.
 */
export async function proposeTitleOptions(args: TitleOptionsArgs): Promise<TitleOptions> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey })
  const count = args.count ?? 5

  const task = `Write ONLY titles: ${count} options for eBay (German) and ${count} for Etsy (${ETSY_LANGUAGE}).

These are in use now and must not be repeated:
- eBay: ${args.current.ebay}
- Etsy: ${args.current.etsy}

Each option must be a real alternative rather than the same words reordered. Vary what it leads with and how the item is framed — what the thing is, who it is for, where it goes, what problem it solves. Order them strongest first.

Write no descriptions, no tags, nothing but the titles.`

  let response: Awaited<ReturnType<typeof client.messages.parse>>
  try {
    response = await client.messages.parse({
      model: config.anthropic.model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      output_config: { format: zodOutputFormat(TitleOptionsGenerationSchema) },
      messages: [{ role: 'user', content: buildUserPrompt(args, task) }],
    })
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new UserError(
        'Anthropic rejected the API key.',
        'Check ANTHROPIC_API_KEY in .env — the template ships with a placeholder that has to be replaced.',
      )
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new UserError('Anthropic rate limit reached.', 'Wait a moment and run the command again.')
    }
    if (error instanceof Anthropic.APIError) {
      throw new UserError(`Anthropic returned ${error.status}: ${error.message}`)
    }
    throw error
  }

  const generated = response.parsed_output
  if (!generated) throw new UserError('Claude returned no title options.')

  let rejected = 0
  const keep = (values: string[], validate: (v: string) => boolean, exclude: string): string[] => {
    const seen = new Set([exclude.trim().toLowerCase()])
    const out: string[] = []
    for (const raw of values) {
      const title = raw.trim()
      if (!title || seen.has(title.toLowerCase())) continue
      if (!validate(title)) {
        rejected++
        continue
      }
      seen.add(title.toLowerCase())
      out.push(title)
    }
    return out
  }

  return {
    ebay: keep(generated.ebay, (t) => EbayCopySchema.shape.title.safeParse(t).success, args.current.ebay),
    etsy: keep(generated.etsy, (t) => EtsyTitleSchema.safeParse(t).success, args.current.etsy),
    rejected,
  }
}

export async function composeListingCopy(args: ComposeArgs): Promise<ListingCopy> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey })
  const maxAttempts = args.maxAttempts ?? 3

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: buildUserPrompt(args, `Write the eBay (German) and Etsy (${ETSY_LANGUAGE}) copy now.`),
    },
  ]

  let lastError: z.ZodError | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // `thinking` is deliberately omitted: on Claude Opus 5 that runs adaptive
    // thinking, which is what we want. Passing it explicitly is not possible
    // with this SDK version, whose types predate the adaptive mode.
    let response: Awaited<ReturnType<typeof client.messages.parse>>
    try {
      response = await client.messages.parse({
        model: config.anthropic.model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        output_config: { format: zodOutputFormat(GenerationSchema) },
        messages,
      })
    } catch (error) {
      // A bad key or a rate limit is an ordinary situation, not a crash.
      if (error instanceof Anthropic.AuthenticationError) {
        throw new UserError(
          'Anthropic rejected the API key.',
          'Check ANTHROPIC_API_KEY in .env — the template ships with a placeholder that has to be replaced.',
        )
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new UserError('Anthropic rate limit reached.', 'Wait a moment and run the command again.')
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new UserError('Could not reach the Anthropic API.', 'Check your network connection.')
      }
      if (error instanceof Anthropic.APIError) {
        throw new UserError(`Anthropic returned ${error.status}: ${error.message}`)
      }
      throw error
    }

    if (response.stop_reason === 'refusal') {
      throw new UserError(
        'Claude declined to write copy for this item.',
        'This is unusual for a product listing — check the model description for content that might trip a safety filter.',
      )
    }

    const generated = response.parsed_output
    if (!generated) {
      throw new UserError('Claude returned no structured output.', 'Retry; if it persists, the model may be overloaded.')
    }

    // Fold the aspect pairs back into the map the marketplace client wants, and
    // guarantee the brand: eBay treats "Marke" as required in most categories,
    // and an unbranded print is "Markenlos".
    const aspects: Record<string, string[]> = {}
    for (const { name, values } of generated.ebay.aspects) {
      if (name && values.length) aspects[name] = values
    }
    if (!Object.keys(aspects).some((k) => k.toLowerCase() === 'marke')) {
      aspects['Marke'] = ['Markenlos']
    }

    const candidate = { ...generated, ebay: { ...generated.ebay, aspects } }

    // The API cannot enforce length or character rules, so validate here.
    const validated = ListingCopySchema.safeParse(candidate)
    if (validated.success) {
      if (attempt > 1) log.detail(`Copy validated after ${attempt} attempts.`)
      return validated.data
    }

    lastError = validated.error
    if (attempt === maxAttempts) break

    log.detail(`Generated copy broke ${validated.error.issues.length} marketplace rule(s); asking for a repair.`)

    messages.push(
      { role: 'assistant', content: JSON.stringify(generated) },
      {
        role: 'user',
        content: `That output violates marketplace rules that will cause a hard API rejection:

${describeIssues(validated.error)}

Fix only the fields named above. Keep everything else identical. Return the corrected object.`,
      },
    )
  }

  throw new UserError(
    `Could not produce listing copy that satisfies the marketplace rules after ${maxAttempts} attempts.`,
    lastError ? `Last failures:\n${describeIssues(lastError)}` : undefined,
  )
}
