import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { DSH_RUNTIME_ABI, buildDshRuntimeManifest } from "./manifest"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
const manifest = JSON.parse(readFileSync(new URL("../../generated/dsh-runtime-manifest.json", import.meta.url), "utf8"))
const lock = JSON.parse(readFileSync(new URL("../../generated/dsh-runtime-lock.json", import.meta.url), "utf8"))

describe("dsh rc.2 release baseline", () => {
  test("declares @deepseek-ai/dsh as the only direct official dependency", () => {
    const officialDirectDependencies = Object.keys(pkg.dependencies).filter((name) => name.startsWith("@deepseek-ai/"))
    expect(officialDirectDependencies).toEqual(["@deepseek-ai/dsh"])
    expect(pkg.dependencies["@deepseek-ai/dsh"]).toBe("0.2.0-rc.2")
  })
  test("locks the Bridge runtime and core bundles through the single DSH root", () => {
    const expected = {
      "@deepseek-ai/cordis": "4.0.5",
      "@deepseek-ai/cordis-plugin-loader": "1.0.6",
      "@deepseek-ai/schemastery": "3.18.5",
      "@deepseek-ai/dsh-app-boot": "0.2.0-rc.2",
      "@deepseek-ai/dsh-base": "0.2.0-rc.2",
      "@deepseek-ai/dsh-cmdline": "0.2.0-rc.2",
      "@deepseek-ai/dsh-host-webserver": "0.2.0-rc.2",
      "@deepseek-ai/dsh-launch-environment": "0.2.0-rc.2",
      "@deepseek-ai/dsh-ptc-runtime": "0.2.0-rc.2",
      "@deepseek-ai/dsh-ptc-runtime-node": "0.2.0-rc.2",
      "@deepseek-ai/dsh-tool-str-replace-editor": "0.2.0-rc.2",
      "@deepseek-ai/dsh-web-app": "0.2.0-rc.2",
    }
    for (const [name, version] of Object.entries(expected)) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version)
    }
  })
  test("binds the generated manifest and full lock to Bridge ABI 2", () => {
    expect(DSH_RUNTIME_ABI).toBe(2)
    expect(manifest).toEqual(buildDshRuntimeManifest(pkg))
    expect(lock.manifestFingerprint).toBe(manifest.fingerprint)
    for (const [path, entry] of Object.entries<{ version: string }>(lock.packages)) {
      if (path.match(/node_modules\/@deepseek-ai\/dsh(?:\/|-[^/]+$)/)) {
        expect(entry.version).toBe("0.2.0-rc.2")
      }
    }
  })
})
