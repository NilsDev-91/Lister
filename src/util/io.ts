import { createInterface } from 'node:readline/promises'
import { log } from './log.js'

/**
 * How a command talks to whoever invoked it.
 *
 * The commands were written against a terminal: they print progress with
 * `log.*` and stop at `confirm()` prompts. The web UI needs the same logic
 * without either — it cannot answer a readline prompt, and its progress has to
 * reach a browser.
 *
 * Rather than fork the commands, they take an `Io` and default to the terminal
 * one. The CLI keeps behaving exactly as before.
 */
export interface Io {
  /** Ask a yes/no question. */
  confirm(question: string): Promise<boolean>
  /** A step is starting. */
  step(message: string): void
  /** Ordinary progress. */
  info(message: string): void
  /** Secondary detail. */
  detail(message: string): void
  /** Something worth noticing that is not fatal. */
  warn(message: string): void
  /** Success. */
  ok(message: string): void
}

/** The default: prompts on stdin, prints to stderr. */
export const terminalIo: Io = {
  async confirm(question: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    } finally {
      rl.close()
    }
  },
  step: (m) => log.step(m),
  info: (m) => log.info(m),
  detail: (m) => log.detail(m),
  warn: (m) => log.warn(m),
  ok: (m) => log.ok(m),
}

export interface CollectedLine {
  level: 'step' | 'info' | 'detail' | 'warn' | 'ok'
  message: string
}

/**
 * Collects output instead of printing it, and answers every question the same
 * way.
 *
 * The web UI decides up front whether an action is approved — the user clicked
 * a button that said what would happen — so there is nobody to ask mid-run.
 * `answer: false` makes a command that reaches an unexpected prompt stop
 * safely rather than proceed unasked.
 */
export function collectingIo(answer: boolean): Io & { lines: CollectedLine[] } {
  const lines: CollectedLine[] = []
  const push = (level: CollectedLine['level']) => (message: string) => {
    lines.push({ level, message })
  }
  return {
    lines,
    confirm: async () => answer,
    step: push('step'),
    info: push('info'),
    detail: push('detail'),
    warn: push('warn'),
    ok: push('ok'),
  }
}
