import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireDshHomeRuntimeAccess, prepareDshHome, readDshHomeState } from "./home-guard"
import { acquireHomeLock, releaseHomeLock } from "./home-lock"
import { resolveDshLayout } from "./status"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ellamaka-home-guard-"))
  roots.push(root)
  return root
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`)
    await Bun.sleep(10)
  }
}

function spawnLockWorker(lockPath: string, mode: "shared" | "exclusive", root: string, id: string) {
  const readyPath = path.join(root, `${id}.ready`)
  const releasePath = path.join(root, `${id}.release`)
  const worker = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "../../test/fixture/home-lock-worker.ts"),
      lockPath,
      mode,
      readyPath,
      releasePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  return { worker, readyPath, releasePath }
}

describe("Home shared/exclusive lock", () => {
  test("allows real same-version processes to coexist and blocks an exclusive switch", async () => {
    const wopalHome = await tempHome()
    const lockPath = resolveDshLayout(wopalHome).homeLockPath
    const first = spawnLockWorker(lockPath, "shared", wopalHome, "first")
    const second = spawnLockWorker(lockPath, "shared", wopalHome, "second")
    await Promise.all([waitForFile(first.readyPath), waitForFile(second.readyPath)])

    expect(await acquireHomeLock(lockPath, "exclusive", 80)).toBeNull()

    await Promise.all([fs.writeFile(first.releasePath, "release"), fs.writeFile(second.releasePath, "release")])
    expect(await first.worker.exited).toBe(0)
    expect(await second.worker.exited).toBe(0)

    const exclusive = await acquireHomeLock(lockPath, "exclusive", 500)
    expect(exclusive?.mode).toBe("exclusive")
    if (exclusive) await releaseHomeLock(lockPath, exclusive)
  })
})

describe("prepareDshHome", () => {
  test("records a fresh Home generation and managed marker before activation", async () => {
    const wopalHome = await tempHome()
    const result = await prepareDshHome({ wopalHome, closureVersion: 1 })
    expect(result).toEqual({ ok: true, homeVersion: 1, changed: true })
    expect(await readDshHomeState(wopalHome)).toEqual({
      kind: "managed",
      closureVersion: 1,
      marker: true,
      homeExists: false,
    })
  })

  test("same generation gets a separate shared runtime lease and an older runtime refuses a newer Home", async () => {
    const wopalHome = await tempHome()
    expect(await prepareDshHome({ wopalHome, closureVersion: 2 })).toEqual({
      ok: true,
      homeVersion: 2,
      changed: true,
    })

    const same = await acquireDshHomeRuntimeAccess({ wopalHome, closureVersion: 2 })
    expect(same).toMatchObject({ ok: true, homeVersion: 2 })
    if (same.ok) await same.lease.release()

    const older = await acquireDshHomeRuntimeAccess({ wopalHome, closureVersion: 1 })
    expect(older).toEqual({ ok: false, reason: "DSH_HOME_NEWER_THAN_RUNTIME", homeVersion: 2 })
  })

  test("a real running process makes version advance busy without backup or state changes", async () => {
    const wopalHome = await tempHome()
    expect((await prepareDshHome({ wopalHome, closureVersion: 1 })).ok).toBe(true)
    const layout = resolveDshLayout(wopalHome)
    const active = spawnLockWorker(layout.homeLockPath, "shared", wopalHome, "active")
    await waitForFile(active.readyPath)

    const newer = await prepareDshHome({ wopalHome, closureVersion: 2, lockTimeoutMs: 80 })
    expect(newer).toEqual({ ok: false, reason: "DSH_HOME_BUSY", homeVersion: 1 })
    expect(await readDshHomeState(wopalHome)).toMatchObject({ kind: "managed", closureVersion: 1 })
    expect(existsSync(layout.backupsDir)).toBe(false)

    await fs.writeFile(active.releasePath, "release")
    expect(await active.worker.exited).toBe(0)
  })

  test("backs up Home before atomically publishing a newer generation", async () => {
    const wopalHome = await tempHome()
    expect((await prepareDshHome({ wopalHome, closureVersion: 1 })).ok).toBe(true)
    const layout = resolveDshLayout(wopalHome)
    await fs.mkdir(layout.homeDir, { recursive: true })
    await fs.writeFile(path.join(layout.homeDir, "user-data.txt"), "keep-me")

    let sawBackupBeforeState = false
    const upgraded = await prepareDshHome({
      wopalHome,
      closureVersion: 2,
      deps: {
        beforeStatePublish: () => {
          sawBackupBeforeState = existsSync(layout.backupsDir)
        },
      },
    })
    expect(upgraded).toMatchObject({ ok: true, homeVersion: 2, changed: true })
    if (!upgraded.ok) return
    expect(sawBackupBeforeState).toBe(true)
    expect(upgraded.backupDir).toBeTruthy()
    expect(await fs.readFile(path.join(upgraded.backupDir!, "home", "user-data.txt"), "utf8")).toBe("keep-me")
    expect(JSON.parse(await fs.readFile(path.join(upgraded.backupDir!, "metadata.json"), "utf8"))).toMatchObject({
      closureVersion: 1,
      managed: true,
    })
    expect(await readDshHomeState(wopalHome)).toMatchObject({ kind: "managed", closureVersion: 2 })
  })

  test("a backup failure preserves the previous generation and grants no write access", async () => {
    const wopalHome = await tempHome()
    expect((await prepareDshHome({ wopalHome, closureVersion: 1 })).ok).toBe(true)
    const layout = resolveDshLayout(wopalHome)
    await fs.mkdir(layout.homeDir, { recursive: true })
    await fs.writeFile(path.join(layout.homeDir, "data"), "must-back-up")
    const failed = await prepareDshHome({
      wopalHome,
      closureVersion: 2,
      deps: {
        copyHome: () => {
          throw new Error("disk full")
        },
      },
    })
    expect(failed).toEqual({ ok: false, reason: "DSH_HOME_BACKUP_FAILED", homeVersion: 1 })
    expect(await readDshHomeState(wopalHome)).toMatchObject({ kind: "managed", closureVersion: 1 })
  })

  test("a state publication failure preserves the previous generation and grants no write access", async () => {
    const wopalHome = await tempHome()
    expect((await prepareDshHome({ wopalHome, closureVersion: 1 })).ok).toBe(true)
    const layout = resolveDshLayout(wopalHome)
    const failed = await prepareDshHome({
      wopalHome,
      closureVersion: 2,
      deps: {
        atomicWrite: (file, content, defaultWrite) => {
          if (file === layout.homeStateFile) throw new Error("read-only filesystem")
          defaultWrite(file, content)
        },
      },
    })
    expect(failed).toEqual({ ok: false, reason: "DSH_HOME_STATE_WRITE_FAILED", homeVersion: 1 })
    expect(await readDshHomeState(wopalHome)).toMatchObject({ kind: "managed", closureVersion: 1 })
    expect(existsSync(layout.backupsDir)).toBe(true)
  })

  test("unknown or corrupt metadata refuses Home writes", async () => {
    const wopalHome = await tempHome()
    const layout = resolveDshLayout(wopalHome)
    await fs.mkdir(layout.stateDir, { recursive: true })
    await fs.writeFile(layout.managedMarkerFile, "ellamaka-managed-v1\n")

    expect(await prepareDshHome({ wopalHome, closureVersion: 1 })).toEqual({
      ok: false,
      reason: "DSH_HOME_VERSION_UNKNOWN",
    })

    await fs.writeFile(layout.homeStateFile, "not-json")
    expect(await prepareDshHome({ wopalHome, closureVersion: 1 })).toEqual({
      ok: false,
      reason: "DSH_HOME_VERSION_UNKNOWN",
    })
  })

  test("a corrupt managed marker with valid state is unknown and never repaired implicitly", async () => {
    const wopalHome = await tempHome()
    const layout = resolveDshLayout(wopalHome)
    await fs.mkdir(layout.stateDir, { recursive: true })
    await fs.writeFile(layout.homeStateFile, '{"closureVersion":2}\n')
    await fs.writeFile(layout.managedMarkerFile, "corrupt-marker\n")

    expect(await prepareDshHome({ wopalHome, closureVersion: 2 })).toEqual({
      ok: false,
      reason: "DSH_HOME_VERSION_UNKNOWN",
    })
    expect(await fs.readFile(layout.managedMarkerFile, "utf8")).toBe("corrupt-marker\n")
  })

  test("repairs a missing marker from valid state without treating Home as legacy", async () => {
    const wopalHome = await tempHome()
    const layout = resolveDshLayout(wopalHome)
    await fs.mkdir(layout.stateDir, { recursive: true })
    await fs.writeFile(layout.homeStateFile, '{"closureVersion":3}\n')
    await fs.mkdir(layout.homeDir, { recursive: true })
    await fs.writeFile(path.join(layout.homeDir, "data"), "preserve")

    const repaired = await prepareDshHome({ wopalHome, closureVersion: 3 })
    expect(repaired).toEqual({ ok: true, homeVersion: 3, changed: true })
    expect(await fs.readFile(path.join(layout.homeDir, "data"), "utf8")).toBe("preserve")
    expect(await fs.readFile(layout.managedMarkerFile, "utf8")).toBe("ellamaka-managed-v1\n")
    expect(existsSync(layout.backupsDir)).toBe(false)
  })

  test("legacy Home requires explicit offline adoption confirmation, then backs up as unknown", async () => {
    const wopalHome = await tempHome()
    const layout = resolveDshLayout(wopalHome)
    await fs.mkdir(layout.homeDir, { recursive: true })
    await fs.writeFile(path.join(layout.homeDir, "legacy.txt"), "legacy")

    expect(await prepareDshHome({ wopalHome, closureVersion: 1 })).toEqual({
      ok: false,
      reason: "DSH_HOME_VERSION_UNKNOWN",
    })

    const adopted = await prepareDshHome({ wopalHome, closureVersion: 1, legacyAdoptionConfirmed: true })
    expect(adopted).toMatchObject({ ok: true, homeVersion: 1, changed: true })
    if (!adopted.ok) return
    expect(JSON.parse(await fs.readFile(path.join(adopted.backupDir!, "metadata.json"), "utf8"))).toEqual({
      closureVersion: null,
      managed: false,
    })
    expect(await fs.readFile(path.join(adopted.backupDir!, "home", "legacy.txt"), "utf8")).toBe("legacy")
  })
})
