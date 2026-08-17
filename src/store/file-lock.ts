import { openSync, closeSync, unlinkSync, statSync, writeSync, renameSync } from 'node:fs'
import { UserError } from '../util/log.js'

/**
 * A cross-process mutex for the JSON stores.
 *
 * The stores read a whole file, change one field, and write the whole file
 * back. The write itself is atomic (temp file + rename), so a file is never
 * left half-written — but that says nothing about two processes interleaving:
 *
 *     A: read {L1}                 B: read {L1}
 *     A: set offerId
 *     A: write {L1 + offerId}
 *                                  B: write {L1, L2}   ← offerId gone
 *
 * That is a lost update, and on the token store it is worse than an annoyance:
 * Etsy rotates its refresh token on every use, so writing back a stale copy
 * leaves a spent token on disk and the connection can only be restored by
 * consenting again.
 *
 * The critical sections are fully synchronous — read, mutate, write, rename,
 * with no `await` anywhere — so the lock is held for microseconds. That is what
 * makes a lock file reasonable here rather than a liability.
 */

/** How long to keep trying before giving up. */
const WAIT_TIMEOUT_MS = 1_000
/** Poll interval while another process holds the lock. */
const POLL_MS = 20
/**
 * A lock older than this is treated as abandoned. The critical section takes
 * microseconds, so nothing legitimate can hold one this long — only a process
 * killed outright between acquiring and releasing.
 */
const STALE_AFTER_MS = 10_000

function lockPathFor(targetPath: string): string {
  return `${targetPath}.lock`
}

/** Busy-wait. The callers are synchronous, so this cannot yield to the loop. */
function spinFor(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Intentionally empty: Atomics.wait needs a SharedArrayBuffer and worker
    // context, and the wait here is milliseconds at most.
  }
}

/** Removes a lock file that is old enough to be considered abandoned. */
function clearIfStale(lockPath: string): void {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (age > STALE_AFTER_MS) unlinkSync(lockPath)
  } catch {
    // Vanished between the check and now — that is the outcome we wanted.
  }
}

/**
 * Runs `fn` while holding an exclusive lock on `targetPath`.
 *
 * `fn` must be synchronous: an `await` inside would hold the lock across the
 * suspension and defeat the short-critical-section design that makes this safe.
 */
export function withFileLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = lockPathFor(targetPath)
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let fd: number | undefined

  for (;;) {
    try {
      // 'wx' fails when the file exists, which is what makes this a mutex.
      fd = openSync(lockPath, 'wx')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

      clearIfStale(lockPath)

      if (Date.now() >= deadline) {
        throw new UserError(
          `Another process is using ${targetPath}.`,
          `If no other run of this tool is active, delete ${lockPath} and try again.`,
        )
      }
      spinFor(POLL_MS)
    }
  }

  try {
    // Recorded for diagnosis if a lock ever does get stranded.
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
  } catch {
    // The lock works whether or not we managed to annotate it.
  }

  try {
    return fn()
  } finally {
    // Release even if `fn` threw, or the next run inherits a stranded lock.
    try {
      closeSync(fd)
    } catch {
      // Already closed; the unlink below is what matters.
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // Someone cleared it as stale. Nothing left to release.
    }
  }
}

export const lockFileFor = lockPathFor
export const STALE_LOCK_AFTER_MS = STALE_AFTER_MS

/**
 * Atomically replaces `target` with `tmp`.
 *
 * On POSIX `rename()` replaces the destination and that is the end of it. On
 * Windows the call raises EPERM when any other process merely has the target
 * open — a reader is enough — so the same code that is atomic on Linux throws
 * here. The writers are already serialised by `withFileLock`, but readers are
 * deliberately unlocked, so this brief retry covers the reader-versus-writer
 * overlap. Verified: without it, two concurrent processes crash on Windows.
 */
export function replaceFile(tmp: string, target: string, attempts = 20): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!retryable || attempt >= attempts) {
        // Do not leave the temp file behind on a genuine failure.
        try {
          unlinkSync(tmp)
        } catch {
          // Nothing more to clean up.
        }
        throw error
      }
      spinFor(5)
    }
  }
}
