// PostToolUse hook (matcher: Edit|Write). After a change under src/, runs the
// typecheck and then the tests belonging to the edited file. Failures are
// reported back to Claude as feedback (exit 2 shows stderr; the edit itself is
// NOT reverted — the tool has already run).
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { relative, isAbsolute, join } from 'node:path'

let event
try {
  event = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''))
} catch {
  process.exit(0)
}
const filePath = String(event?.tool_input?.file_path ?? '')
if (!filePath) process.exit(0)

const cwd = event?.cwd ?? process.cwd()
const rel = (isAbsolute(filePath) ? relative(cwd, filePath) : filePath).replace(/\\/g, '/')

// Only TypeScript sources are checkable; anything else passes silently.
if (!rel.startsWith('src/') || rel.startsWith('..') || !rel.endsWith('.ts')) process.exit(0)

// Overridable so the hook's own tests can substitute instant commands; the
// defaults are the real checks. Behaviour as a hook is unchanged when the
// variables are absent.
const TYPECHECK_CMD = process.env.LISTER_HOOK_TYPECHECK_CMD ?? 'npm run typecheck'
const TEST_CMD = process.env.LISTER_HOOK_TEST_CMD ?? 'npx vitest run'

const failures = []

const typecheck = run(TYPECHECK_CMD)
if (typecheck.status !== 0) {
  failures.push(`npm run typecheck failed:\n${tail(typecheck)}`)
}

// The file's own tests: the file itself if it is a test, its sibling
// otherwise. Existence is checked against the EVENT's cwd — the hook process
// may be started elsewhere, and a check against process.cwd() would silently
// skip tests that exist.
const testFile = rel.endsWith('.test.ts') ? rel : rel.replace(/\.ts$/, '.test.ts')
if (rel.endsWith('.test.ts') || existsSync(join(cwd, testFile))) {
  const vitest = run(`${TEST_CMD} "${testFile}"`)
  if (vitest.status !== 0) {
    failures.push(`vitest run ${testFile} failed:\n${tail(vitest)}`)
  }
}

if (failures.length) {
  process.stderr.write(failures.join('\n\n'))
  process.exit(2)
}
process.exit(0)

function run(commandLine) {
  // shell:true so npm/npx resolve to their .cmd shims on Windows.
  return spawnSync(commandLine, { cwd, shell: true, encoding: 'utf8', timeout: 180_000 })
}

/** The last chunk of output — the part that names the failing line. */
function tail(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  return text.length > 4000 ? `…\n${text.slice(-4000)}` : text
}
