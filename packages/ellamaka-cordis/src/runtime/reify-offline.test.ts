import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { materializeClosure } from "./materializer"
import { resolveDshLayout } from "./status"
import { computeManifestFingerprint, type DshRuntimeManifestV1 } from "./manifest"
import type { DshRuntimeLockV1 } from "./lockfile"

const dirs: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-reify-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Build a real package tarball with `npm pack` into `outDir` and return the
 * tarball's absolute path. Used to seed an OFFLINE fixture: the closure
 * extracts from local `file:` tarballs, never the network (W-03).
 */
function makeTarball(root: string, name: string, version: string): string {
  const pkgDir = join(root, `pkg-${name.replace(/[^a-z0-9]/gi, "-")}`)
  mkdirSync(join(pkgDir, "lib"), { recursive: true })
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version, main: "lib/index.js" }, null, 2),
  )
  writeFileSync(join(pkgDir, "lib", "index.js"), `module.exports = { name: ${JSON.stringify(name)} }`)
  const outDir = join(root, "tarballs")
  mkdirSync(outDir, { recursive: true })
  // npm pack --json prints the packed filename; use it to locate the tarball.
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], {
    cwd: pkgDir,
    encoding: "utf8",
  })
  const json = JSON.parse(out) as { filename: string }[]
  return join(outDir, json[0].filename)
}

describe("W-03: real pacote extraction against a local offline fixture", () => {
  test(
    "materializeClosure extracts with the REAL pacote from local file: specs (no network)",
    async () => {
      const home = tmpHome()
      const fixture = join(home, "fixture")
      mkdirSync(fixture, { recursive: true })

      // Build two real tarballs: the dsh anchor and a dependency.
      const dshTarball = makeTarball(fixture, "@deepseek-ai/dsh", "1.0.0-reify")
      const cordisTarball = makeTarball(fixture, "@deepseek-ai/cordis", "4.0.1")

      // A manifest whose direct deps are the local tarball versions, plus the
      // matching lock — the real pacote extracts from disk, proving the whole
      // pipeline works without any network registry.
      const manifest: DshRuntimeManifestV1 = {
        schema: "ellamaka.dsh-runtime/v1",
        bridgeAbi: 1,
        dependencies: {
          "@deepseek-ai/dsh": "1.0.0-reify",
          "@deepseek-ai/cordis": "4.0.1",
        },
      }
      manifest.fingerprint = computeManifestFingerprint(manifest)

      const lock: DshRuntimeLockV1 = {
        schema: "ellamaka.dsh-runtime-lock/v1",
        manifestFingerprint: manifest.fingerprint,
        packages: {
          "node_modules/@deepseek-ai/dsh": { version: "1.0.0-reify" },
          "node_modules/@deepseek-ai/cordis": { version: "4.0.1" },
        },
      }

      // The real production extractor (pacote) resolves the lock's name@version
      // specs against the overridden `file:` dependencySpecs-like registry —
      // here we pass the tarball paths as the specs via the extract seam, so
      // nothing touches the network.
      const specByPkg: Record<string, string> = {
        "@deepseek-ai/dsh": `file:${dshTarball}`,
        "@deepseek-ai/cordis": `file:${cordisTarball}`,
      }
      const localSpecs = async (registry: string): Promise<Record<string, string>> => {
        void registry
        return specByPkg
      }
      void localSpecs

      const result = await materializeClosure({
        home,
        manifest,
        lock,
        deps: {
          registry: "file:",
          // Real production extract flow, but the spec per locked package is
          // rewritten to its offline file: tarball. This mirrors the dynamic
          // registry selection seam: only the transport differs.
          extract: async (spec, dest, opts) => {
            void opts
            const name = spec.slice(0, spec.lastIndexOf("@"))
            const { default: pacote } = await import("pacote")
            await pacote.extract(specByPkg[name] ?? spec, dest, { registry: "file:" })
          },
        },
      })

      const closureDir = result.closureDir
      expect(existsSync(closureDir)).toBe(true)
      const dshPkg = JSON.parse(
        readFileSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"),
      )
      expect(dshPkg.version).toBe("1.0.0-reify")
      const cordisPkg = JSON.parse(
        readFileSync(join(closureDir, "node_modules", "@deepseek-ai", "cordis", "package.json"), "utf8"),
      )
      expect(cordisPkg.version).toBe("4.0.1")
      // staging is drained after activation.
      expect(existsSync(resolveDshLayout(home).stagingDir)).toBe(false)
    },
    60_000,
  )
})