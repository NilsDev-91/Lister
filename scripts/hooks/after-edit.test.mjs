import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'

/**
 * Tested over the hook interface (stdin JSON, exit code, stderr). The real
 * typecheck and vitest commands are substituted via the script's documented
 * env seam with instant `node -e` stand-ins — what is under test is WHICH
 * checks run and how their verdicts are reported, not tsc itself.
 *
 * The child's own working directory is deliberately NOT the event cwd, so any
 * path resolved against process.cwd() instead of event.cwd fails these tests
 * (that was Bug 3).
 */

const SCRIPT = fileURLToPath(new URL('./after-edit.mjs', import.meta.url))

const PASS = 'node -e "process.exit(0)"'
const FAIL = 'node -e "console.error(\'boom\');process.exit(1)"'

const dirs = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway project with src/thing.ts and optionally its test. */
function project({ withTest }) {
  const dir = mkdtempSync(join(tmpdir(), 'lister-after-edit-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'thing.ts'), 'export {}\n')
  if (withTest) writeFileSync(join(dir, 'src', 'thing.test.ts'), 'export {}\n')
  return dir
}

function runHook({ filePath, cwd, typecheck = PASS, test = PASS, rawStdin }) {
  const input =
    rawStdin !== undefined
      ? rawStdin
      : JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath }, cwd })
  return spawnSync(process.execPath, [SCRIPT], {
    input,
    encoding: 'utf8',
    // NOT the event cwd — see the header comment.
    cwd: tmpdir(),
    env: { ...process.env, LISTER_HOOK_TYPECHECK_CMD: typecheck, LISTER_HOOK_TEST_CMD: test },
  })
}

describe('scope', () => {
  it('passes files outside src/ through without running anything', () => {
    const dir = project({ withTest: true })
    // FAIL commands prove nothing ran: had they run, the exit code would be 2.
    const r = runHook({ filePath: join(dir, 'README.md'), cwd: dir, typecheck: FAIL, test: FAIL })
    expect(r.status).toBe(0)
  })

  it('ignores non-TypeScript files under src/', () => {
    const dir = project({ withTest: true })
    const r = runHook({ filePath: join(dir, 'src', 'notes.md'), cwd: dir, typecheck: FAIL, test: FAIL })
    expect(r.status).toBe(0)
  })

  it('fails open on broken stdin', () => {
    expect(runHook({ rawStdin: '{ nope' }).status).toBe(0)
  })
})

describe('checks and verdicts', () => {
  it('reports a typecheck failure as feedback (exit 2)', () => {
    const dir = project({ withTest: false })
    const r = runHook({ filePath: join(dir, 'src', 'thing.ts'), cwd: dir, typecheck: FAIL })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/typecheck failed/)
  })

  it('runs the sibling test file when it exists — resolved against the EVENT cwd (Bug 3)', () => {
    const dir = project({ withTest: true })
    const r = runHook({ filePath: join(dir, 'src', 'thing.ts'), cwd: dir, test: FAIL })
    // Before the fix, existsSync checked the child's process.cwd(), found
    // nothing, silently skipped the tests, and reported success.
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/thing\.test\.ts failed/)
  })

  it('skips the test step without a false verdict when no test file exists', () => {
    const dir = project({ withTest: false })
    const r = runHook({ filePath: join(dir, 'src', 'thing.ts'), cwd: dir, test: FAIL })
    // The FAIL stand-in proves the test command was not invoked.
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('treats an edited .test.ts as its own test file', () => {
    const dir = project({ withTest: true })
    const r = runHook({ filePath: join(dir, 'src', 'thing.test.ts'), cwd: dir, test: FAIL })
    expect(r.status).toBe(2)
  })

  it('passes when both checks pass', () => {
    const dir = project({ withTest: true })
    const r = runHook({ filePath: join(dir, 'src', 'thing.ts'), cwd: dir })
    expect(r.status).toBe(0)
  })

  it('accepts a repo-relative file path', () => {
    const dir = project({ withTest: true })
    const r = runHook({ filePath: 'src/thing.ts', cwd: dir, test: FAIL })
    expect(r.status).toBe(2)
  })
})
