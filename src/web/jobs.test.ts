import { describe, it, expect, afterEach } from 'vitest'
import { startJob as start, getJob, clearJobs, JOB_RETENTION_MS } from './jobs.js'
import type { Io } from '../util/io.js'
import { UserError } from '../util/log.js'

/** The description is fixed for these tests; only the work under it varies. */
const startJob = (work: (io: Io) => Promise<string>, now?: number) =>
  now === undefined
    ? start(work, { label: 'Test', hint: 'läuft.' })
    : start(work, { label: 'Test', hint: 'läuft.' }, now)

/**
 * The job registry is what lets the browser watch a creation run instead of
 * staring at a blank tab. Two properties carry it: the lines have to be visible
 * *while* the work runs, and a failure has to be recorded rather than escaping
 * as an unhandled rejection — this process holds live marketplace credentials.
 */

afterEach(() => clearJobs())

/** Resolves once the job has left the running state. */
async function settled(id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (getJob(id)?.state !== 'running') return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('job never settled')
}

describe('startJob', () => {
  it('exposes progress lines while the work is still running', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))

    const job = startJob(async (io) => {
      io.step('Licence check')
      io.detail('CC BY 4.0 permits commercial use')
      await gate
      return 'mw-1-abc'
    })

    // Let the synchronous prefix of the work run.
    await new Promise((r) => setTimeout(r, 0))

    expect(job.state).toBe('running')
    expect(getJob(job.id)?.lines.map((l) => l.message)).toEqual([
      'Licence check',
      'CC BY 4.0 permits commercial use',
    ])

    release()
    await settled(job.id)
    expect(getJob(job.id)?.state).toBe('done')
    expect(getJob(job.id)?.result).toBe('mw-1-abc')
  })

  it('records a failure with its hint instead of rejecting', async () => {
    const job = startJob(async () => {
      throw new UserError('The licence forbids selling prints.', 'Use --i-have-commercial-rights.')
    })
    await settled(job.id)

    const settledJob = getJob(job.id)!
    expect(settledJob.state).toBe('failed')
    expect(settledJob.result).toBeNull()
    expect(settledJob.error).toEqual({
      message: 'The licence forbids selling prints.',
      hint: 'Use --i-have-commercial-rights.',
    })
  })

  it('records a plain error, which carries no hint', async () => {
    const job = startJob(async () => {
      throw new Error('socket hang up')
    })
    await settled(job.id)
    expect(getJob(job.id)?.error).toEqual({ message: 'socket hang up' })
  })

  it('gives every job an unguessable id — the id is what guards the transcript', () => {
    const ids = new Set(Array.from({ length: 20 }, () => startJob(async () => 'x').id))
    expect(ids.size).toBe(20)
    for (const id of ids) expect(id.length).toBeGreaterThanOrEqual(12)
  })

  it('drops finished jobs once they are past their retention, keeping running ones', async () => {
    const old = startJob(async () => 'done-long-ago')
    await settled(old.id)

    let release!: () => void
    const running = startJob(async () => {
      await new Promise<void>((r) => (release = r))
      return 'still-going'
    })
    await new Promise((r) => setTimeout(r, 0))

    // Pruning happens when the next job starts.
    startJob(async () => 'trigger', Date.now() + JOB_RETENTION_MS + 1000)

    expect(getJob(old.id), 'a finished job past retention is dropped').toBeUndefined()
    expect(getJob(running.id), 'a running job is never pruned').toBeDefined()

    release()
    await settled(running.id)
  })
})
