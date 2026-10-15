import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireDshHomeRuntimeAccess, prepareDshHome } from "./home-guard"
import { resolveDshLayout } from "./status"
import { createDshPreparationContributors } from "./preparation"
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

function contributors(home: string, env: Record<string, string | undefined> = {}) {
  return createDshPreparationContributors({
    wopalHome: home,
    logFile: join(home, "logs", "dsh.log"),
    manifest: MANIFEST,
    closureVersion: MANIFEST.closureVersion,
    env,
  })
}

function context() {
  return {
    signal: new AbortController().signal,
    report: () => {},
  }
}

describe("DSH CorePreparation contributors", () => {
  test("exports the three host preparation steps in stable order", () => {
    expect(contributors(tmpHome()).map((item) => item.step)).toEqual(["dsh.closure", "dsh.home", "dsh.profiles"])
  })

  test("profile preparation is pure on inspect, creates host resources once, and preserves user edits", async () => {
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

    const userManifest = '{"name":"user-web","custom":true}\n'
    const userPatch = "# user-owned\n- { id: local-custom, disabled: false }\n"
    writeFileSync(webManifest, userManifest)
    writeFileSync(webPatch, userPatch)
    unlinkSync(toolsRoot)

    expect((await profile.prepare({ kind: "host" }, context())).state).toBe("READY")
    expect(readFileSync(webManifest, "utf8")).toBe(userManifest)
    expect(readFileSync(webPatch, "utf8")).toBe(userPatch)
    expect(existsSync(toolsRoot)).toBe(true)
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
    const all = contributors(home, { ELLAMAKA_DSH: "0" })
    for (const contributor of all) {
      expect((await contributor.inspect({ kind: "host" })).state).toBe("READY")
      expect((await contributor.prepare({ kind: "host" }, context())).state).toBe("READY")
    }
    expect(existsSync(layout.dshRoot)).toBe(false)
  })
})
