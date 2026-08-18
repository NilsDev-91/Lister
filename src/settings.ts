import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { DATA_DIR, ensureDataDir } from './util/paths.js'
import { withFileLock, replaceFile } from './store/file-lock.js'

/**
 * App preferences — the things a seller sets once and stops thinking about.
 *
 * Deliberately not credentials. Secrets live in `.env`, which is gitignored and
 * never rendered; this file holds only choices that would be tedious to repeat
 * and harmless to read. Keeping the two apart means the settings page can show
 * everything it stores without a redaction rule to get wrong.
 */

export const SettingsSchema = z.object({
  /** Prefilled on the new-listing form. Most sellers print one material. */
  defaultMaterial: z.string().default('PLA'),
  defaultQuantity: z.number().int().positive().max(100_000).default(1),
  defaultProcessingDays: z.number().int().positive().max(90).default(3),
  /**
   * Add the designer credit line by default.
   *
   * On, because no marketplace requires it but several licences do, and a
   * credit costs nothing.
   */
  defaultCredit: z.boolean().default(true),
  /** Competitor listings sampled per research query. Higher costs more quota. */
  researchSampleSize: z.number().int().min(10).max(100).default(50),
  /**
   * Restrict Etsy research to shops delivering to this country.
   *
   * DE by default: the shop ships within Germany only — packaging-law
   * (VerpackG) registration is per country — so a shop that does not deliver
   * here is not a competitor and should not shape the price band or the
   * keywords. Empty means no restriction, which is what an international
   * seller would want; it was the default while the Etsy copy was English.
   * Matches ETSY_LANGUAGE in ai/composer.ts.
   */
  etsyBuyerCountry: z.string().max(2).default('DE'),
})
export type Settings = z.infer<typeof SettingsSchema>

const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/**
 * Reads the settings, falling back to defaults rather than failing.
 *
 * A preferences file is not worth an outage: if it is unreadable or carries an
 * older shape, the defaults are correct-enough and the seller loses a
 * convenience, not their work. The listing store makes the opposite trade for
 * the opposite reason.
 */
export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')))
    return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): Settings {
  const validated = SettingsSchema.parse(settings)
  ensureDataDir()
  withFileLock(SETTINGS_FILE, () => {
    const tmp = `${SETTINGS_FILE}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(validated, null, 2), { encoding: 'utf8', mode: 0o600 })
    replaceFile(tmp, SETTINGS_FILE)
  })
  return validated
}

export const SETTINGS_PATH = SETTINGS_FILE
