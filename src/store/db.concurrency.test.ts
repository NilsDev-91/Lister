import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The actual proof that the lock works.
 *
 * Two real OS processes hammer one store file with the same read-modify-write
 * shape the store uses. This has to be separate processes: two async tasks in
 * one process would never interleave, because the critical section contains no
 * `await` and Node will not preempt it.
 *
 * The test runs the scenario twice — once unguarded, once locked — and asserts
 * that the unguarded run actually loses writes. Without that half, a passing
 * locked run would prove nothing: it could just as easily mean the race never
 * triggered on this machine.
 */

let dir: string

const WRITES_PER_WORKER = 30
const TSX = resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const LOCK_MODULE = resolve(process.cwd(), 'src', 'store', 'file-lock.ts').replace(/\\/g, '/')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lister-conc-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function workerSource(storePath: string, tag: string, useLock: boolean): string {
  // The locked worker uses the same `replaceFile` the real store does, not a
  // bare renameSync. Otherwise the test would not exercise the production path
  // — and on Windows it would fail spuriously, because a rename onto a file any
  // other process has open (an indexer, a virus scanner) raises EPERM.
  return `
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
${useLock ? `import { withFileLock, replaceFile } from '${LOCK_MODULE}'` : ''}

const FILE = ${JSON.stringify(storePath)}

function spin(ms) { const until = Date.now() + ms; while (Date.now() < until) {} }

function mutate() {
  const data = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { entries: [] }
  // The gap between reading and writing is where a lost update happens. Making
  // it explicit means the unguarded run fails reliably instead of only on a
  // slow machine — a race test that passes by luck proves nothing.
  spin(3)
  data.entries.push(${JSON.stringify(tag)})
  const tmp = FILE + '.tmp.' + ${JSON.stringify(tag)}
  writeFileSync(tmp, JSON.stringify(data))
  ${useLock ? 'replaceFile(tmp, FILE)' : 'renameSync(tmp, FILE)'}
}

for (let i = 0; i < ${WRITES_PER_WORKER}; i++) {
  ${useLock ? 'withFileLock(FILE, mutate)' : 'mutate()'}
}
`
}

interface RunResult {
  codes: number[]
  entries: string[]
}

async function runBothWorkers(storePath: string, useLock: boolean): Promise<RunResult> {
  writeFileSync(storePath, JSON.stringify({ entries: [] }))

  const scripts = ['A', 'B'].map((tag) => {
    const file = join(dir, `${useLock ? 'locked' : 'plain'}-${tag}.ts`)
    writeFileSync(file, workerSource(storePath, tag, useLock))
    return file
  })

  // spawn, not the *Sync variants: the two must overlap in time.
  const running = scripts.map(
    (script) =>
      new Promise<number>((resolveExit) => {
        const child = spawn(TSX, [script], { stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' })
        let stderr = ''
        child.stderr?.on('data', (chunk) => (stderr += String(chunk)))
        child.on('close', (code) => {
          if (code !== 0) console.error(`worker ${script} exited ${code}:\n${stderr}`)
          resolveExit(code ?? 1)
        })
      }),
  )

  const codes = await Promise.all(running)
  const entries = JSON.parse(readFileSync(storePath, 'utf8')).entries as string[]
  return { codes, entries }
}

describe('store concurrency', () => {
  it('is unsafe without the lock — the regression this guards against', async () => {
    const storePath = join(dir, 'plain.json')
    const { codes, entries } = await runBothWorkers(storePath, false)

    // Unguarded, the pair fails in one of two ways, and both are real:
    //   - a lost update, so fewer entries survive than were written; or
    //   - on Windows, an outright crash, because `rename` onto a file another
    //     process holds open raises EPERM rather than replacing it.
    const lostWrites = entries.length < WRITES_PER_WORKER * 2
    const crashed = codes.some((c) => c !== 0)

    expect(
      lostWrites || crashed,
      'expected the unguarded run to lose writes or fail; if this passes cleanly the test is no longer proving anything',
    ).toBe(true)
  }, 120_000)

  it('keeps every write from two concurrent processes when locked', async () => {
    const storePath = join(dir, 'locked.json')
    const { codes, entries } = await runBothWorkers(storePath, true)

    expect(codes, 'both workers should exit cleanly').toEqual([0, 0])
    expect(entries.filter((e) => e === 'A')).toHaveLength(WRITES_PER_WORKER)
    expect(entries.filter((e) => e === 'B')).toHaveLength(WRITES_PER_WORKER)
    expect(entries).toHaveLength(WRITES_PER_WORKER * 2)
    expect(existsSync(`${storePath}.lock`), 'no lock file may survive a clean run').toBe(false)
  }, 120_000)
})
