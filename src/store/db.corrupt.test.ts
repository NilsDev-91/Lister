import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

/**
 * An unreadable listings.json must be preserved, whatever made it unreadable.
 *
 * The schema-mismatch case already took the backup path; a file that is not
 * even JSON — a crash mid-edit, a stray editor artefact — used to throw the raw
 * parse error instead, leaving the user with no backup and no guidance. Both
 * roads now end the same way: original bytes renamed aside, loud error, clean
 * start.
 */

const dir = mkdtempSync(join(tmpdir(), 'lister-corrupt-'))

// The data dir is read at module load, so it has to be set before the store is
// imported — hence the dynamic import below rather than a top-level one.
beforeAll(() => {
  process.env['LISTER_DATA_DIR'] = dir
})

afterAll(() => {
  delete process.env['LISTER_DATA_DIR']
  rmSync(dir, { recursive: true, force: true })
})

describe('reading a corrupt listings.json', () => {
  it('backs the file up and throws, for syntax errors as for schema errors', async () => {
    writeFileSync(join(dir, 'listings.json'), '{ this is not json', 'utf8')

    const db = await import('./db.js')
    expect(() => db.listAll()).toThrow(/not valid JSON.*moved to/s)

    const backups = readdirSync(dir).filter((f) => f.startsWith('listings.json.corrupt-'))
    expect(backups).toHaveLength(1)

    // The store starts clean afterwards rather than staying wedged.
    expect(db.listAll()).toEqual([])
  })
})
