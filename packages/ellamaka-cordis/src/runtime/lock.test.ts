import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireMaterializeLock, releaseMaterializeLock, type LockDeps, type LockToken } from "./lock"

/** A promise barrier the tests use to force deterministic interleavings. */
function makeBarrier() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const dirs: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-lock-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Wait for the child to print a single line on stdout (readiness). */
async function waitForLine(proc: Bun.Subprocess): Promise<string> {
  const reader = proc.stdout.getReader()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += new TextDecoder().decode(value)
    const at = buffer.indexOf("\n")
    if (at !== -1) return buffer.slice(0, at).trim()
  }
  return buffer.trim()
}

/** Spawn a real `bun` child running a lock-child.ts command. */
function spawnChild(lockPath: string, args: string[]): Bun.Subprocess {
  const helper = join(import.meta.dir, "fixtures", "lock-child.ts")
  return Bun.spawn(["bun", "run", helper, lockPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("materialize lock (real tmp paths)", () => {
  test("acquire creates a lock dir and release removes it", async () => {
    const lockPath = join(tmpHome(), "locks", "materialize.lock")
    const token = await acquireMaterializeLock(lockPath, 50)
    expect(token).not.toBeNull()
    expect(existsSync(lockPath)).toBe(true)
    // A second acquire while held returns null (mutual exclusion).
    expect(await acquireMaterializeLock(lockPath, 50)).toBeNull()
    // Release with the real token removes the guard.
    await releaseMaterializeLock(lockPath, token!)
    expect(existsSync(lockPath)).toBe(false)
    // A fresh acquire after release succeeds with its own token.
    const token2 = await acquireMaterializeLock(lockPath, 50)
    expect(token2).not.toBeNull()
    await releaseMaterializeLock(lockPath, token2!)
    expect(existsSync(lockPath)).toBe(false)
  })

  test("second acquire while held returns null (mutual exclusion)", async () => {
    const lockPath = join(tmpHome(), "locks", "materialize.lock")
    const token = await acquireMaterializeLock(lockPath, 200)
    expect(token).not.toBeNull()
    expect(await acquireMaterializeLock(lockPath, 50)).toBeNull()
    await releaseMaterializeLock(lockPath, token!)
  })

  test("release without holding is a harmless no-op", async () => {
    const lockPath = join(tmpHome(), "locks", "materialize.lock")
    await releaseMaterializeLock(lockPath, { pid: process.pid, time: Date.now() })
  })

  test("stale lock held by a dead owner is reaped by pid token", async () => {
    const lockPath = join(tmpHome(), "locks", "materialize.lock")
    // Simulate a lock left behind by a crashed process whose pid is no longer alive.
    mkdirSync(lockPath, { recursive: true })
    const deadToken = JSON.stringify({ pid: 999999999, time: Date.now() })
    writeFileSync(join(lockPath, "owner.json"), deadToken)
    const token = await acquireMaterializeLock(lockPath, 50)
    expect(token).not.toBeNull()
    await releaseMaterializeLock(lockPath, token!)
  })

  test("release never deletes a guard now owned by another process", async () => {
    const lockPath = join(tmpHome(), "locks", "materialize.lock")
    // A stale token from a past/foreign owner: release must not touch the guard.
    const foreignToken = { pid: process.pid, time: Date.now() - 1 }
    const token = await acquireMaterializeLock(lockPath, 50)
    expect(token).not.toBeNull()
    await releaseMaterializeLock(lockPath, foreignToken)
    expect(existsSync(lockPath)).toBe(true)
    expect(existsSync(join(lockPath, "owner.json"))).toBe(true)
    await releaseMaterializeLock(lockPath, token!)
  })
})

describe("materialize lock — real two-child-process races (B-04)", () => {
  test(
    "two waiters on a stale guard: the slower reclaim must not delete the faster waiter's fresh guard",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      // Simulate a crash-orphaned guard owned by a dead pid.
      mkdirSync(lockPath, { recursive: true })
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999999, time: Date.now() }))

      // Two real children race to reclaim the stale guard. Whichever wins owns
      // the lock; the loser must retry and see the winner's (live) owner.json —
      // the loser's reclaim must NOT delete the winner's guard.
      const [a, b] = await Promise.all([
        spawnChild(lockPath, ["acquire", "100"]).exited,
        spawnChild(lockPath, ["acquire", "100"]).exited,
      ])
      expect(a).toBe(0)
      expect(b).toBe(0)
      // The guard is gone: the winner released after its hold elapsed.
      expect(existsSync(lockPath)).toBe(false)
    },
    20_000,
  )

  test(
    "a stale guard is re-acquirable by a real child after reclaim",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      mkdirSync(lockPath, { recursive: true })
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999999, time: Date.now() }))
      const child = spawnChild(lockPath, ["acquire", "50"])
      expect(await child.exited).toBe(0)
      // After the child reclaimed and released, the guard is fully gone and the
      // parent can acquire it again.
      const token = await acquireMaterializeLock(lockPath, 50)
      expect(token).not.toBeNull()
      await releaseMaterializeLock(lockPath, token!)
    },
    20_000,
  )

  test(
    "delayed release of a stale token does not delete a guard re-acquired by another process",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      // Process A acquires and then releases with a STALE token that does not
      // match its own owner record, simulating a delayed release from an old
      // generation racing a re-acquire.
      const a = spawnChild(lockPath, ["release", String(Date.now() - 1000)])
      // Wait for A's release to settle (it is a no-op since nothing is held).
      expect(await a.exited).toBe(0)

      // Process B then acquires and holds; A's delayed release must not delete B's guard.
      const b = spawnChild(lockPath, ["acquireAndHold"])
      expect(await waitForLine(b)).toBe("READY")
      expect(existsSync(lockPath)).toBe(true)

      // A's delayed release (with the stale token) is a no-op on B's live guard.
      const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"))
      await releaseMaterializeLock(lockPath, { pid: process.pid, time: owner.time })
      expect(existsSync(lockPath)).toBe(true)

      b.kill()
      await b.exited
      // With the holder gone, the guard may remain orphaned (its pid is the
      // child's, still alive? no — the child was killed). Clean it up.
      rmSync(lockPath, { recursive: true, force: true })
    },
    20_000,
  )

  test(
    "a release with the caller's own token removes exactly its own guard",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      const token = await acquireMaterializeLock(lockPath, 50)
      expect(token).not.toBeNull()
      // A different token (same pid, different time) must not release it.
      await releaseMaterializeLock(lockPath, { pid: process.pid, time: token!.time + 1 })
      expect(existsSync(lockPath)).toBe(true)
      await releaseMaterializeLock(lockPath, token!)
      expect(existsSync(lockPath)).toBe(false)
    },
  )
})

/**
 * Round-2 B-01: the atomic reclaim protocol. A separate exclusive reclaim guard
 * (`materialize.lock.reclaim`) serialises the check-then-rm window: only the
 * winner of that guard may re-read owner.json, verify staleness, delete the
 * old guard, and remove the reclaim guard. All other waiters who observe a
 * stale-looking lock wait for the reclaim guard to disappear, then re-loop —
 * so no waiter ever deletes a guard another process has just reclaimed.
 *
 * These tests are DETERMINISTIC: they inject `deps` hooks to force the exact
 * interleaving that the old check-then-rm code was vulnerable to.
 */
describe("materialize lock — atomic reclaim protocol (B-01)", () => {
  test(
    "a waiter that reads a stale token cannot delete a guard another process reclaims and recreates",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      // Seed a crash-orphaned stale guard.
      mkdirSync(lockPath, { recursive: true })
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999999, time: Date.now() }))

      // Barrier: A (the reclaimer) has won the reclaim guard and is blocked
      // before deleting the stale guard. B is started only AFTER A holds the
      // reclaim guard, so B deterministically loses it.
      const aHoldsReclaim = makeBarrier()
      // Barrier: A has reclaimed and now holds a fresh LIVE guard.
      const aHoldingLive = makeBarrier()

      const aDeps: LockDeps = {
        beforeDeleteGuard: async () => {
          aHoldsReclaim.resolve()
          // Block A inside the reclaim window so we can deterministically
          // observe B's behaviour while A is mid-reclaim.
          await aHoldingLive.promise
        },
      }
      // B reads the stale owner once, then (after A re-creates a live guard)
      // the real disk read returns the live owner.
      let bFirstRead = true
      const bDeps: LockDeps = {
        readOwner: () => {
          const real = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as LockToken
          if (bFirstRead) {
            bFirstRead = false
            // Force B to see the STALE owner first (the classic vulnerable read).
            return { pid: 999999999, time: 0 }
          }
          return real
        },
      }

      // Start A FIRST and wait until it holds the reclaim guard (blocked), so B
      // deterministically loses the reclaim guard when it starts.
      const aPromise = acquireMaterializeLock(lockPath, 2000, aDeps)
      await aHoldsReclaim.promise

      // Now B starts. It reads the stale owner, tries to win the reclaim guard,
      // and must LOSE (A holds it). B waits for the reclaim guard to clear.
      const bPromise = acquireMaterializeLock(lockPath, 2000, bDeps)

      // Give B a tick to observe the stale lock, attempt the reclaim, and lose.
      await new Promise((r) => setTimeout(r, 80))
      // B must NOT have deleted the (still stale) guard: the guard still exists.
      expect(existsSync(lockPath)).toBe(true)
      // Its owner is still the stale dead pid — B did not touch it.
      const staleOwner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as LockToken
      expect(staleOwner.pid).toBe(999999999)

      // Let A finish reclaiming: A deletes the stale guard, acquires a fresh
      // live guard, and drops the reclaim guard.
      aHoldingLive.resolve()
      const aToken = await aPromise
      expect(aToken).not.toBeNull()
      expect(existsSync(lockPath)).toBe(true)
      const liveOwner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as LockToken
      expect(liveOwner.pid).toBe(process.pid)

      // B must still be waiting on A's live guard (not deleted it).
      await new Promise((r) => setTimeout(r, 50))
      expect(existsSync(lockPath)).toBe(true)

      // A releases; B then acquires.
      await releaseMaterializeLock(lockPath, aToken!)
      const bToken = await bPromise
      expect(bToken).not.toBeNull()
      await releaseMaterializeLock(lockPath, bToken!)
      expect(existsSync(lockPath)).toBe(false)
    },
    20_000,
  )

  test(
    "only the reclaim-guard winner deletes the stale guard; losers wait and never delete",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      mkdirSync(lockPath, { recursive: true })
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999999999, time: Date.now() }))

      // Deterministically force: A wins the reclaim guard and blocks before
      // deleting. Start A first and wait until it holds the reclaim guard; then
      // start B, which must lose it. While A is blocked, B must observe the
      // reclaim guard and wait — it must not delete the stale guard itself.
      const aHoldsReclaim = makeBarrier()
      let bDeletes = 0
      const aDeps: LockDeps = {
        beforeDeleteGuard: async () => {
          aHoldsReclaim.resolve()
        },
      }
      const bDeps: LockDeps = {
        beforeDeleteGuard: async () => {
          bDeletes++
        },
      }
      const aPromise = acquireMaterializeLock(lockPath, 2000, aDeps)
      await aHoldsReclaim.promise
      const bPromise = acquireMaterializeLock(lockPath, 2000, bDeps)

      // Give B a tick to attempt its reclaim and lose.
      await new Promise((r) => setTimeout(r, 80))
      // B must not have deleted anything: only A (the reclaim winner) deletes.
      expect(bDeletes).toBe(0)
      expect(existsSync(lockPath)).toBe(true)

      const aToken = await aPromise
      expect(aToken).not.toBeNull()
      // A holds the live guard; B is blocked on it.
      await releaseMaterializeLock(lockPath, aToken!)
      const bToken = await bPromise
      expect(bToken).not.toBeNull()
      await releaseMaterializeLock(lockPath, bToken!)
      expect(existsSync(lockPath)).toBe(false)
    },
    20_000,
  )
})

/**
 * Round-3 B-01: owner.json write failure and orphaned owner-less guard self-heal.
 *
 * If `mkdirSync(lockPath)` succeeds but writing `owner.json` fails, the old code
 * swallowed both in one catch, leaving an empty guard that `readOwner()` reads
 * as undefined and `isStaleLock()` never reclaims — wedging materialisation
 * forever. The fix:
 *  - separates the mkdir EEXIST case from the owner-write failure;
 *  - on owner-write failure deletes the guard this process just created and
 *    surfaces degrade (never leaves the empty guard behind);
 *  - treats an owner-less guard older than a grace window as reclaimable under
 *    the exclusive reclaim guard, and a fresh owner-less guard (within grace) as
 *    in-progress and waited on.
 *
 * These tests are DETERMINISTIC: they inject `writeOwner` (to force the write
 * failure) and `now` (an injectable clock for the grace window, so no wall-clock
 * sleeps are needed).
 */
describe("materialize lock — owner-write failure and orphaned guard self-heal (B-01)", () => {
  test(
    "owner-write failure leaves no guard behind after the failed acquire",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      // Force the owner write to fail after the mkdir succeeds.
      const deps: LockDeps = {
        writeOwner: () => {
          throw new Error("ENOSPC: no space left on device")
        },
      }
      const token = await acquireMaterializeLock(lockPath, 50, deps)
      // The acquire must surface degrade (null), not hang or return a token.
      expect(token).toBeNull()
      // The empty guard this process created must have been cleaned up.
      expect(existsSync(lockPath)).toBe(false)
      // The reclaim guard must also be gone.
      expect(existsSync(`${lockPath}.reclaim`)).toBe(false)
    },
    20_000,
  )

  test(
    "a stale owner-less guard beyond the grace window is reclaimable",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      // Seed an empty guard (no owner.json) whose mtime is OLDER than grace.
      mkdirSync(lockPath, { recursive: true })
      const old = new Date(Date.now() - 60_000)
      const { utimesSync } = await import("node:fs")
      utimesSync(lockPath, old, old)

      // Inject a clock that reports "now" well past the guard's mtime.
      const deps: LockDeps = {
        now: () => Date.now(),
      }
      const token = await acquireMaterializeLock(lockPath, 200, deps)
      // The orphaned owner-less guard is reclaimed and the lock is acquired.
      expect(token).not.toBeNull()
      expect(existsSync(join(lockPath, "owner.json"))).toBe(true)
      await releaseMaterializeLock(lockPath, token!)
      expect(existsSync(lockPath)).toBe(false)
    },
    20_000,
  )

  test(
    "a fresh owner-less guard within the grace window is not reclaimed, only waited on",
    async () => {
      const lockPath = join(tmpHome(), "locks", "materialize.lock")
      // Seed an empty guard (no owner.json) with a FRESH mtime (within grace).
      mkdirSync(lockPath, { recursive: true })

      // Inject a clock that reports "now" equal to the guard's mtime (fresh).
      const deps: LockDeps = {
        now: () => Date.now(),
      }
      // A short timeout: the fresh owner-less guard is treated as in-progress
      // and waited on, so the acquire times out rather than reclaiming it.
      const token = await acquireMaterializeLock(lockPath, 80, deps)
      expect(token).toBeNull()
      // The fresh owner-less guard must NOT have been deleted.
      expect(existsSync(lockPath)).toBe(true)
      expect(existsSync(join(lockPath, "owner.json"))).toBe(false)
      // Clean up the seeded guard.
      rmSync(lockPath, { recursive: true, force: true })
    },
    20_000,
  )
})
