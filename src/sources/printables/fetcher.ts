import { z } from 'zod'
import { UserError, log } from '../../util/log.js'
import { request, RateLimiter } from '../../util/http.js'
import { normaliseLicense } from '../license.js'
import { SourceModelSchema, type SourceImage, type SourceModel } from '../../types.js'

/**
 * Reads a single Printables model through the public GraphQL endpoint.
 *
 * `https://api.printables.com/graphql/` is undocumented but in open use since
 * 2022; the query shape follows 100prznt/PrintablesGraphQL (MIT) and every
 * field below was verified against the live endpoint on 2026-08-18 (pinned in
 * `__fixtures__/`). No credentials: the endpoint answers without auth.
 * Introspection is disabled, so unknown fields fail as explicit GraphQL
 * errors — which is how the extra fields (`tags`, `license.name`, the
 * `licenses` catalog) were confirmed to exist.
 *
 * Scope matches the other adapters: one model, fetched because the user typed
 * its URL.
 */

const ENDPOINT = 'https://api.printables.com/graphql/'

/** Verified live: `images[].filePath` is relative to this host. */
const MEDIA_BASE = 'https://media.printables.com/'

/** No published limit; two per second is polite and far more than one create needs. */
const limiter = new RateLimiter(2)

/**
 * e.g. https://www.printables.com/model/3161-3d-benchy — the numeric id is the
 * identifier, the slug suffix is cosmetic, and a locale prefix (`/de/…`) may
 * or may not be present. The id is what `print(id:)` takes.
 */
const MODEL_URL = /^https?:\/\/(?:www\.)?printables\.com\/(?:[a-z]{2}\/)?model\/(\d+)/i

export function parseModelUrl(input: string): { externalId: string; normalised: string } {
  const match = MODEL_URL.exec(input.trim())
  if (!match?.[1]) {
    throw new UserError(
      `"${input}" is not a Printables model URL.`,
      'Expected something like https://www.printables.com/model/3161-3d-benchy',
    )
  }
  const externalId = match[1]
  // Locale- and slug-free, so the same model pasted in any shape lands on one
  // sourceUrl — that is what the duplicate warning keys on.
  return { externalId, normalised: `https://www.printables.com/model/${externalId}` }
}

const MODEL_QUERY = `query PrintProfile($id: ID!) {
  print(id: $id) {
    id
    slug
    name
    summary
    description
    user { publicUsername }
    tags { name }
    images { filePath }
    license { id name disallowRemixing }
    datePublished
  }
}`

const PrintPayloadSchema = z.object({
  id: z.string().min(1),
  slug: z.string().nullish(),
  name: z.string().min(1),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  user: z.object({ publicUsername: z.string() }).nullish(),
  tags: z.array(z.object({ name: z.string() })).nullish(),
  images: z.array(z.object({ filePath: z.string().nullish() })).nullish(),
  license: z.object({
    id: z.string().min(1),
    name: z.string().nullish(),
    disallowRemixing: z.boolean().nullish(),
  }),
  datePublished: z.string().nullish(),
})

/**
 * Printables descriptions arrive as HTML (`<h3>`, `<p>`, links). The copy
 * pipeline wants prose, so tags become line breaks and entities fold back —
 * a deliberately small conversion, not a sanitiser: this text is only ever
 * fed to the copywriter, never rendered.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Turns one `print` payload into the shared model shape. Pure and exported so
 * the fixture tests exercise exactly the code the live path runs.
 */
export function parsePrint(payload: unknown): SourceModel {
  const parsed = PrintPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new UserError(
      `Printables returned a print in an unexpected shape:\n${parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`,
      'The API is undocumented and may have changed — re-check the fixture against a live response.',
    )
  }
  const print = parsed.data

  const images: SourceImage[] = (print.images ?? [])
    .map((i) => i.filePath)
    .filter((p): p is string => Boolean(p))
    .map((path, index) => ({ url: MEDIA_BASE + path.replace(/^\//, ''), rank: index }))

  const model: SourceModel = {
    sourceUrl: `https://www.printables.com/model/${print.id}`,
    platform: 'PRINTABLES',
    externalId: print.id,
    title: print.name,
    description: stripHtml(print.description ?? '') || print.summary?.trim() || '',
    designer: print.user?.publicUsername ?? 'Unknown designer',
    tags: (print.tags ?? []).map((t) => t.name),
    images,
    license: normaliseLicense(print.license.name ?? '', 'PRINTABLES'),
    fetchedAt: new Date().toISOString(),
  }

  const validated = SourceModelSchema.safeParse(model)
  if (!validated.success) {
    throw new UserError(
      `The parsed Printables model failed validation:\n${validated.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return validated.data
}

interface GraphQlResponse {
  data?: { print?: unknown } | null
  errors?: { message?: string }[]
}

export async function fetchModel(inputUrl: string): Promise<SourceModel> {
  const { externalId } = parseModelUrl(inputUrl)
  log.step(`Reading Printables model ${externalId}`)

  const response = await limiter.run(() =>
    request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'PrintProfile', query: MODEL_QUERY, variables: { id: externalId } }),
    }),
  )

  const json = (await response.json()) as GraphQlResponse

  if (json.errors?.length) {
    throw new UserError(
      `Printables returned GraphQL errors:\n${json.errors.map((e) => `- ${e.message ?? 'unknown error'}`).join('\n')}`,
      'The API is undocumented; if this persists, the schema may have changed.',
    )
  }

  if (!json.data?.print) {
    throw new UserError(
      `Printables knows no model with the id "${externalId}".`,
      'Open the model in the browser and copy the URL from the address bar.',
    )
  }

  const model = parsePrint(json.data.print)

  log.ok(`"${model.title}" by ${model.designer}`)
  log.detail(`Licence: ${model.license.raw || '(none found)'} → commercial use: ${model.license.commercialUse}`)
  if (!model.description) log.warn('No description on the page — copy will be written from the title and your notes.')
  if (!model.images.length) log.warn('No images found — you will need to supply your own photos.')

  return model
}
