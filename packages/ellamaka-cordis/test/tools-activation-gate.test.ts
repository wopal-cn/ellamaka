import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import {
  assertDshActivationComplete,
  bootDshTools,
  bootDshWeb,
  mountDshTools,
  verifyDshToolsRegistered,
} from "../src/dsh-web"
import { profileCapabilityPatches } from "../src/plugins/profile-capabilities"
import { prepareDshProfiles } from "./fixture/prepare-dsh-profiles"

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-activation-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Insert a user plugin row that can never activate: the bundle package does
 * not exist, so the loader import fails and the entry stays inactive.
 * User patches live in the harness-home profile area (`<home>/home/profiles/
 * <profile>/cordis.patch.yml`), NOT the territory-root profiles directory.
 */
function seedBrokenUserPlugin(profile: "ellamaka-tools" | "web"): (home: string) => void {
  return (home: string) => {
    const profileDir = join(home, "home", "profiles", profile)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, "cordis.patch.yml"),
      ["- insert:", "    - id: broken-user-plugin", "      name: no-such-dsh-plugin-package", ""].join("\n"),
    )
  }
}

/**
 * A plugin that imports cleanly but can never activate: its Cordis `inject`
 * names a service nothing provides. Keep the service provider resolvable but
 * inert so the Loader records the settled outcome as pending (with the missing
 * service name) instead of a failed import.
 */
function seedPendingUserPlugin(profile: "ellamaka-tools" | "web"): (home: string) => void {
  return (home: string) => {
    const profileDir = join(home, "home", "profiles", profile)
    const pluginDir = join(profileDir, "node_modules", "pending-user-plugin")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "pending-user-plugin", version: "1.0.0", type: "module", main: "index.js" }),
    )
    writeFileSync(join(pluginDir, "index.js"), "export const inject = ['missingService']\nexport function apply() {}\n")
    writeFileSync(
      join(profileDir, "cordis.patch.yml"),
      [
        "- insert:",
        "    - id: pending-user-plugin",
        "      name: pending-user-plugin",
        "    - id: late-service-provider",
        "      name: '@deepseek-ai/dsh-llm'",
        "",
      ].join("\n"),
    )
  }
}

/**
 * Simulate a future dsh-base split: `working-directory` is a NEW base provider
 * absent from rc.2's real bundle (this is a forward-compatibility fixture,
 * not a claim that the current container loads it). Its service name is
 * synthetic too; only the relationship matters — an adopted tool declares
 * the dependency and the provider must survive the host's pruning.
 */
function syntheticWorkingDirectoryRows() {
  return [
    { id: "tools", name: "@deepseek-ai/dsh-tools" },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" },
    { id: "working-directory", name: "@deepseek-ai/dsh-working-directory" },
    { id: "unadopted-upstream-row", name: "@deepseek-ai/dsh-unadopted-upstream-row" },
  ]
}

/**
 * Test seam for a package that does not exist in rc.2. The real resolver
 * loads module exports; production keeps that single path, while this fixture
 * supplies only the declarations the synthetic packages would publish.
 */
function syntheticServices(name: string) {
  if (name === "@deepseek-ai/dsh-tool-bash") return { requires: ["workingDirectory"], provides: [] }
  if (name === "@deepseek-ai/dsh-working-directory") return { requires: [], provides: ["workingDirectory"] }
  return undefined
}

describe("tools provider adoption closure", () => {
  test("keeps a newly split base provider required by an adopted tool", () => {
    const rows = syntheticWorkingDirectoryRows()
    const patches = profileCapabilityPatches("ellamaka-tools", rows, false, syntheticServices)
    const disabled = new Set(patches.filter((patch) => patch.disabled === true).map((patch) => patch.id))
    expect(disabled.has("working-directory")).toBe(false)
    expect(disabled.has("unadopted-upstream-row")).toBe(true)
  })

  test("keeps the adopted service closure free of Session lifecycle", () => {
    const rows = [
      { id: "tools", name: "@deepseek-ai/dsh-tools" },
      { id: "session-projection", name: "@deepseek-ai/dsh-session-projection" },
      { id: "sandbox-policy", name: "@deepseek-ai/dsh-sandbox-policy" },
      { id: "session", name: "@deepseek-ai/dsh-session" },
      { id: "agent", name: "@deepseek-ai/dsh-agent" },
    ]
    const patches = profileCapabilityPatches("ellamaka-tools", rows, false)
    const disabled = new Set(patches.filter((patch) => patch.disabled === true).map((patch) => patch.id))
    expect(disabled.has("session-projection")).toBe(false)
    expect(disabled.has("sandbox-policy")).toBe(false)
    expect(disabled.has("session")).toBe(true)
    expect(disabled.has("agent")).toBe(true)
  })
})

describe("tools container activation gate", () => {
  test("rejects a tools registry missing any required platform tool", () => {
    const lookup = (name: string) =>
      name === "tools"
        ? {
            schemas: () => [
              { name: "read" },
              { name: "write" },
              { name: "edit" },
              { name: "glob" },
              { name: "grep" },
              { name: process.platform === "win32" ? "pwsh" : "bash" },
            ],
          }
        : undefined
    expect(() => verifyDshToolsRegistered(lookup)).toThrow(/str_replace_editor/)
  })

  test("bootDshTools fails closed when a plugin entry does not activate", async () => {
    const home = tempHome()
    prepareDshProfiles(home)
    seedBrokenUserPlugin("ellamaka-tools")(home)
    let error: unknown
    try {
      await bootDshTools({ home, port: 0 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : String(error)).toContain("broken-user-plugin")
  }, 120_000)

  test("HMR replay fails closed when an adopted plugin stays pending", async () => {
    const root = tempHome()
    const ctx = new Context()
    prepareDshProfiles(root)
    const host = await mountDshTools(ctx, { home: root, port: 0, disablePtcRuntime: true })
    try {
      const hmr = ctx.get("hmr") as unknown
      if (
        typeof hmr !== "object" ||
        hmr === null ||
        !("runExclusive" in hmr) ||
        typeof hmr.runExclusive !== "function"
      ) {
        throw new Error("tools container did not provide the HMR transaction service")
      }
      const { composeFullPatchStack, readUserPatchLayer } = await import("../src/plugins/compose")
      const { createPackageDshRuntimeApi } = await import("../src/runtime/loader")
      const runtime = createPackageDshRuntimeApi()
      seedPendingUserPlugin("ellamaka-tools")(root)
      const patches = composeFullPatchStack({
        ...host.stackContext,
        userPatches: readUserPatchLayer(root, "ellamaka-tools"),
      })
      // Exactly the HMR post-apply chain: apply the current composition, then
      // run the fail-closed validator. The previous config is restored
      // explicitly on failure, mirroring bun-hmr's transactional rollback.
      let error: unknown
      try {
        const entry = host.includeEntry as unknown
        if (typeof entry !== "object" || entry === null || !("update" in entry) || typeof entry.update !== "function") {
          throw new Error("tools container did not expose an updatable root include")
        }
        const previous =
          "options" in entry &&
          typeof entry.options === "object" &&
          entry.options !== null &&
          "config" in entry.options &&
          typeof entry.options.config === "object"
            ? entry.options.config
            : {}
        await hmr.runExclusive(async () => {
          const { patches: _previous, ...rest } = previous ?? {}
          try {
            await entry.update({ config: { ...rest, patches } })
            await assertDshActivationComplete(runtime, ctx, "ellamaka-tools")
          } finally {
            await entry.update({ config: previous ?? {} })
          }
        })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : String(error)).toContain("pending-user-plugin")
      void patches
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 120_000)

  test("bootDshWeb keeps the optional-entry audit behavior (warn, not throw)", async () => {
    const home = tempHome()
    prepareDshProfiles(home)
    seedBrokenUserPlugin("web")(home)
    const web = await bootDshWeb({ home, port: 4097, disablePtcRuntime: true })
    expect(web.includeEntry).toBeDefined()
    await web.dispose()
  }, 120_000)
})
