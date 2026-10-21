import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { createPackageDshRuntimeApi } from "../src/runtime/loader"
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

function syntheticRows() {
  return [
    { id: "tools", name: "@deepseek-ai/dsh-tools" },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" },
    { id: "working-directory", name: "@deepseek-ai/dsh-working-directory" },
    { id: "unadopted-upstream-row", name: "@deepseek-ai/dsh-unadopted-upstream-row" },
  ]
}

function syntheticServices(name: string) {
  if (name === "@deepseek-ai/dsh-tool-bash") return { requires: ["workingDirectory"], provides: [] }
  if (name === "@deepseek-ai/dsh-working-directory") return { requires: [], provides: ["workingDirectory"] }
  return undefined
}

describe("tools provider adoption closure", () => {
  test("keeps a newly split base provider required by an adopted tool", () => {
    const patches = profileCapabilityPatches("ellamaka-tools", syntheticRows(), false, {
      inspect: syntheticServices,
    })
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
    const patches = profileCapabilityPatches("ellamaka-tools", rows, false, {
      installAnchor: require.resolve("@deepseek-ai/dsh/package.json"),
    })
    const disabled = new Set(patches.filter((patch) => patch.disabled === true).map((patch) => patch.id))
    expect(disabled.has("session-projection")).toBe(false)
    expect(disabled.has("sandbox-policy")).toBe(false)
    expect(disabled.has("session")).toBe(true)
    expect(disabled.has("agent")).toBe(true)
  })

  test("resolves a real service edge from the install anchor, not the fallback floor", () => {
    const rows = [
      { id: "tools", name: "@deepseek-ai/dsh-tools" },
      { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" },
      { id: "shell-env", name: "@deepseek-ai/dsh-shell-env" },
    ]
    const patches = profileCapabilityPatches("ellamaka-tools", rows, false, {
      installAnchor: require.resolve("@deepseek-ai/dsh/package.json"),
    })
    const disabled = new Set(patches.filter((patch) => patch.disabled === true).map((patch) => patch.id))
    expect(disabled.has("tool-bash")).toBe(false)
    expect(disabled.has("shell-env")).toBe(false)
  })

  test("fails loudly when the install anchor cannot resolve a declared package", () => {
    expect(() =>
      profileCapabilityPatches("ellamaka-tools", [{ id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash" }], false, {
        installAnchor: join(tempHome(), "missing-dsh", "package.json"),
      }),
    ).toThrow(/install anchor|resolve/)
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
    // A real module that imports cleanly but can never activate: its Cordis
    // `inject` names a service nothing provides, so Loader settles it as
    // pending with that service in the diagnostic.
    const pluginDir = join(root, "home", "profiles", "ellamaka-tools", "node_modules", "pending-user-plugin")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "pending-user-plugin", version: "1.0.0", type: "module", main: "index.js" }),
    )
    writeFileSync(join(pluginDir, "index.js"), "export const inject = ['missingService']\nexport function apply() {}\n")

    const host = await mountDshTools(ctx, { home: root, port: 0, disablePtcRuntime: true })
    try {
      // Model the state bun-hmr hands to `afterApply`: the mounted tree already
      // carries an entry that cannot activate because its `inject` service has
      // no provider. Previously `validate()` re-ran only the warning audit, so
      // this tree stayed "ready"; it must now fail closed with the entry and
      // the missing service in the diagnostic.
      const config = host.includeEntry.options?.config
      if (config === undefined) throw new Error("root include carries no config snapshot")
      await host.includeEntry.update({
        config: {
          ...config,
          patches: [
            {
              insert: [
                { id: "pending-user-plugin", name: "pending-user-plugin" },
                { id: "stale-service-provider", name: "@deepseek-ai/dsh-llm" },
              ],
            },
          ],
        },
      })
      // The pre-Plan behavior: the plain audit only WARNS about the inactive
      // tree and returns normally, which is why an HMR replay could leave the
      // container "ready" with a broken entry.
      const warnings: string[] = []
      await createPackageDshRuntimeApi().appBoot.auditStartupEntries(ctx, "ellamaka", (line: string) =>
        warnings.push(line),
      )
      expect(warnings.join("\n")).toContain("pending-user-plugin")

      // `assertDshActivationComplete` is what mountProfile registers as
      // bun-hmr's `afterApply` (see the `afterApply: validate` wiring): the
      // same tree must now fail closed instead of degrading silently.
      await expect(assertDshActivationComplete(createPackageDshRuntimeApi(), ctx, "ellamaka-tools")).rejects.toThrow(
        /container activation incomplete[\s\S]*pending-user-plugin/,
      )
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
