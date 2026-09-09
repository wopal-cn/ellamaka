import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootDshWeb, bootDshTools, type DshWebHost, type DshToolsHost } from "../src/dsh-web"
import { startDshPluginService, type DshPluginServiceHandle } from "../src/plugins/runtime"
import { withProfileManifestWrite, appendBundle } from "../src/plugins/profile-manifest"
import { profileDirOf } from "../src/plugins/compose"

const FIXTURE_PLUGIN = join(import.meta.dir, "fixtures", "fixture-dsh-plugin")
const MARKER = "fixture-dsh-plugin.marker"

/**
 * Shared suite environment: ONE temp home, ONE pair of containers (web +
 * ellamaka-tools) and ONE plugin service reused by all 8 cases. Booting the
 * heavy tool container dominates this file's cost, and every case drives the
 * SAME service through a different lifecycle phase, so the suite runs as an
 * ordered chain over shared state instead of re-booting the containers 8
 * times (8 boots -> 1 boot).
 *
 * The cases deliberately consume and settle the state their predecessors
 * left behind (each body documents its chain contract); bun executes a
 * file's tests strictly sequentially, so the chain is deterministic.
 */
let home: string
let web: DshWebHost
let tools: DshToolsHost
let service: DshPluginServiceHandle
/** Successful service replays observed since suite start. */
let updates: number
/** Failed service replays observed since suite start, with the profile. */
let replayErrors: Array<{ profile: string; error: unknown }>

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "dsh-plugins-runtime-"))
  // The two boots touch the same fresh home but reconcile idempotently (the
  // closure healer re-points symlinks at identical targets with an
  // EEXIST-tolerant write; the plugins healer finds no user profiles yet),
  // and each owns its own cordis context — so they boot concurrently.
  ;[web, tools] = await Promise.all([
    bootDshWeb({ home, port: 4097, disableCodeRuntime: true }),
    bootDshTools({ home, port: 0 }),
  ])
  updates = 0
  replayErrors = []
  service = startDshPluginService({
    home,
    containers: [webContainer(web), toolsContainer(tools)],
    onReplay: () => updates++,
    onReplayError: (profile, error) => replayErrors.push({ profile, error }),
  })
}, 120_000)

afterAll(async () => {
  // Collect every teardown failure (rook W-01): leaks or dispose errors must
  // surface as a suite-level failure, never vanish into a silent catch.
  const failures: unknown[] = []
  try {
    if (service) await service.stop()
  } catch (error) {
    failures.push(error)
  }
  const settled = await Promise.allSettled([web, tools].map((host) => host.dispose()))
  for (const outcome of settled) {
    if (outcome.status === "rejected") failures.push(outcome.reason)
  }
  try {
    if (home) rmSync(home, { recursive: true, force: true })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "dsh plugins-runtime suite teardown failed")
  }
}, 120_000)

/** The DshHost extension exposes the web container's ctx. */
function webCtxOf(web: DshWebHost): unknown {
  const ctx = (web as unknown as { ctx?: unknown }).ctx
  if (!ctx) throw new Error("web host did not expose ctx")
  return ctx
}

function marker(ctx: unknown): string | undefined {
  if (!ctx) return undefined
  return (ctx as { get(name: string, strict?: boolean): unknown }).get(MARKER, false) as string | undefined
}

/** Poll `probe` until it equals `want` (bun lacks expect.poll). */
async function waitFor(probe: () => string | undefined, want: string | undefined, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (probe() === want) return
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${JSON.stringify(want)}) timed out; last value: ${JSON.stringify(probe())}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Poll a counter until it reaches `want`. */
async function waitForCount(probe: () => number, want: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (probe() >= want) return
    if (Date.now() > deadline) throw new Error(`waitForCount(${want}) timed out; last: ${probe()}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Wait for `probe()` to equal `want`, retrying `touch` while it does not.
 * Under FSEvents a watcher can miss a single event while several watchers
 * observe the same files; the composition write is idempotent, so re-writing
 * it re-arms the watch without changing the outcome.
 */
async function waitForWithRetry(
  probe: () => string | undefined,
  want: string | undefined,
  touch: () => Promise<void>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (probe() === want) return
    if (Date.now() > deadline) {
      throw new Error(`waitForWithRetry(${JSON.stringify(want)}) timed out; last: ${JSON.stringify(probe())}`)
    }
    await touch()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/**
 * Install the fixture plugin into BOTH profiles' manifests + node_modules.
 * Order mirrors the installer contract: the ENTITY lands first, the MANIFEST
 * declaration last — the manifest change is the trigger event, so a replay
 * never observes a half-copied entity.
 *
 * Idempotent: `appendBundle` dedupes the bundle row and the entity copy is
 * replace-by-rewrite, so re-installing an installed fixture rewrites the
 * watched files with IDENTICAL content — the service hashes content (not
 * mtime) and short-circuits. This is what lets a chained case re-assert its
 * install baseline without perturbing the shared replay counters.
 */
async function installFixture(home: string): Promise<void> {
  for (const profile of ["web", "ellamaka-tools"]) {
    const profileDir = profileDirOf(home, profile)
    mkdirSync(join(profileDir, "node_modules"), { recursive: true })
    rmSync(join(profileDir, "node_modules", "fixture-dsh-plugin"), { recursive: true, force: true })
    cpSync(FIXTURE_PLUGIN, join(profileDir, "node_modules", "fixture-dsh-plugin"), { recursive: true })
    await withProfileManifestWrite(profileDir, (manifest) => {
      appendBundle(manifest, "fixture-dsh-plugin")
    })
  }
}

/** Remove the fixture from both profiles (entity + manifest row). */
async function uninstallFixture(home: string): Promise<void> {
  for (const profile of ["web", "ellamaka-tools"]) {
    const profileDir = profileDirOf(home, profile)
    rmSync(join(profileDir, "node_modules", "fixture-dsh-plugin"), { recursive: true, force: true })
    await withProfileManifestWrite(profileDir, (raw) => {
      const dsh = (raw.dsh ??= {}) as Record<string, unknown>
      const profileSection = (dsh.profile ??= {}) as Record<string, unknown>
      const bundles = (profileSection.bundles ??= []) as string[]
      const index = bundles.indexOf("fixture-dsh-plugin")
      if (index !== -1) bundles.splice(index, 1)
    })
  }
}

describe("dsh plugin runtime service (profile composition files, event driven)", () => {
  test("installing a plugin while containers run hot-mounts it into both", async () => {
    // Chain contract: entry = empty composition + idle service; exit =
    // fixture installed and mounted on BOTH containers, watcher settled.
    // CLI-side semantics: a pure disk operation on the composition files.
    await installFixture(home)
    await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))
    await waitForWithRetry(() => marker(tools.ctx), "mounted", () => installFixture(home))
    expect(updates).toBeGreaterThanOrEqual(2)
  }, 90_000)

  test("the host activation request replays once and absorbs the watcher event", async () => {
    // Chain contract: entry = fixture mounted everywhere and hash-adopted
    // (case 1). The explicit-ack semantics need a REAL composition change
    // to adopt, so revert to the empty composition first (the explicit
    // replay settles the unmount deterministically — no watcher race),
    // then install and IMMEDIATELY request the host replay, mirroring the
    // original install->replay race against the watcher echo. The shared
    // replay counter is compared as a delta: one full replay = one update
    // per container.
    await uninstallFixture(home)
    await service.replay()
    const updatesBefore = updates
    await installFixture(home)
    const result = await service.replay()
    expect(result).toEqual({ ok: true })
    expect(marker(webCtxOf(web))).toBe("mounted")
    expect(marker(tools.ctx)).toBe("mounted")

    // The composition-file watcher receives the same write after the
    // explicit market acknowledgement. It observes the adopted hash and
    // must not activate either container a second time.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(updates - updatesBefore).toBe(2)
  }, 90_000)

  test("a compose failure keeps the last good state and the NEXT real change recovers (no retry storm)", async () => {
    // Chain contract: entry = fixture mounted everywhere (cases 1-2); exit =
    // composition emptied (fixture uninstalled), service alive and settled.
    await installFixture(home)
    await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))

    // Break the composition: a manifest bundle row whose package entity is
    // gone fails the recomposition loud (compose fail-loud semantics).
    rmSync(join(profileDirOf(home, "web"), "node_modules", "fixture-dsh-plugin", "package.json"))
    await withProfileManifestWrite(profileDirOf(home, "web"), (raw) => {
      const dsh = (raw.dsh ??= {}) as Record<string, unknown>
      const profileSection = (dsh.profile ??= {}) as Record<string, unknown>
      profileSection.bundles = [...((profileSection.bundles ?? []) as string[]), "phantom-broken-plugin"]
    })
    // The watcher fires (real change) and the replay FAILS.
    await waitForCount(() => replayErrors.length, 1)
    // The last good state stays mounted despite the failure.
    expect(marker(webCtxOf(web))).toBe("mounted")

    // No retry storm: the failed hash is KEPT, so without further real
    // changes nothing NEW fires. Converge on stability (the exact number
    // of successful replays varies with the multi-profile write fan-out).
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const errorsAfterQuiet = replayErrors.length
    const updatesAfterQuiet = updates
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(updates).toBe(updatesAfterQuiet) // quiet = no retry storm
    expect(errorsAfterQuiet).toBeGreaterThanOrEqual(1) // the break was observed

    // Recovery: the next REAL change replays and the good state persists.
    await uninstallFixture(home)
    // Clear the phantom row: the next real change recomposes successfully
    // and unmounts the fixture from web (the composition is now empty).
    await withProfileManifestWrite(profileDirOf(home, "web"), (raw) => {
      const dsh = (raw.dsh ??= {}) as Record<string, unknown>
      const profileSection = (dsh.profile ??= {}) as Record<string, unknown>
      profileSection.bundles = ((profileSection.bundles ?? []) as string[]).filter((b) => b !== "phantom-broken-plugin")
    })
    await waitFor(() => marker(webCtxOf(web)), undefined)
    // The service survived the whole cycle: both containers settled at the
    // emptied composition (uninstallFixture cleared both profiles).
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(marker(tools.ctx)).toBeUndefined()
  }, 90_000)

  test("disabling a plugin in one profile leaves the other mounted", async () => {
    // Chain contract: entry = empty composition (case 3's recovery);
    // exit = fixture remounted on tools, web's manifest row removed and web
    // unmounted (case 5 rebuilds its own web baseline).
    await installFixture(home)
    await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))
    await waitForWithRetry(() => marker(tools.ctx), "mounted", () => installFixture(home))

    // Remove the manifest bundle row for WEB only (disable semantics).
    const removeRow = () =>
      withProfileManifestWrite(profileDirOf(home, "web"), (raw) => {
        const dsh = (raw.dsh ??= {}) as Record<string, unknown>
        const profileSection = (dsh.profile ??= {}) as Record<string, unknown>
        profileSection.bundles = ((profileSection.bundles ?? []) as string[]).filter((b) => b !== "fixture-dsh-plugin")
      })
    await removeRow()
    await waitForWithRetry(() => marker(webCtxOf(web)), undefined, removeRow)
    expect(marker(tools.ctx)).toBe("mounted")
  }, 90_000)

  test("a replay update carries the FULL patch stack (official layers intact)", async () => {
    // Chain contract: entry = web's manifest row removed by case 4; rebuild
    // the web install baseline (real change -> replay) so the include entry
    // carries the fixture row again, then inspect the stack.
    await installFixture(home)
    await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))
    // The include config still carries the FULL stack after a replay:
    // official bundle rows (bare names) AND the Bridge-composed plugin row
    // (explicit dsh-plugin: id, resolved to an absolute file:// URL).
    const config = (web.includeEntry as unknown as {
      options?: { config?: { patches?: { insert?: { id?: string; name?: string }[] }[] } }
    }).options?.config
    const insertRows = (config?.patches ?? []).flatMap((row) => row?.insert ?? [])
    expect(insertRows.some((row) => typeof row?.name === "string" && row.name.startsWith("@deepseek-ai/"))).toBe(true)
    const fixtureRow = insertRows.find((row) => row?.id === "dsh-plugin:fixture-dsh-plugin")
    expect(fixtureRow).toBeDefined()
    expect(fixtureRow!.name!.startsWith("file://")).toBe(true)
  }, 90_000)

  test("a user-layer disable row unmounts the plugin and REMOVING it hot-recovers (fresh file read)", async () => {
    // Chain contract: entry = fixture mounted on BOTH containers (case 5
    // restored web's row); exit = fixture mounted on both, patch file
    // cleared. The user patch layer (cordis.patch.yml) is the enable/disable
    // surface. The replay must read the CURRENT file bytes, not the boot
    // snapshot — a stale snapshot re-applies rows the user removed (live
    // regression: disable worked, enable never recovered the fiber).
    const patchPath = join(profileDirOf(home, "web"), "cordis.patch.yml")
    const disableRow = () => writeFileSync(patchPath, "- id: dsh-plugin:fixture-dsh-plugin\n  disabled: true\n")
    const clearRows = () => writeFileSync(patchPath, "[]\n")
    await installFixture(home)
    await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))
    // The tools profile has no disable row — it stays mounted.
    expect(marker(tools.ctx)).toBe("mounted")

    // Disable via the user patch layer: the loader disposes the fiber.
    disableRow()
    await waitForWithRetry(() => marker(webCtxOf(web)), undefined, disableRow)
    // The tools profile has no disable row — it stays mounted.
    expect(marker(tools.ctx)).toBe("mounted")

    // Enable = removing the row: the loader must restart the fiber.
    clearRows()
    await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", clearRows)
  }, 90_000)

  test("an unchanged composition short-circuits (no further include updates)", async () => {
    // Chain contract: entry = settled mounted state (case 6), no pending
    // writes; the shared counters must not move without a real change.
    const settled = updates
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(updates).toBe(settled)
  }, 90_000)

  test("stop() is idempotent and settles in-flight replays", async () => {
    // Chain contract: entry = running service with the fixture mounted
    // everywhere (cases 1-7). Uninstall first and settle the unmount with an
    // explicit replay so the containers sit at an empty composition before
    // stop — the original case's post-stop assertions (markers undefined,
    // disk writes isolated) are preserved: disk operations after stop never
    // touch the containers.
    await uninstallFixture(home)
    await service.replay()
    await service.stop()
    await service.stop()
    await service.stop()
    // Disk operations after stop never touch the containers.
    await installFixture(home)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(marker(webCtxOf(web))).toBeUndefined()
    expect(marker(tools.ctx)).toBeUndefined()
  }, 90_000)
})

/** Containers wiring helpers (the mounted hosts carry profile + handles). */
function webContainer(web: DshWebHost) {
  return {
    profile: "web",
    ctx: webCtxOf(web),
    includeEntry: web.includeEntry,
    stackContext: web.stackContext,
  }
}

function toolsContainer(tools: DshToolsHost) {
  return {
    profile: "ellamaka-tools",
    ctx: tools.ctx,
    includeEntry: tools.includeEntry,
    stackContext: tools.stackContext,
  }
}

// Type-only silence.
export type { DshPluginServiceHandle }
