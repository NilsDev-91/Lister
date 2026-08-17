// SessionStart hook. Tells every new session which eBay environment is active
// and whether Etsy OAuth is connected — the difference between "publishing is
// a free sandbox experiment" and "publishing costs real money".
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

let cwd = process.cwd()
try {
  const event = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''))
  if (event?.cwd) cwd = event.cwd
} catch {
  // No stdin payload — fall back to the working directory.
}

const ebayEnv = resolveEbayEnv()
const etsy = etsyStatus()

const banner =
  `eBay environment: ${ebayEnv}` +
  (ebayEnv === 'production' ? ' — publishes cost real money.' : ' (sandbox listings are free).') +
  ` Etsy OAuth: ${etsy}.`

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: banner },
  }),
)
process.exit(0)

function resolveEbayEnv() {
  if (process.env.EBAY_ENV) return process.env.EBAY_ENV
  const envFile = join(cwd, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*EBAY_ENV\s*=\s*["']?(\w+)/)
      if (m) return m[1]
    }
  }
  return 'sandbox' // config.ts default
}

function etsyStatus() {
  try {
    const dataDir = process.env.LISTER_DATA_DIR ?? join(homedir(), '.3d-print-lister')
    const file = JSON.parse(readFileSync(join(dataDir, 'tokens.json'), 'utf8'))
    const tokens = file?.accounts?.etsy
    if (!tokens?.refreshToken) return 'not connected (run `lister auth etsy`)'
    if (typeof tokens.refreshExpiresAt === 'number' && Date.now() >= tokens.refreshExpiresAt) {
      return 'refresh token expired (run `lister auth etsy`)'
    }
    return 'connected'
  } catch {
    return 'not connected (run `lister auth etsy`)'
  }
}
