import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { bootDshWeb, bootDshTools, type DshWebHost, type DshToolsHost } from "../src/dsh-web"
import { startDshPluginService, type DshPluginServiceHandle } from "../src/plugins/runtime"
import { withProfileManifestWrite, appendBundle } from "../src/plugins/profile-manifest"
import { profileDirOf } from "../src/plugins/compose"

const FIXTURE_PLUGIN = join(import.meta.dir, "fixtures", "fixture-dsh-plugin")
const MARKER = "fixture-dsh-plugin.marker"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-plugins-runtime-"))
}

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

async function teardown(hosts: Array<{ dispose(): Promise<void> }>, home: string): Promise<void> {
  for (const host of hosts) {
    try {
      await host.dispose()
    } catch {
      // Teardown is best-effort.
    }
  }
  rmSync(home, { recursive: true, force: true })
}

/**
 * Install the fixture plugin into BOTH profiles' manifests + node_modules.
 * Order mirrors the installer contract: the ENTITY lands first, the MANIFEST
 * declaration last — the manifest change is the trigger event, so a replay
 * never observes a half-copied entity.
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
    const home = tempRoot()
    const web = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })
    const tools = await bootDshTools({ home, port: 0 })
    let updates = 0
    const replayErrors: string[] = []
    const service = startDshPluginService({ home, containers: [webContainer(web), toolsContainer(tools)], onReplay: () => updates++, onReplayError: (profile, error) => replayErrors.push(`${profile}: ${error}`) })
    try {
      // CLI-side semantics: a pure disk operation on the composition files.
      await installFixture(home)
      await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))
      await waitForWithRetry(() => marker(tools.ctx), "mounted", () => installFixture(home))
      expect(updates).toBeGreaterThanOrEqual(2)
    } finally {
      await service.stop()
      await teardown([web, tools], home)
    }
  }, 90_000)

  test("a compose failure keeps the last good state and the NEXT real change recovers (no retry storm)", async () => {
    const home = tempRoot()
    const web = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })
    const tools = await bootDshTools({ home, port: 0 })
    const errors: Array<{ profile: string; error: unknown }> = []
    let updates = 0
    const service = startDshPluginService({
      home,
      containers: [webContainer(web), toolsContainer(tools)],
      onReplay: () => updates++,
      onReplayError: (profile, error) => errors.push({ profile, error }),
    })
    try {
      await installFixture(home)
      await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))
      const settled = updates

      // Break the composition: a manifest bundle row whose package entity is
      // gone fails the recomposition loud (compose fail-loud semantics).
      rmSync(join(profileDirOf(home, "web"), "node_modules", "fixture-dsh-plugin", "package.json"))
      await withProfileManifestWrite(profileDirOf(home, "web"), (raw) => {
        const dsh = (raw.dsh ??= {}) as Record<string, unknown>
        const profileSection = (dsh.profile ??= {}) as Record<string, unknown>
        profileSection.bundles = [...((profileSection.bundles ?? []) as string[]), "phantom-broken-plugin"]
      })
      // The watcher fires (real change) and the replay FAILS.
      await waitForCount(() => errors.length, 1)
      // The last good state stays mounted despite the failure.
      expect(marker(webCtxOf(web))).toBe("mounted")

      // No retry storm: the failed hash is KEPT, so without further real
      // changes nothing NEW fires. Converge on stability (the exact number
      // of successful replays varies with the multi-profile write fan-out).
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const errorsAfterQuiet = errors.length
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
    } finally {
      await service.stop()
      await teardown([web, tools], home)
    }
  }, 90_000)

  test("disabling a plugin in one profile leaves the other mounted", async () => {
    const home = tempRoot()
    const web = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })
    const tools = await bootDshTools({ home, port: 0 })
    const service = startDshPluginService({ home, containers: [webContainer(web), toolsContainer(tools)] })
    try {
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
    } finally {
      await service.stop()
      await teardown([web, tools], home)
    }
  }, 90_000)

  test("a replay update carries the FULL patch stack (official layers intact)", async () => {
    const home = tempRoot()
    const web = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })
    const tools = await bootDshTools({ home, port: 0 })
    const service = startDshPluginService({ home, containers: [webContainer(web), toolsContainer(tools)] })
    try {
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
    } finally {
      await service.stop()
      await teardown([web, tools], home)
    }
  }, 90_000)

  test("a user-layer disable row unmounts the plugin and REMOVING it hot-recovers (fresh file read)", async () => {
    // The user patch layer (cordis.patch.yml) is the enable/disable surface.
    // The replay must read the CURRENT file bytes, not the boot snapshot —
    // a stale snapshot re-applies rows the user removed (live regression:
    // disable worked, enable never recovered the fiber).
    const home = tempRoot()
    const web = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })
    const tools = await bootDshTools({ home, port: 0 })
    const service = startDshPluginService({ home, containers: [webContainer(web), toolsContainer(tools)] })
    const patchPath = join(profileDirOf(home, "web"), "cordis.patch.yml")
    const disableRow = () => writeFileSync(patchPath, "- id: dsh-plugin:fixture-dsh-plugin\n  disabled: true\n")
    const clearRows = () => writeFileSync(patchPath, "[]\n")
    try {
      await installFixture(home)
      await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))

      // Disable via the user patch layer: the loader disposes the fiber.
      disableRow()
      await waitForWithRetry(() => marker(webCtxOf(web)), undefined, disableRow)
      // The tools profile has no disable row — it stays mounted.
      expect(marker(tools.ctx)).toBe("mounted")

      // Enable = removing the row: the loader must restart the fiber.
      clearRows()
      await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", clearRows)
    } finally {
      await service.stop()
      await teardown([web, tools], home)
    }
  }, 90_000)

  test("stop() is idempotent and settles in-flight replays", async () => {
    const home = tempRoot()
    const web = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })
    const tools = await bootDshTools({ home, port: 0 })
    const service = startDshPluginService({ home, containers: [webContainer(web), toolsContainer(tools)] })
    try {
      await service.stop()
      await service.stop()
      await service.stop()
      // Disk operations after stop never touch the containers.
      await installFixture(home)
      await new Promise((resolve) => setTimeout(resolve, 800))
      expect(marker(webCtxOf(web))).toBeUndefined()
      expect(marker(tools.ctx)).toBeUndefined()
    } finally {
      await teardown([web, tools], home)
    }
  }, 90_000)

  test("an unchanged composition short-circuits (no further include updates)", async () => {
    const home = tempRoot()
    const web = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })
    const tools = await bootDshTools({ home, port: 0 })
    let updates = 0
    const service = startDshPluginService({ home, containers: [webContainer(web), toolsContainer(tools)], onReplay: () => updates++ })
    try {
      await installFixture(home)
      await waitForWithRetry(() => marker(webCtxOf(web)), "mounted", () => installFixture(home))
      await waitForWithRetry(() => marker(tools.ctx), "mounted", () => installFixture(home))
      const settled = updates
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect(updates).toBe(settled)
    } finally {
      await service.stop()
      await teardown([web, tools], home)
    }
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
