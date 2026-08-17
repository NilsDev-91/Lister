import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock, lockFileFor, STALE_LOCK_AFTER_MS } from './file-lock.js'

let dir: string
let target: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lister-lock-'))
  target = join(dir, 'store.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('withFileLock', () => {
  it('returns the callback result and leaves no lock behind', () => {
    expect(withFileLock(target, () => 42)).toBe(42)
    expect(existsSync(lockFileFor(target))).toBe(false)
  })

  it('can be taken again after a previous holder released it', () => {
    withFileLock(target, () => 'first')
    expect(withFileLock(target, () => 'second')).toBe('second')
  })

  it('releases the lock when the callback throws', () => {
    expect(() =>
      withFileLock(target, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')

    // The important part: the failure must not strand the lock.
    expect(existsSync(lockFileFor(target))).toBe(false)
    expect(withFileLock(target, () => 'recovered')).toBe('recovered')
  })

  it('gives up with an actionable error while another holder is active', () => {
    const lockPath = lockFileFor(target)
    writeFileSync(lockPath, '99999 someone-else\n')

    try {
      expect(() => withFileLock(target, () => 'never runs')).toThrow(/Another process is using/)
    } finally {
      rmSync(lockPath, { force: true })
    }
  })

  it('breaks a lock old enough to be abandoned', () => {
    const lockPath = lockFileFor(target)
    writeFileSync(lockPath, '99999 crashed\n')
    // Backdate it well past the staleness threshold, as a killed process would leave it.
    const old = new Date(Date.now() - STALE_LOCK_AFTER_MS - 60_000)
    utimesSync(lockPath, old, old)

    expect(withFileLock(target, () => 'took over')).toBe('took over')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('records the holding pid, so a stranded lock can be traced', () => {
    let contents = ''
    withFileLock(target, () => {
      contents = readFileSync(lockFileFor(target), 'utf8')
    })
    expect(contents).toContain(String(process.pid))
  })
})
