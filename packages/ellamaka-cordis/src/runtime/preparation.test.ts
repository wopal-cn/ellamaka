import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireDshHomeRuntimeAccess, prepareDshHome } from "./home-guard"
import { resolveDshLayout } from "./status"
import { createDshPreparationContributors } from "./preparation"
import { inspectDshProfileResources } from "./profile-resources"
import { TOOLS_PROFILE_BLOCK } from "./tools-profile"
import { parseDocument } from "yaml"
import type { DshRuntimeManifestV1 } from "./manifest"

const dirs: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-preparation-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const MANIFEST: DshRuntimeManifestV1 = {
  schema: "ellamaka.dsh-runtime/v1",
  closureVersion: 1,
  bridgeAbi: 1,
  dependencies: {
    "@deepseek-ai/dsh": "0.1.1-rc.2",
    "@deepseek-ai/cordis": "4.0.1",
  },
  fingerprint: "sha256:9e1ee84dfdd992bf9ebb37c7506f13bc17b87158d02783c2b1b24fd25a32cda7",
}

function contributors(home: string, profiles: readonly ("web" | "ellamaka-tools")[] = ["web", "ellamaka-tools"]) {
  return createDshPreparationContributors({
    wopalHome: home,
    logFile: join(home, "logs", "dsh.log"),
    manifest: MANIFEST,
    closureVersion: MANIFEST.closureVersion,
    profiles,
  })
}

function context() {
  return {
    signal: new AbortController().signal,
    report: () => {},
  }
}

describe("DSH CorePreparation contributors", () => {
  test("reports managed Node through the existing closure progress step, never a new step", async () => {
    const home = tmpHome()
    expect(contributors(home).map((item) => item.step)).toEqual(["dsh.closure", "dsh.home", "dsh.profiles"])
    expect(contributors(home, ["ellamaka-tools"]).map((item) => item.step)).toEqual([
      "dsh.closure",
      "dsh.home",
      "dsh.profiles",
    ])
    const closure = contributors(home, ["web"]).find((item) => item.step === "dsh.closure")!
    expect((await closure.inspect({ kind: "host" })).state).toBe("NEEDS_PREPARATION")
    expect(existsSync(join(home, "dsh", "runtime", "node"))).toBe(false)
  })

  test("Electron Web preparation never installs a second Node", async () => {
    const home = tmpHome()
    const steps = createDshPreparationContributors({
      wopalHome: home,
      logFile: join(home, "dsh.log"),
      manifest: MANIFEST,
      closureVersion: MANIFEST.closureVersion,
      profiles: ["web"],
      usesElectronNode: true,
    })
    expect(steps.map((item) => item.step)).toEqual(["dsh.closure", "dsh.home", "dsh.profiles"])
    const closure = steps.find((item) => item.step === "dsh.closure")!
    expect((await closure.inspect({ kind: "host" })).state).toBe("NEEDS_PREPARATION")
    expect(existsSync(join(home, "dsh"))).toBe(false)
  })

  test("prepares only the requested web profile", async () => {
    const home = tmpHome()
    const profile = contributors(home, ["web"]).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(existsSync(join(layout.profileDir, "web", "package.json"))).toBe(true)
    expect(existsSync(join(layout.profileDir, "ellamaka-tools", "package.json"))).toBe(false)
  })

  test("prepares only the requested tools profile", async () => {
    const home = tmpHome()
    const profile = contributors(home, ["ellamaka-tools"]).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(existsSync(join(layout.profileDir, "web", "package.json"))).toBe(false)
    expect(existsSync(join(layout.profileDir, "ellamaka-tools", "package.json"))).toBe(true)
  })

  test("profile preparation is pure on inspect, creates host resources once, and preserves user declarations", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)

    expect((await profile.inspect({ kind: "host" })).state).toBe("NEEDS_PREPARATION")
    expect(existsSync(layout.profileDir)).toBe(false)

    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const webManifest = join(layout.profileDir, "web", "package.json")
    const webPatch = join(layout.profileDir, "web", "cordis.patch.yml")
    const webRoot = join(layout.profileDir, "web", "cordis.yml")
    const toolsManifest = join(layout.profileDir, "ellamaka-tools", "package.json")
    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    const toolsRoot = join(layout.profileDir, "ellamaka-tools", "cordis.yml")
    for (const file of [webManifest, webPatch, webRoot, toolsManifest, toolsPatch, toolsRoot])
      expect(existsSync(file)).toBe(true)

    // A fresh tools profile keeps an empty root manifest and an empty user patch
    // layer; the built-in tools composition now lives in code, not on disk.
    const freshToolsPatch = readFileSync(toolsPatch, "utf8")
    expect(JSON.parse(readFileSync(toolsManifest, "utf8")).dsh.profile.bundles).toEqual([])
    expect(parseDocument(freshToolsPatch).contents?.toJSON()).toEqual([])
    expect(freshToolsPatch).not.toContain("# >>> ellamaka-tools composition")
    expect(freshToolsPatch).not.toContain("@deepseek-ai/dsh-base")

    const userManifest = '{"name":"user-web","custom":true}\n'
    const userPatch = "# user-owned\n- { id: local-custom, disabled: false }\n"
    writeFileSync(webManifest, userManifest)
    writeFileSync(webPatch, userPatch)
    // The runtime synthetic root anchor is not user configuration: preparation
    // resets it, including when the previous engine wrote a composed tree back.
    writeFileSync(webRoot, "- id: composed-from-last-run\n")
    writeFileSync(toolsRoot, "- id: composed-from-last-run\n")

    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(webManifest, "utf8")).toBe(userManifest)
    expect(readFileSync(webPatch, "utf8")).toBe(userPatch)
    // Both synthetic root anchors are reset unconditionally.
    expect(readFileSync(webRoot, "utf8")).toBe("[]\n")
    expect(readFileSync(toolsRoot, "utf8")).toBe("[]\n")
    // User patch layers are untouched by the reset.
    expect(readFileSync(toolsPatch, "utf8")).toBe(freshToolsPatch)
  })

  test("base-backed tools becomes standalone once while preserving user configuration and extensions", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })
    await profile.prepare({ kind: "host" }, context())
    const manifestPath = join(layout.profileDir, "ellamaka-tools", "package.json")
    const patchPath = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    manifest.dependencies = { "my-tools": "file:/example/my-tools" }
    manifest.dsh.profile.bundles = ["@deepseek-ai/dsh-base", "my-tools"]
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const userPatch = "# user settings\n- id: tool-bash\n  config:\n    timeoutMs: !!js 1000 * 60\n"
    writeFileSync(patchPath, userPatch)
    expect((await profile.inspect({ kind: "host" })).state).toBe("NEEDS_PREPARATION")
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    const converted = JSON.parse(readFileSync(manifestPath, "utf8"))
    expect(converted.dependencies).toEqual(manifest.dependencies)
    expect(converted.dsh.profile.bundles).toEqual(["my-tools"])
    expect(readFileSync(patchPath, "utf8")).toBe(userPatch)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(patchPath, "utf8")).toBe(userPatch)
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(converted)
  })

  test("a repaired missing cordis.yml is written as the empty root anchor", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const webRoot = join(layout.profileDir, "web", "cordis.yml")
    unlinkSync(webRoot)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(webRoot, "utf8")).toBe("[]\n")
  })

  test("legacy host tools patch is cleaned once, keeps user rows, and settles to a byte-level no-op", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    const toolsRoot = join(layout.profileDir, "ellamaka-tools", "cordis.yml")
    const webRoot = join(layout.profileDir, "web", "cordis.yml")
    const userRoot = "- id: user-root-row\n"
    writeFileSync(webRoot, userRoot)
    writeFileSync(toolsRoot, userRoot)

    // The legacy host template: its known comment marker plus the host-owned
    // disable rows, with a user row and user comment appended after it.
    writeFileSync(
      toolsPatch,
      [
        "# Patch layer for the ellamaka tool-container profile.",
        "#",
        "# The tool container is a pure tool backend: the dsh-adapter drives its tools",
        "# --- session & agent-loop core ---",
        "- { id: session, disabled: true }",
        "- { id: agent-loop, disabled: true }",
        "- { id: session-projection-cache, disabled: true }",
        "",
        "# user comment",
        "- { id: my-own-plugin, disabled: true }",
        "",
      ].join("\n"),
    )

    // Inspection reports pending work without exposing version-specific fields.
    expect(Object.keys(inspectDshProfileResources(home)).sort()).toEqual(["missing", "ready"])
    const inspection = await profile.inspect({ kind: "host" })
    expect(inspection.state).toBe("NEEDS_PREPARATION")
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const cleaned = readFileSync(toolsPatch, "utf8")
    expect(cleaned).not.toContain("id: session, disabled: true")
    expect(cleaned).not.toContain("id: agent-loop, disabled: true")
    expect(cleaned).not.toContain("id: session-projection-cache, disabled: true")
    expect(cleaned).toContain("# user comment")
    expect(cleaned).toContain("- { id: my-own-plugin, disabled: true }")
    // The synthetic root anchor is a generated file, not user configuration:
    // preparation resets it regardless of what the caller wrote there.
    expect(readFileSync(webRoot, "utf8")).toBe("[]\n")
    expect(readFileSync(toolsRoot, "utf8")).toBe("[]\n")

    // Re-running preparation is a byte-level no-op on the user patch layer.
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(toolsPatch, "utf8")).toBe(cleaned)
    expect(readFileSync(webRoot, "utf8")).toBe("[]\n")
    expect(readFileSync(toolsRoot, "utf8")).toBe("[]\n")
  })

  test("block-style legacy rows are removed without touching the following user row", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    // Block-style rows parse identically but span more than one source line;
    // deletion must stop at the row boundary, never eat the next row.
    writeFileSync(
      toolsPatch,
      [
        "# Patch layer for the ellamaka tool-container profile.",
        "- id: session",
        "  disabled: true",
        "- id: agent-loop",
        "  disabled: true",
        "# user-tail",
        "- id: my-own-plugin",
        "  disabled: true",
        "",
      ].join("\n"),
    )

    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    const cleaned = readFileSync(toolsPatch, "utf8")
    expect(cleaned).not.toContain("- id: session\n  disabled: true")
    expect(cleaned).not.toContain("- id: agent-loop\n  disabled: true")
    expect(cleaned).toContain("# user-tail")
    expect(cleaned).toContain("- id: my-own-plugin")
    expect(cleaned).toContain("  disabled: true")

    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(toolsPatch, "utf8")).toBe(cleaned)
  })

  test("cleaning a host-only patch drops the retired scaffold and restores a valid array", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    writeFileSync(
      toolsPatch,
      [
        "# Patch layer for the ellamaka tool-container profile.",
        "# every row below was host-owned",
        "- { id: session, disabled: true }",
        "- { id: tool-web, disabled: true }",
        "",
      ].join("\n"),
    )

    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    const cleaned = readFileSync(toolsPatch, "utf8")
    // The retired template's own scaffold is host text with no user row to
    // describe: it collapses cleanly to an empty array without writing a built-in block.
    expect(cleaned).not.toContain("# Patch layer for the ellamaka tool-container profile.")
    expect(cleaned).not.toContain("# every row below was host-owned")
    expect(cleaned).not.toContain("id: session, disabled: true")
    expect(cleaned).not.toContain("# >>> ellamaka-tools composition")
    expect(parseDocument(cleaned).contents?.toJSON()).toEqual([])

    // The follow-up run must not rewrite the settled declaration.
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(toolsPatch, "utf8")).toBe(cleaned)
  })

  test("a retired scaffold wrapped around a legacy product block collapses to an empty array", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    // The shape a home reaches after an older host wrote the product block
    // plus the retired template comments and dead extra-root override.
    writeFileSync(
      toolsPatch,
      TOOLS_PROFILE_BLOCK +
        [
          "",
          "# Patch layer for the ellamaka tool-container profile.",
          "# --- session & agent-loop core ---",
          "# Session lifecycle belongs to ellamaka; the container must stay session-free.",
          "",
          "- id: sandbox-roots-policy",
          "  config:",
          "    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'",
          "    workspaceRoot: !!js process.cwd()",
          "",
        ].join("\n"),
    )

    expect((await profile.inspect({ kind: "host" })).state).toBe("NEEDS_PREPARATION")
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(toolsPatch, "utf8")).toBe("[]\n")
    // Settled: the scaffold never comes back on later boots.
    expect((await profile.inspect({ kind: "host" })).state).toBe("READY")
  })

  test("a legacy product block on disk stays ready without rewriting or taking an exclusive Home lock", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    const userTail = "# my additions\n- id: tool-bash\n  config:\n    timeoutMs: !!js 1000 * 60\n"
    // Simulate a legacy Home carrying a drifted built-in block + user rows.
    const staleBlock = TOOLS_PROFILE_BLOCK.replace(
      "    - id: tool-str-replace-editor\n      name: '@deepseek-ai/dsh-tool-str-replace-editor'\n",
      "",
    )
    const legacyDiskContent = staleBlock + userTail
    writeFileSync(toolsPatch, legacyDiskContent)

    // Holding a shared runtime lease proves preparation never tries to take an
    // exclusive Home lock or mutate cordis.patch.yml when built-in rows drift.
    const access = await acquireDshHomeRuntimeAccess({ wopalHome: home, closureVersion: MANIFEST.closureVersion })
    expect(access.ok).toBe(true)
    if (!access.ok) return
    try {
      expect((await profile.inspect({ kind: "host" })).state).toBe("READY")
      expect(readFileSync(toolsPatch, "utf8")).toBe(legacyDiskContent)
    } finally {
      await access.lease.release()
    }
  })

  test("a user-layer swap stays intact alongside a legacy product block", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    const swap = [
      "",
      "# dsh-sandbox-roots replaces the stock sandbox chain",
      "- id: sandbox",
      "  disabled: true",
      "- id: sandbox-policy",
      "  disabled: true",
      "- id: fs-sandbox",
      "  disabled: true",
      "",
      "- insert:",
      "    - id: sandbox-roots-policy",
      "      name: '@wopal/dsh-sandbox-roots'",
      "      config:",
      "        mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'",
      "        workspaceRoot: !!js process.cwd()",
      "        writableRoots:",
      "          - ~/.wopal",
      "    - id: sandbox-roots-sandbox",
      "      name: '@wopal/dsh-sandbox-roots/sandbox'",
      "    - id: sandbox-roots-fs",
      "      name: '@wopal/dsh-sandbox-roots/fs'",
      "",
    ].join("\n")
    writeFileSync(toolsPatch, swap)

    const parsed: unknown = parseDocument(readFileSync(toolsPatch, "utf8")).contents?.toJSON()
    if (!Array.isArray(parsed)) throw new Error("tools patch did not parse as an entry list")
    const rows = parsed.filter(
      (row): row is Record<string, unknown> => typeof row === "object" && row !== null && !Array.isArray(row),
    )
    const disabled = rows.filter((row) => row.disabled === true).map((row) => row.id)
    expect(disabled).toEqual(expect.arrayContaining(["sandbox", "sandbox-policy", "fs-sandbox"]))
    const inserted = rows
      .flatMap((row) => (Array.isArray(row.insert) ? row.insert : []))
      .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    expect(inserted.map((row) => row.id)).toEqual(
      expect.arrayContaining(["sandbox-roots-policy", "sandbox-roots-sandbox", "sandbox-roots-fs"]),
    )
    const policyRow = inserted.find((row) => row.id === "sandbox-roots-policy")
    const policyConfig = policyRow?.config
    expect(
      typeof policyConfig === "object" && policyConfig !== null && !Array.isArray(policyConfig)
        ? (policyConfig as { writableRoots?: unknown }).writableRoots
        : undefined,
    ).toEqual(["~/.wopal"])

    expect((await profile.inspect({ kind: "host" })).state).toBe("READY")
    expect(readFileSync(toolsPatch, "utf8")).toBe(swap)
  })

  test("user patch bytes are never overwritten by preparation", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const toolsPatch = join(layout.profileDir, "ellamaka-tools", "cordis.patch.yml")
    const userRows = "- { id: mine, disabled: true }\n"
    writeFileSync(toolsPatch, userRows)
    expect((await profile.inspect({ kind: "host" })).state).toBe("READY")
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(toolsPatch, "utf8")).toBe(userRows)
  })

  test("profile repair refuses write ownership while a runtime holds the Home lease", async () => {
    const home = tmpHome()
    const profile = contributors(home).find((item) => item.step === "dsh.profiles")!
    const layout = resolveDshLayout(home)
    expect((await prepareDshHome({ wopalHome: home, closureVersion: MANIFEST.closureVersion })).ok).toBe(true)
    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")

    const missing = join(layout.profileDir, "web", "cordis.yml")
    unlinkSync(missing)
    const access = await acquireDshHomeRuntimeAccess({ wopalHome: home, closureVersion: MANIFEST.closureVersion })
    expect(access.ok).toBe(true)
    if (!access.ok) return
    try {
      const result = await profile.prepare({ kind: "host" }, context())
      expect(result).toEqual({ state: "BUSY", code: "DSH_HOME_BUSY" })
      expect(existsSync(missing)).toBe(false)
    } finally {
      await access.lease.release()
    }
  })

  test("disabled contributors short-circuit without touching the DSH territory", async () => {
    const home = tmpHome()
    const layout = resolveDshLayout(home)
    const all = contributors(home, [])
    for (const contributor of all) {
      expect((await contributor.inspect({ kind: "host" })).state).toBe("READY")
      expect((await contributor.prepare({ kind: "host" }, context())).state).toBe("READY")
    }
    expect(existsSync(layout.dshRoot)).toBe(false)
  })
})
