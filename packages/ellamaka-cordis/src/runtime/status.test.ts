import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  closureNameForFingerprint,
  dshHomeDirOf,
  expandCacheDir,
  homeProfilesDirOf,
  isDshEnabled,
  resolveDshLayout,
  resolveInstallAnchor,
} from "./status"
import type { DshRuntimeManifestV1 } from "./manifest"

describe("isDshEnabled (Gate)", () => {
  test("returns false when ELLAMAKA_DSH is exactly 0", () => {
    expect(isDshEnabled({ ELLAMAKA_DSH: "0" })).toBe(false)
  })

  test("returns true when the variable is unset", () => {
    expect(isDshEnabled({})).toBe(true)
  })

  test("returns true for any non-0 value", () => {
    expect(isDshEnabled({ ELLAMAKA_DSH: "1" })).toBe(true)
    expect(isDshEnabled({ ELLAMAKA_DSH: "false" })).toBe(true)
  })
})

describe("resolveDshLayout", () => {
  test("derives the official-layout home under the territory root (never DSH_HOME)", () => {
    const layout = resolveDshLayout("/tmp/wh")
    expect(layout.dshHome).toBe("/tmp/wh/dsh")
    expect(layout.homeDir).toBe("/tmp/wh/dsh/home")
    expect(layout.profileDir).toBe("/tmp/wh/dsh/home/profiles")
    expect(layout.closuresDir).toBe("/tmp/wh/dsh/closures")
    expect(layout.stagingDir).toBe("/tmp/wh/dsh/staging")
    expect(layout.locksDir).toBe("/tmp/wh/dsh/locks")
    expect(layout.lockFile).toBe("/tmp/wh/dsh/locks/materialize.lock")
    expect("stateDir" in layout).toBe(false)
  })
})

describe("dshHomeDirOf / homeProfilesDirOf", () => {
  test("derives the DSH home and the profiles area from a territory root", () => {
    expect(dshHomeDirOf("/tmp/wh/dsh")).toBe("/tmp/wh/dsh/home")
    expect(homeProfilesDirOf("/tmp/wh/dsh")).toBe("/tmp/wh/dsh/home/profiles")
  })
})

describe("closureNameForFingerprint", () => {
  test("takes the first 12 hex chars of the sha256 digest", () => {
    const fp = "sha256:9e1ee84dfdd992bf9ebb37c7506f13bc17b87158d02783c2b1b24fd25a32cda7"
    expect(closureNameForFingerprint(fp)).toBe("9e1ee84dfdd9")
    expect(closureNameForFingerprint(fp)).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe("expandCacheDir", () => {
  test("resolves ~ to the user home npm cacache dir", () => {
    expect(expandCacheDir()).toMatch(/[\\/]_cacache$/)
  })
})

describe("resolveInstallAnchor", () => {
  const MANIFEST: DshRuntimeManifestV1 = {
    schema: "ellamaka.dsh-runtime/v1",
    bridgeAbi: 1,
    dependencies: { "@deepseek-ai/dsh": "0.1.1-rc.2" },
    fingerprint: "sha256:9e1ee84dfdd992bf9ebb37c7506f13bc17b87158d02783c2b1b24fd25a32cda7",
  }

  test("derives the closure anchor path and generation id from the layout and fingerprint", () => {
    const anchor = resolveInstallAnchor("/tmp/wh", MANIFEST)
    expect(anchor.genId).toBe("9e1ee84dfdd9")
    expect(anchor.path).toBe(
      "/tmp/wh/dsh/closures/9e1ee84dfdd9/node_modules/@deepseek-ai/dsh/package.json",
    )
  })

  test("matches the exact anchor layout the runtime manager materialises", () => {
    const anchor = resolveInstallAnchor("/tmp/wh", MANIFEST)
    const closureName = closureNameForFingerprint(MANIFEST.fingerprint!)
    expect(anchor.path).toBe(
      join(
        resolveDshLayout("/tmp/wh").closuresDir,
        closureName,
        "node_modules",
        "@deepseek-ai",
        "dsh",
        "package.json",
      ),
    )
  })

  test("throws when the manifest has no fingerprint", () => {
    expect(() => resolveInstallAnchor("/tmp/wh", { ...MANIFEST, fingerprint: undefined })).toThrow()
  })
})
