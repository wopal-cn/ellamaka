import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireHomeLock, releaseHomeLock } from "./home-lock"

const dirs: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-home-lock-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Seed a reader lease directory as if a process had published it. */
function seedReader(readersPath: string, name: string, pid: number): string {
  const tokenPath = join(readersPath, name)
  mkdirSync(tokenPath, { recursive: true })
  writeFileSync(join(tokenPath, "owner.json"), JSON.stringify({ pid, time: Date.now(), id: "seeded" }))
  return tokenPath
}

describe("home shared/exclusive lock — dead reader reaping", () => {
  test("a shared acquire reaps a reader lease left by a dead process", async () => {
    const lockPath = join(tmpHome(), "dsh", "state", "home.lock")
    const readersPath = join(lockPath, "shared")
    const deadLease = seedReader(readersPath, "999999999-0-dead", 999999999)

    const token = await acquireHomeLock(lockPath, "shared", 500)
    expect(token?.mode).toBe("shared")
    expect(existsSync(deadLease)).toBe(false)
    if (token) await releaseHomeLock(lockPath, token)
    expect(existsSync(join(readersPath, token!.tokenPath.split("/").pop()!))).toBe(false)
  })

  test("a shared acquire never reaps a lease held by a live process", async () => {
    const lockPath = join(tmpHome(), "dsh", "state", "home.lock")
    const readersPath = join(lockPath, "shared")
    const liveLease = seedReader(readersPath, `live-${Date.now()}`, process.pid)

    const token = await acquireHomeLock(lockPath, "shared", 500)
    expect(token?.mode).toBe("shared")
    expect(existsSync(liveLease)).toBe(true)
    if (token) await releaseHomeLock(lockPath, token)
  })
})
