import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { DSH_RUNTIME_ABI, buildDshRuntimeManifest } from "./manifest"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
const manifest = JSON.parse(readFileSync(new URL("../../generated/dsh-runtime-manifest.json", import.meta.url), "utf8"))
const lock = JSON.parse(readFileSync(new URL("../../generated/dsh-runtime-lock.json", import.meta.url), "utf8"))

describe("dsh rc.2 release baseline", () => {
  test("uses the exact selected DSH release for every direct DSH dependency", () => {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (name.startsWith("@deepseek-ai/dsh")) expect(version).toBe("0.2.0-rc.2")
    }
  })
  test("locks the matching vendor runtime and excludes the removed executor", () => {
    expect(pkg.dependencies["@deepseek-ai/cordis"]).toBe("4.0.4")
    expect(pkg.dependencies["@deepseek-ai/cordis-plugin-loader"]).toBe("1.0.5")
    expect(pkg.dependencies["@deepseek-ai/cordis-plugin-include"]).toBe("1.0.9")
    expect(pkg.dependencies["@deepseek-ai/schemastery"]).toBe("3.18.4")
    expect(pkg.dependencies["@deepseek-ai/dsh-code-runtime"]).toBeUndefined()
    for (const name of ["dsh-ptc-runtime", "dsh-ptc-runtime-node", "dsh-tool-str-replace-editor"]) {
      expect(pkg.dependencies["@deepseek-ai/" + name]).toBe("0.2.0-rc.2")
    }
  })
  test("binds the generated manifest and full lock to Bridge ABI 2", () => {
    expect(DSH_RUNTIME_ABI).toBe(2)
    expect(manifest).toEqual(buildDshRuntimeManifest(pkg))
    expect(lock.manifestFingerprint).toBe(manifest.fingerprint)
    for (const [path, entry] of Object.entries(lock.packages) as [string, { version: string }][]) {
      if (path.match(/node_modules\/@deepseek-ai\/dsh(?:\/|-[^/]+$)/)) {
        expect(entry.version).toBe("0.2.0-rc.2")
      }
    }
  })
})
