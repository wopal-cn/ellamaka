import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type HomeLockMode = "shared" | "exclusive"

export interface HomeLockToken {
  readonly mode: HomeLockMode
  readonly pid: number
  readonly time: number
  readonly id: string
  readonly tokenPath: string
}

const OWNER_FILE = "owner.json"
const WRITER_DIR = "exclusive"
const READERS_DIR = "shared"
const RECLAIM_DIR = "exclusive.reclaim"
const OWNERLESS_GRACE_MS = 30_000
const POLL_MS = 15

type Owner = Pick<HomeLockToken, "pid" | "time" | "id">

/**
 * Cross-process shared/exclusive guard for the single DSH Home.
 *
 * A writer first creates the exclusive intent directory atomically. New
 * readers then stop entering; a reader that races the writer re-checks after
 * publishing its token and backs out. The writer waits for all published
 * readers to drain before it returns. This gives version changes an exclusive
 * window while allowing any number of same-version runtime processes to hold
 * shared access for their whole Home-using lifetime.
 */
export async function acquireHomeLock(
  lockPath: string,
  mode: HomeLockMode,
  timeoutMs: number,
): Promise<HomeLockToken | null> {
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(lockPath), { recursive: true })
  mkdirSync(lockPath, { recursive: true })
  mkdirSync(join(lockPath, READERS_DIR), { recursive: true })
  return mode === "shared" ? acquireShared(lockPath, deadline) : acquireExclusive(lockPath, deadline)
}

async function acquireShared(lockPath: string, deadline: number): Promise<HomeLockToken | null> {
  const writerPath = join(lockPath, WRITER_DIR)
  const readersPath = join(lockPath, READERS_DIR)
  for (;;) {
    await reclaimDeadWriter(lockPath)
    if (existsSync(writerPath)) {
      if (Date.now() >= deadline) return null
      await sleep(POLL_MS)
      continue
    }

    const token = createToken("shared", join(readersPath, `${process.pid}-${Date.now()}-${randomUUID()}`))
    if (!publishToken(token)) return null

    // Close the reader-vs-writer create race. A writer that appeared between
    // our first check and token publication owns intent; back out and retry.
    if (!existsSync(writerPath)) return token
    releasePublishedToken(token)
    if (Date.now() >= deadline) return null
    await sleep(POLL_MS)
  }
}

async function acquireExclusive(lockPath: string, deadline: number): Promise<HomeLockToken | null> {
  const writerPath = join(lockPath, WRITER_DIR)
  const readersPath = join(lockPath, READERS_DIR)
  for (;;) {
    await reclaimDeadWriter(lockPath)
    const token = createToken("exclusive", writerPath)
    let created = false
    try {
      mkdirSync(writerPath)
      created = true
    } catch {
      // Another writer owns intent.
    }
    if (!created) {
      if (Date.now() >= deadline) return null
      await sleep(POLL_MS)
      continue
    }
    try {
      writeOwner(join(writerPath, OWNER_FILE), token)
    } catch {
      rmSync(writerPath, { recursive: true, force: true })
      return null
    }

    for (;;) {
      reapDeadReaders(readersPath)
      if (readerCount(readersPath) === 0) return token
      if (Date.now() >= deadline) {
        releasePublishedToken(token)
        return null
      }
      await sleep(POLL_MS)
    }
  }
}

export async function releaseHomeLock(_lockPath: string, token: HomeLockToken): Promise<void> {
  releasePublishedToken(token)
}

function createToken(mode: HomeLockMode, tokenPath: string): HomeLockToken {
  return { mode, pid: process.pid, time: Date.now(), id: randomUUID(), tokenPath }
}

function publishToken(token: HomeLockToken): boolean {
  try {
    mkdirSync(token.tokenPath)
    writeOwner(join(token.tokenPath, OWNER_FILE), token)
    return true
  } catch {
    rmSync(token.tokenPath, { recursive: true, force: true })
    return false
  }
}

function writeOwner(path: string, token: Owner): void {
  writeFileSync(path, JSON.stringify({ pid: token.pid, time: token.time, id: token.id }))
}

function releasePublishedToken(token: HomeLockToken): void {
  const current = readOwner(token.tokenPath)
  if (!current || current.pid !== token.pid || current.time !== token.time || current.id !== token.id) return
  rmSync(token.tokenPath, { recursive: true, force: true })
}

function readerCount(readersPath: string): number {
  try {
    return readdirSync(readersPath, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  } catch {
    return 0
  }
}

function reapDeadReaders(readersPath: string): void {
  let entries: string[]
  try {
    entries = readdirSync(readersPath)
  } catch {
    return
  }
  for (const name of entries) {
    const tokenPath = join(readersPath, name)
    if (isDeadOrOrphaned(tokenPath)) rmSync(tokenPath, { recursive: true, force: true })
  }
}

async function reclaimDeadWriter(lockPath: string): Promise<void> {
  const writerPath = join(lockPath, WRITER_DIR)
  if (!existsSync(writerPath) || !isDeadOrOrphaned(writerPath)) return
  const reclaimPath = join(lockPath, RECLAIM_DIR)
  try {
    mkdirSync(reclaimPath)
  } catch {
    return
  }
  try {
    if (existsSync(writerPath) && isDeadOrOrphaned(writerPath)) {
      rmSync(writerPath, { recursive: true, force: true })
    }
  } finally {
    rmSync(reclaimPath, { recursive: true, force: true })
  }
}

function isDeadOrOrphaned(tokenPath: string): boolean {
  const owner = readOwner(tokenPath)
  if (owner) return !isProcessAlive(owner.pid)
  try {
    return Date.now() - statSync(tokenPath).mtimeMs > OWNERLESS_GRACE_MS
  } catch {
    return false
  }
}

function readOwner(tokenPath: string): Owner | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(tokenPath, OWNER_FILE), "utf8"))
    if (typeof raw !== "object" || raw === null) return undefined
    if (!("pid" in raw) || !("time" in raw) || !("id" in raw)) return undefined
    if (typeof raw.pid !== "number" || typeof raw.time !== "number" || typeof raw.id !== "string") return undefined
    return { pid: raw.pid, time: raw.time, id: raw.id }
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
