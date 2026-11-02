import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const LOCK_TIMEOUT_MS = 10_000
const POLL_MS = 5

/** The lock could not be taken within the caller's bound. */
export class FileLockTimeoutError extends Error {
  readonly code = "SETUP_LOCK_BUSY"
  readonly lockPath: string

  constructor(lockPath: string) {
    super(
      "SETUP_LOCK_BUSY: timed out waiting for " +
        lockPath +
        ". Another setup process may be " +
        "running; if none is, remove this lock file and retry.",
    )
    this.name = "FileLockTimeoutError"
    this.lockPath = lockPath
  }
}

/**
 * Identity of the process that published a lock, recorded inside the file so a
 * holder can recognise its own generation.
 */
export interface LockStamp {
  readonly token: string
  readonly acquiredAt: number
}

export interface FileLockOptions {
  /** Upper bound for acquiring the lock. Defaults to {@link LOCK_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** How often to retry while the lock is held elsewhere. */
  readonly pollMs?: number
}

/**
 * Cross-process exclusive lock around a read → edit → publish sequence.
 *
 * The lock is exclusive-create only: an existing lock is never renamed,
 * expired or removed by anyone but its owner. A holder that crashed leaves the
 * file behind and later writers fail with {@link FileLockTimeoutError}, so an
 * operator can inspect it instead of the runtime guessing whether the owner is
 * dead. Recovery is deliberately not automated: a time-based takeover can move
 * a lock that a live owner has just published, which would let two writers into
 * the critical section at once.
 *
 * A holder releases only the generation it published, identified by its own
 * stamp; a lock that was replaced in the meantime is left untouched.
 */
export function withFileLock<T>(target: string, operation: () => T, options: FileLockOptions = {}): T {
  const lock = target + ".lock"
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const pollMs = options.pollMs ?? POLL_MS
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(lock), { recursive: true })

  for (;;) {
    const stamp: LockStamp = { token: crypto.randomUUID(), acquiredAt: Date.now() }
    if (publishLock(lock, stamp)) {
      try {
        return operation()
      } finally {
        releaseLock(lock, stamp)
      }
    }

    if (Date.now() >= deadline) throw new FileLockTimeoutError(lock)
    pause(pollMs)
  }
}

/**
 * Publish the lock together with its owner stamp in one atomic step.
 *
 * Writing the stamp after creating the file leaves a window where a crash
 * produces a lock with no owner and no age. Hard-linking a fully written
 * temporary file gives the exclusive-create semantics of open() with the
 * content already in place.
 */
function publishLock(lock: string, stamp: LockStamp): boolean {
  const temporary = lock + ".pending." + process.pid + "." + crypto.randomUUID()
  writeFileSync(temporary, JSON.stringify(stamp), { mode: 0o600 })
  try {
    linkSync(temporary, lock)
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Remove the lock only when it is still this holder's own generation. */
function releaseLock(lock: string, stamp: LockStamp): void {
  try {
    if (readStamp(lock)?.token === stamp.token) rmSync(lock, { force: true })
  } catch {
    // The lock is already gone; nothing remains to release.
  }
}

function readStamp(file: string): LockStamp | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const fields = Object.fromEntries(Object.entries(parsed))
    const token = fields.token
    const acquiredAt = fields.acquiredAt
    if (typeof token !== "string" || typeof acquiredAt !== "number") return undefined
    return { token, acquiredAt }
  } catch {
    return undefined
  }
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}
