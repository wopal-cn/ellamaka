import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  checkClosureIntegrity,
  materializeClosure,
  validateClosureOnDisk,
  type MaterializeDeps,
} from "./materializer"
import type { DshRuntimeManifestV1 } from "./manifest"
import type { DshRuntimeLockV1 } from "./lockfile"
import { closureNameForFingerprint, resolveDshLayout } from "./status"

const dirs: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mat-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const MANIFEST: DshRuntimeManifestV1 = {
  schema: "ellamaka.dsh-runtime/v1",
  bridgeAbi: 1,
  dependencies: {
    "@deepseek-ai/dsh": "0.1.1-rc.2",
    "@deepseek-ai/cordis": "4.0.1",
  },
  fingerprint: "sha256:9e1ee84dfdd992bf9ebb37c7506f13bc17b87158d02783c2b1b24fd25a32cda7",
}

/** The embedded lock for the test manifest (the exact tree the materialiser replays). */
const LOCK: DshRuntimeLockV1 = {
  schema: "ellamaka.dsh-runtime-lock/v1",
  manifestFingerprint: MANIFEST.fingerprint!,
  packages: {
    "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
    "node_modules/@deepseek-ai/cordis": { version: "4.0.1" },
    "node_modules/@deepseek-ai/cordis-plugin-include": { version: "1.0.6" },
  },
}

/** A fake extractor that synthesises the closure package.json for each spec. */
function fakeExtractor(fail?: (spec: string) => string): NonNullable<MaterializeDeps> {
  return {
    // A stub fetch so the registry-selection probe never touches the network.
    fetch: async () => ({ status: 200, ok: true }),
    extract: async (spec: string, dest: string) => {
      if (fail) throw new Error(fail(spec))
      // `dest` is the closure node_modules path for the package; create the
      // package the way the real pacote extract would (contents at dest).
      const name = spec.slice(0, spec.lastIndexOf("@"))
      const body: Record<string, string> = { name, version: spec.slice(spec.lastIndexOf("@") + 1) }
      if (name === "@deepseek-ai/dsh") body.bin = "lib/bin.js"
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, "package.json"), JSON.stringify(body))
    },
  }
}

/** Materialise with the fake extractor and the test lock. */
function materialize(home: string, fail?: (spec: string) => string) {
  return materializeClosure({ home, manifest: MANIFEST, lock: LOCK, deps: fakeExtractor(fail) })
}

/** Synthesise a complete, valid closure directory under a tmp home. */
function seedClosure(home: string, manifest = MANIFEST): string {
  const layout = resolveDshLayout(home)
  const closureDir = join(layout.closuresDir, closureNameForFingerprint(manifest.fingerprint!))
  mkdirSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh"), { recursive: true })
  mkdirSync(join(closureDir, "node_modules", "@deepseek-ai", "cordis"), { recursive: true })
  writeFileSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: manifest.dependencies["@deepseek-ai/dsh"], bin: "lib/bin.js" }))
  writeFileSync(join(closureDir, "node_modules", "@deepseek-ai", "cordis", "package.json"), JSON.stringify({ name: "@deepseek-ai/cordis", version: manifest.dependencies["@deepseek-ai/cordis"] }))
  writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(closureDir, "package.json"), JSON.stringify({ name: "ellamaka-dsh-closure", dependencies: manifest.dependencies }))
  // The stored lock is the embedded lock's on-disk copy (npm v3 shape).
  writeFileSync(
    join(closureDir, "package-lock.json"),
    JSON.stringify({
      name: "ellamaka-dsh-closure",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {},
        ...Object.fromEntries(
          Object.entries(LOCK.packages).map(([path, entry]) => [path, entry]),
        ),
      },
      ...(!manifest.fingerprint ? {} : {}),
    }),
  )
  return join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json")
}

describe("materializeClosure", () => {
  test("extracts every locked package into staging, then activates into closures/<fingerprint>", async () => {
    const home = tmpHome()
    const lock = LOCK
    const result = await materialize(home)
    const closureDir = join(resolveDshLayout(home).closuresDir, closureNameForFingerprint(MANIFEST.fingerprint!))
    expect(result.anchor).toBe(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"))
    expect(result.closureDir).toBe(closureDir)
    expect(existsSync(result.anchor)).toBe(true)
    expect(existsSync(join(closureDir, "runtime-manifest.json"))).toBe(true)
    expect(existsSync(join(closureDir, "package.json"))).toBe(true)
    expect(existsSync(join(closureDir, "package-lock.json"))).toBe(true)
    // every locked package was extracted
    for (const path of Object.keys(lock.packages)) {
      expect(existsSync(join(closureDir, ...path.split("/"), "package.json"))).toBe(true)
    }
    // staging is drained after a successful activate
    expect(existsSync(resolveDshLayout(home).stagingDir)).toBe(false)
  })

  test("extract failure leaves staging in place and rejects (no closure activated)", async () => {
    const home = tmpHome()
    await expect(materialize(home, () => "network down")).rejects.toThrow(/network down/)
    expect(existsSync(resolveDshLayout(home).stagingDir)).toBe(true)
    expect(existsSync(resolveDshLayout(home).closuresDir)).toBe(false)
  })

  test("an optional package that fails to extract is skipped, closure still activates", async () => {
    const home = tmpHome()
    const lock: DshRuntimeLockV1 = {
      ...LOCK,
      packages: {
        ...LOCK.packages,
        // an optional platform package the registry mirror lacks
        "node_modules/@koromix/koffi-android-x64": { version: "3.2.1", optional: true },
      },
    }
    const failed = new Set<string>()
    const deps: NonNullable<MaterializeDeps> = {
      fetch: async () => ({ status: 200, ok: true }),
      extract: async (spec: string, dest: string) => {
        if (spec.startsWith("@koromix/koffi-android-x64@")) {
          failed.add(spec)
          throw new Error("404 Not Found - GET .../koffi-android-x64")
        }
        const name = spec.slice(0, spec.lastIndexOf("@"))
        const body: Record<string, string> = { name, version: spec.slice(spec.lastIndexOf("@") + 1) }
        if (name === "@deepseek-ai/dsh") body.bin = "lib/bin.js"
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, "package.json"), JSON.stringify(body))
      },
    }
    const result = await materializeClosure({ home, manifest: MANIFEST, lock, deps })
    // the optional package failed but was skipped, not fatal
    expect(failed.size).toBe(1)
    const closureDir = join(resolveDshLayout(home).closuresDir, closureNameForFingerprint(MANIFEST.fingerprint!))
    expect(existsSync(result.anchor)).toBe(true)
    // every required package is present
    for (const path of Object.keys(lock.packages)) {
      if (path.includes("koffi-android-x64")) continue
      expect(existsSync(join(closureDir, ...path.split("/"), "package.json"))).toBe(true)
    }
    // the skipped optional package leaves no residual directory
    expect(existsSync(join(closureDir, "node_modules", "@koromix", "koffi-android-x64"))).toBe(false)
  })

  test("a required package that fails to extract still rejects (no closure activated)", async () => {
    const home = tmpHome()
    const lock: DshRuntimeLockV1 = {
      ...LOCK,
      packages: {
        ...LOCK.packages,
        // NOT optional — a genuine missing required package
        "node_modules/@koromix/koffi-android-x64": { version: "3.2.1" },
      },
    }
    const deps: NonNullable<MaterializeDeps> = {
      fetch: async () => ({ status: 200, ok: true }),
      extract: async (spec: string, dest: string) => {
        if (spec.startsWith("@koromix/koffi-android-x64@")) {
          throw new Error("404 Not Found - GET .../koffi-android-x64")
        }
        const name = spec.slice(0, spec.lastIndexOf("@"))
        const body: Record<string, string> = { name, version: spec.slice(spec.lastIndexOf("@") + 1) }
        if (name === "@deepseek-ai/dsh") body.bin = "lib/bin.js"
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, "package.json"), JSON.stringify(body))
      },
    }
    await expect(materializeClosure({ home, manifest: MANIFEST, lock, deps })).rejects.toThrow(/404/)
    expect(existsSync(resolveDshLayout(home).closuresDir)).toBe(false)
  })

  test("rejects when the injected lock does not bind the manifest fingerprint", async () => {
    const home = tmpHome()
    const drifted: DshRuntimeLockV1 = { ...LOCK, manifestFingerprint: "sha256:stale" }
    await expect(
      materializeClosure({ home, manifest: MANIFEST, lock: drifted, deps: fakeExtractor() }),
    ).rejects.toThrow(/fingerprint|drift/i)
    expect(existsSync(resolveDshLayout(home).stagingDir)).toBe(false)
  })

  test("does not overwrite an existing closure of the same fingerprint", async () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    const before = readFileSync(anchor, "utf8")
    const result = await materialize(home)
    expect(result.anchor).toBe(anchor)
    expect(readFileSync(anchor, "utf8")).toBe(before)
  })
})

describe("validateClosureOnDisk", () => {
  test("returns the anchor when the closure is complete", () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBe(anchor)
  })

  test("returns null when the closure is missing", () => {
    const home = tmpHome()
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })

  test("returns null when the anchor is damaged (missing dsh package.json)", () => {
    const home = tmpHome()
    const closureDir = join(resolveDshLayout(home).closuresDir, closureNameForFingerprint(MANIFEST.fingerprint!))
    mkdirSync(join(closureDir, "node_modules", "@deepseek-ai"), { recursive: true })
    writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(MANIFEST))
    writeFileSync(join(closureDir, "package.json"), JSON.stringify({ name: "ellamaka-dsh-closure", dependencies: MANIFEST.dependencies }))
    writeFileSync(join(closureDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }))
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })

  test("returns null when a direct dependency package.json is missing", () => {
    const home = tmpHome()
    const closureDir = join(resolveDshLayout(home).closuresDir, closureNameForFingerprint(MANIFEST.fingerprint!))
    mkdirSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh"), { recursive: true })
  writeFileSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.1-rc.2", main: "index.js" }))
    writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(MANIFEST))
    writeFileSync(join(closureDir, "package.json"), JSON.stringify({ name: "ellamaka-dsh-closure", dependencies: MANIFEST.dependencies }))
    writeFileSync(join(closureDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }))
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })

  test("returns null when the closure manifest does not match the fingerprint", () => {
    const home = tmpHome()
    const other: DshRuntimeManifestV1 = {
      ...MANIFEST,
      dependencies: { "@deepseek-ai/dsh": "0.2.0" },
      fingerprint: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    }
    seedClosure(home, other)
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })
})

describe("validateClosureOnDisk — closure content verification (B-03)", () => {
  // The anchor is closures/<fp>/node_modules/@deepseek-ai/dsh/package.json;
  // the closure root is four dirname hops up.
  const closureRoot = (anchor: string) => dirname(dirname(dirname(dirname(anchor))))

  test("returns null when runtime-manifest.json is swapped for another fingerprint", () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    // Swap the stored manifest to a different fingerprint's manifest while the
    // directory name still matches MANIFEST's fingerprint.
    const other: DshRuntimeManifestV1 = {
      ...MANIFEST,
      dependencies: { "@deepseek-ai/dsh": "0.2.0" },
      fingerprint: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    }
    writeFileSync(join(closureRoot(anchor), "runtime-manifest.json"), JSON.stringify(other))
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })

  test("returns null when package-lock.json is truncated", () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    // Truncating the lock leaves a partial document; presence alone is not
    // enough — the closure must be treated as damaged and re-materialised.
    writeFileSync(join(closureRoot(anchor), "package-lock.json"), '{"lockfileVersion": 3, ')
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })

  test("returns null when package-lock.json is a valid JSON but not an npm v3 lock", () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    // A well-formed JSON that is not a v3 lockfile (no lockfileVersion 3 /
    // packages map) is not a lock the materialiser writes — the closure is
    // damaged.
    writeFileSync(
      join(closureRoot(anchor), "package-lock.json"),
      JSON.stringify({ foo: "bar" }),
    )
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })

  test("returns the anchor when the runtime lock has a valid v3 shape with different content", () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    // A valid npm v3 lock whose packages map differs from the embedded lock's
    // is still a legitimate install record: the direct-deps exact versions
    // below bind closure correctness (DESIGN §3.4.3).
    writeFileSync(
      join(closureRoot(anchor), "package-lock.json"),
      JSON.stringify({ name: "ellamaka-dsh-closure", lockfileVersion: 3, requires: true, packages: {} }),
    )
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBe(anchor)
  })

  test("returns null when a direct dependency is installed at the wrong version", () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    // Corrupt @deepseek-ai/cordis's installed version.
    writeFileSync(
      join(closureRoot(anchor), "node_modules", "@deepseek-ai", "cordis", "package.json"),
      JSON.stringify({ name: "@deepseek-ai/cordis", version: "9.9.9" }),
    )
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBeNull()
  })

  test("returns the anchor when runtime-manifest.json is key-order-mutated but same content", () => {
    // Key order must not matter: canonical comparison, not byte comparison.
    const home = tmpHome()
    const anchor = seedClosure(home)
    // Re-serialize with reversed top-level key order (same content).
    const reversed = Object.fromEntries(
      Object.entries(MANIFEST).reverse().filter(([, v]) => v !== undefined),
    )
    writeFileSync(join(closureRoot(anchor), "runtime-manifest.json"), JSON.stringify(reversed))
    expect(validateClosureOnDisk({ home, manifest: MANIFEST, deps: fakeExtractor() })).toBe(anchor)
  })

  test("a tampered closure is re-materialised by materializeClosure, not adopted", async () => {
    const home = tmpHome()
    const anchor = seedClosure(home)
    const root = closureRoot(anchor)
    // Tamper: swap the stored manifest to a different fingerprint.
    const other: DshRuntimeManifestV1 = {
      ...MANIFEST,
      dependencies: { "@deepseek-ai/dsh": "0.2.0" },
      fingerprint: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    }
    writeFileSync(join(root, "runtime-manifest.json"), JSON.stringify(other))
    // Tampered closure must be treated as damaged and replaced with a
    // canonical one (the fake extractor synthesises the closure again).
    const result = await materialize(home)
    expect(result.anchor).toBe(anchor)
    const stored = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"))
    expect(JSON.stringify(stored)).toBe(JSON.stringify(MANIFEST))
  })
})

describe("checkClosureIntegrity", () => {
  test("resolves when integrity metadata is present and anchor files exist", async () => {
    const home = tmpHome()
    seedClosure(home)
    await expect(checkClosureIntegrity({ home, manifest: MANIFEST, deps: fakeExtractor() })).resolves.toBeUndefined()
  })

  test("rejects when integrity metadata is present but the anchor is missing", async () => {
    const home = tmpHome()
    // no closure seeded
    await expect(checkClosureIntegrity({ home, manifest: MANIFEST, deps: fakeExtractor() })).rejects.toThrow(/anchor|integrity/i)
  })
})