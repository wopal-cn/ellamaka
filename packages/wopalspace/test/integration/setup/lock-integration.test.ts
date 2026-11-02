import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileLockTimeoutError, withFileLock } from "../../../src/setup/lock"

function temporaryTarget(): { readonly dir: string; readonly target: string } {
  const dir = mkdtempSync(join(tmpdir(), "wopal-setup-lock-"))
  return { dir, target: join(dir, "credentials.json") }
}

describe("setup file lock", () => {
  test("serialises a read-modify-write and removes its own lock afterwards", () => {
    const { dir, target } = temporaryTarget()
    try {
      const ordered: string[] = []
      withFileLock(target, () => {
        ordered.push("first:start")
        writeFileSync(target, "1")
        ordered.push("first:end")
      })
      withFileLock(target, () => {
        ordered.push("second:start")
        writeFileSync(target, readFileSync(target, "utf8") + "2")
        ordered.push("second:end")
      })

      expect(ordered).toEqual(["first:start", "first:end", "second:start", "second:end"])
      expect(readFileSync(target, "utf8")).toBe("12")
      expect(existsSync(target + ".lock")).toBe(false)
      expect(existsSync(target + ".lock.pending." + process.pid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an existing lock fails within the bound and is preserved for an operator", () => {
    const { dir, target } = temporaryTarget()
    try {
      const lock = target + ".lock"
      const foreign = JSON.stringify({ token: "other-owner", acquiredAt: 0 })
      writeFileSync(lock, foreign)

      const started = Date.now()
      let caught: unknown
      try {
        withFileLock(target, () => "unreachable", { timeoutMs: 60 })
      } catch (error) {
        caught = error
      }
      const elapsed = Date.now() - started

      expect(caught).toBeInstanceOf(FileLockTimeoutError)
      const timeout = caught instanceof FileLockTimeoutError ? caught : undefined
      expect(timeout?.code).toBe("SETUP_LOCK_BUSY")
      expect(timeout?.lockPath).toBe(lock)
      // Bounded, not a fixed sleep: it returns as soon as the bound expires.
      expect(elapsed).toBeGreaterThanOrEqual(50)
      expect(elapsed).toBeLessThan(5_000)
      // The foreign lock and the caller's data are untouched.
      expect(readFileSync(lock, "utf8")).toBe(foreign)
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a stale-looking lock is never taken over, even when it is old", () => {
    const { dir, target } = temporaryTarget()
    try {
      const lock = target + ".lock"
      // Abandoned for an hour: still preserved, because a takeover by age can
      // free the lock from under a live owner.
      const abandoned = JSON.stringify({ token: "crashed-owner", acquiredAt: Date.now() - 3_600_000 })
      writeFileSync(lock, abandoned)

      expect(() => withFileLock(target, () => "unreachable", { timeoutMs: 30 })).toThrow(FileLockTimeoutError)
      expect(readFileSync(lock, "utf8")).toBe(abandoned)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a lock replaced during the critical section is not deleted by the old holder", () => {
    const { dir, target } = temporaryTarget()
    try {
      const lock = target + ".lock"
      const replacement = JSON.stringify({ token: "replacement-owner", acquiredAt: 1 })
      withFileLock(target, () => {
        // Simulate an external replacement while this holder is working.
        rmSync(lock, { force: true })
        writeFileSync(lock, replacement)
      })
      expect(readFileSync(lock, "utf8")).toBe(replacement)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failing operation still releases its own lock", () => {
    const { dir, target } = temporaryTarget()
    try {
      expect(() =>
        withFileLock(target, () => {
          throw new Error("business failure")
        }),
      ).toThrow("business failure")
      expect(existsSync(target + ".lock")).toBe(false)

      // The path is usable again right away.
      expect(withFileLock(target, () => "ok")).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
