const useColour = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR

const paint = (code: string, s: string) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s)

const dim = (s: string) => paint('2', s)
const red = (s: string) => paint('31', s)
const yellow = (s: string) => paint('33', s)
const green = (s: string) => paint('32', s)
const cyan = (s: string) => paint('36', s)

/**
 * Progress and diagnostics go to stderr so that stdout stays clean for data
 * the user might pipe (`lister status --json | jq`).
 */
export const log = {
  step: (msg: string) => console.error(cyan('→ ') + msg),
  info: (msg: string) => console.error('  ' + msg),
  detail: (msg: string) => console.error(dim('  ' + msg)),
  ok: (msg: string) => console.error(green('✓ ') + msg),
  warn: (msg: string) => console.error(yellow('! ') + msg),
  error: (msg: string) => console.error(red('✗ ') + msg),
  blank: () => console.error(''),
}

/** A failure we can explain to the user, as opposed to a bug. */
export class UserError extends Error {
  readonly hint: string | undefined
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'UserError'
    this.hint = hint
  }
}
