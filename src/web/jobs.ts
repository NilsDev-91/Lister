import { randomBytes } from 'node:crypto'
import { collectingIo, type CollectedLine, type Io } from '../util/io.js'

/**
 * Work that outlives its HTTP request.
 *
 * Creating a listing takes half a minute — the page is parsed, the licence is
 * checked, Claude writes both marketplaces' copy, images are staged. Holding
 * the POST open for all of that leaves the browser on a blank spinner with no
 * way to tell a slow model from a hung process.
 *
 * So the request starts a job and returns immediately, and the browser watches
 * it. The progress shown is not a decoration: the commands already report every
 * step through their `Io`, and this collects exactly those lines. What the page
 * displays is what the command actually did, in the order it did it.
 *
 * In memory only, and deliberately: a job is worth watching for as long as the
 * tab is open and worth nothing afterwards. The listing itself is persisted by
 * the command, not by this.
 */

export type JobState = 'running' | 'done' | 'failed'

export interface Job {
  id: string
  /** What the page calls this run, e.g. "Inserat wird erstellt". */
  label: string
  /** One line under the bar while it runs — what to expect, and how long. */
  hint: string
  state: JobState
  /** Live reference to the collecting Io's lines — it grows as the work runs. */
  lines: CollectedLine[]
  /** The listing id, once the work succeeded. */
  result: string | null
  error: { message: string; hint?: string } | null
  startedAt: number
  finishedAt: number | null
}

const jobs = new Map<string, Job>()

/**
 * How long a finished job stays readable.
 *
 * Long enough that a browser which lost the connection mid-run can still come
 * back and read the outcome; short enough that a day of listing does not
 * accumulate transcripts in memory.
 */
export const JOB_RETENTION_MS = 10 * 60 * 1000

function prune(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && now - job.finishedAt > JOB_RETENTION_MS) jobs.delete(id)
  }
}

/**
 * Runs `work` in the background and returns the id to watch it by.
 *
 * The id is random rather than sequential: these routes are GET, so the id is
 * the capability that guards someone else's progress transcript.
 */
export interface JobDescription {
  label: string
  hint: string
}

export function startJob(
  work: (io: Io) => Promise<string>,
  description: JobDescription,
  now = Date.now(),
): Job {
  prune(now)

  const io = collectingIo(true)
  const job: Job = {
    id: randomBytes(9).toString('base64url'),
    label: description.label,
    hint: description.hint,
    state: 'running',
    lines: io.lines,
    result: null,
    error: null,
    startedAt: now,
    finishedAt: null,
  }
  jobs.set(job.id, job)

  // Detached on purpose — and therefore catching everything. An escaping
  // rejection here would be unhandled, and this process holds live credentials.
  void (async () => {
    try {
      job.result = await work(io)
      job.state = 'done'
    } catch (error) {
      job.state = 'failed'
      job.error = {
        message: error instanceof Error ? error.message : String(error),
        ...(error && typeof error === 'object' && 'hint' in error && typeof error.hint === 'string'
          ? { hint: error.hint }
          : {}),
      }
    } finally {
      job.finishedAt = Date.now()
    }
  })()

  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

/** Testing seam: drops every job, running or finished. */
export function clearJobs(): void {
  jobs.clear()
}
