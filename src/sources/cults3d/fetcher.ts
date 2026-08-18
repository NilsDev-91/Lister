import { z } from 'zod'
import { UserError, log } from '../../util/log.js'
import { request, RateLimiter, ApiError } from '../../util/http.js'
import { normaliseLicense } from '../license.js'
import { config } from '../../config.js'
import { SourceModelSchema, type SourceImage, type SourceModel } from '../../types.js'

/**
 * Reads a single Cults3D model through the official GraphQL API.
 *
 * One endpoint, `https://cults3d.com/graphql`, HTTP Basic auth with
 * `base64(username:api_key)` — the key is self-service under
 * https://cults3d.com/en/api/keys, but nothing works without it, introspection
 * included. The API serves no 3D files; it does serve photos, title,
 * description and tags, which is exactly what a listing needs.
 *
 * Scope matches the MakerWorld fetcher: one model, fetched because the user
 * typed its URL. No crawling, no enumeration.
 */

const ENDPOINT = 'https://cults3d.com/graphql'

/** Documented ceiling is ~60 requests / 30 s; 2/s stays safely under it. */
const limiter = new RateLimiter(2)

/**
 * Model URLs carry four path segments: locale, a localised "3d-model" word,
 * a (localised) category, and the slug. Verified against the live API for all
 * ten locales — every "3d-model" segment contains `3d` (`3d-model`,
 * `modell-3d`, `mod%C3%A8le-3d`, `3d-moderu`, `3d-m%C3%B3x%C3%ADng`, …),
 * which is also what keeps user-profile URLs (`/en/users/<nick>/creations`)
 * from being misread as models. The slug is locale-independent and is what
 * `creation(slug:)` takes.
 */
const MODEL_URL = /^https?:\/\/(?:www\.)?cults3d\.com\/[a-z]{2}\/([^/]*3d[^/]*)\/[^/]+\/([^/?#]+)/i

export function parseModelUrl(input: string): { externalId: string; normalised: string } {
  const trimmed = input.trim()
  const match = MODEL_URL.exec(trimmed)
  if (!match?.[2]) {
    throw new UserError(
      `"${input}" is not a Cults3D model URL.`,
      'Expected something like https://cults3d.com/en/3d-model/<category>/<model-name> — short links (cults3d.com/:12345) are not supported, open the model page and copy its full URL.',
    )
  }
  const externalId = decodeURIComponent(match[2])
  return { externalId, normalised: trimmed.replace(/[?#].*$/, '') }
}

/**
 * The one query the adapter makes. Field names verified via live introspection
 * on 2026-08-18; the response for a real model is pinned as
 * `__fixtures__/creation-flexi-turtle.json`.
 *
 * `illustrations.imageUrl(version: LARGE)` still returns 516×516 proxy URLs —
 * the API exposes nothing larger for the gallery. That clears eBay's 500 px
 * minimum, barely; it is a platform limit, not a bug here.
 */
const MODEL_QUERY = `query Model($slug: String!) {
  creation(slug: $slug) {
    slug
    url(locale: EN)
    name(locale: EN)
    description(locale: EN)
    creator { nick }
    tags(locale: EN)
    license { code name(locale: EN) spdxId allowsCommercialUse }
    illustrations { imageUrl(version: LARGE) position }
    publishedAt
  }
}`

/**
 * The GraphQL payload, validated at the seam. Everything the schema marks
 * non-null is required here; the rest degrades gracefully.
 */
const CreationPayloadSchema = z.object({
  slug: z.string().min(1),
  url: z.string().url().nullish(),
  name: z.string().min(1),
  description: z.string().nullish(),
  creator: z.object({ nick: z.string() }).nullish(),
  tags: z.array(z.string()).nullish(),
  license: z.object({
    code: z.string().min(1),
    name: z.string().nullish(),
    spdxId: z.string().nullish(),
    allowsCommercialUse: z.boolean().nullish(),
  }),
  illustrations: z
    .array(z.object({ imageUrl: z.string().nullish(), position: z.number().int().nullish() }))
    .nullish(),
  publishedAt: z.string().nullish(),
})

/**
 * Turns one `creation` payload into the shared model shape. Pure and exported
 * so the fixture tests exercise exactly the code the live path runs.
 */
export function parseCreation(payload: unknown, inputUrl: string): SourceModel {
  const parsed = CreationPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new UserError(
      `Cults3D returned a creation in an unexpected shape:\n${parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`,
      'The API may have changed — re-check the introspection against the fixture.',
    )
  }
  const creation = parsed.data

  // The display name is what a person recognises; the code is the stable
  // fallback. Both spellings sit in the CULTS3D licence table, verified
  // against the live catalog.
  const license = normaliseLicense(creation.license.name?.trim() || creation.license.code, 'CULTS3D')

  const images: SourceImage[] = (creation.illustrations ?? [])
    .filter((i): i is { imageUrl: string; position: number | null | undefined } => Boolean(i.imageUrl))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((i, index) => ({ url: i.imageUrl, rank: index }))

  const model: SourceModel = {
    // The API's canonical English URL, so the same model pasted from any
    // locale lands on one sourceUrl — that is what the duplicate warning keys on.
    sourceUrl: creation.url ?? inputUrl,
    platform: 'CULTS3D',
    externalId: creation.slug,
    title: creation.name,
    description: creation.description ?? '',
    designer: creation.creator?.nick ?? 'Unknown designer',
    tags: creation.tags ?? [],
    images,
    license,
    fetchedAt: new Date().toISOString(),
  }

  const validated = SourceModelSchema.safeParse(model)
  if (!validated.success) {
    throw new UserError(
      `The parsed Cults3D model failed validation:\n${validated.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return validated.data
}

interface GraphQlResponse {
  data?: { creation?: unknown } | null
  errors?: { message?: string }[]
}

/**
 * Fetches and parses one model.
 *
 * Retries are safe and wanted here: the query is read-only, and `request()`
 * already backs off exponentially on 429/5xx, honouring Retry-After — which is
 * exactly what Cults3D's rate-limit contract (~60/30 s, ~500/day) asks for.
 */
export async function fetchModel(inputUrl: string): Promise<SourceModel> {
  const { externalId: slug, normalised } = parseModelUrl(inputUrl)
  log.step(`Reading Cults3D model ${slug}`)

  const auth = `Basic ${Buffer.from(`${config.cults3d.username}:${config.cults3d.apiKey}`).toString('base64')}`

  let response: Response
  try {
    response = await limiter.run(() =>
      request(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({ query: MODEL_QUERY, variables: { slug } }),
      }),
    )
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      throw new UserError(
        `Cults3D refused the credentials (${error.status}).`,
        'Check CULTS3D_USERNAME and CULTS3D_API_KEY in .env — the key is minted at https://cults3d.com/en/api/keys.',
      )
    }
    throw error
  }

  const json = (await response.json()) as GraphQlResponse

  // GraphQL reports field-level failures as 200 + errors; surfacing them
  // beats parsing a half-empty data object.
  if (json.errors?.length) {
    throw new UserError(
      `Cults3D returned GraphQL errors:\n${json.errors.map((e) => `- ${e.message ?? 'unknown error'}`).join('\n')}`,
    )
  }

  if (!json.data?.creation) {
    throw new UserError(
      `Cults3D knows no model with the slug "${slug}".`,
      'Open the model in the browser and copy the URL from the address bar — the last path segment must be the model slug.',
    )
  }

  const model = parseCreation(json.data.creation, normalised)

  log.ok(`"${model.title}" by ${model.designer}`)
  log.detail(`Licence: ${model.license.raw || '(none found)'} → commercial use: ${model.license.commercialUse}`)
  if (!model.description) log.warn('No description on the page — copy will be written from the title and your notes.')
  if (!model.images.length) log.warn('No images found — you will need to supply your own photos.')

  return model
}
