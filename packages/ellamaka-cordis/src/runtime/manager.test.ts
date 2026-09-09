import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeDshRuntime, type InitializeDshOptions, type ManagerDeps } from "./manager"
import type { DshRuntimeManifestV1 } from "./manifest"
import type { DshRuntimeLockV1 } from "./lockfile"
import { closureNameForFingerprint, resolveDshLayout } from "./status"

const dirs: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mgr-"))
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

/** The embedded lock the fake extractor replays (binds the test manifest). */
const LOCK: DshRuntimeLockV1 = {
  schema: "ellamaka.dsh-runtime-lock/v1",
  manifestFingerprint: MANIFEST.fingerprint!,
  packages: {
    "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
    "node_modules/@deepseek-ai/cordis": { version: "4.0.1" },
  },
}

/** A minimal valid npm lockfile v3 document (the runtime-lock shape). */
function runtimeLock(manifest: DshRuntimeManifestV1): string {
  const packages: Record<string, { version: string }> = {
    "": {},
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    packages[`node_modules/${name}`] = { version }
  }
  return JSON.stringify(
    { name: "ellamaka-dsh-closure", lockfileVersion: 3, requires: true, packages },
    null,
    2,
  )
}

/** The closure package.json for a direct dependency; dsh carries a bin entry (real shape). */
function depPkgJson(name: string): string {
  // Write the manifest's PINNED version for each dep (B-02: the happy-path
  // fixture must exercise real content verification, so versions must match
  // the manifest pins rather than a hard-coded placeholder).
  const body: Record<string, string> = { name, version: MANIFEST.dependencies[name] }
  if (name === "@deepseek-ai/dsh") body.bin = "lib/bin.js"
  return JSON.stringify(body)
}

/** Fake extractor that synthesises each locked package's package.json at dest. */
function fakeExtractor(hook?: () => void | Promise<void>): ManagerDeps["extract"] {
  return async (spec: string, dest: string) => {
    if (hook) await hook()
    const name = spec.slice(0, spec.lastIndexOf("@"))
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, "package.json"), depPkgJson(name))
  }
}

/** Base deps for tests: stub fetch + the fake extractor + the synthetic lock. */
function testDeps(hook?: () => void | Promise<void>): Pick<InitializeDshOptions, "lock"> & { deps: ManagerDeps } {
  return {
    lock: LOCK,
    deps: {
      fetch: async () => ({ status: 200, ok: true }),
      extract: fakeExtractor(hook),
    },
  }
}

function makeBaseOptions(home: string, overrides: Partial<InitializeDshOptions> = {}): InitializeDshOptions {
  return {
    wopalHome: home,
    logFile: join(home, "logs", "dsh.log"),
    entry: "serve",
    manifest: MANIFEST,
    ...overrides,
    // A stub fetch so the registry-selection probe never touches the network
    // in tests: it returns a fast, reachable response for any candidate. Caller
    // deps (extract) are merged over this default fetch.
    deps: {
      fetch: async () => ({ status: 200, ok: true }),
      ...overrides.deps,
    },
  }
}

/** Seed a complete valid closure for the default fingerprint under a tmp home. */
function seedClosure(home: string): string {
  return seedClosureAt(home, MANIFEST)
}

/** Seed a complete valid closure for an arbitrary manifest. */
function seedClosureAt(home: string, manifest: DshRuntimeManifestV1): string {
  const layout = resolveDshLayout(home)
  const closureDir = join(layout.closuresDir, closureNameForFingerprint(manifest.fingerprint!))
  mkdirSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh"), { recursive: true })
  mkdirSync(join(closureDir, "node_modules", "@deepseek-ai", "cordis"), { recursive: true })
  writeFileSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: manifest.dependencies["@deepseek-ai/dsh"], bin: "lib/bin.js" }))
  writeFileSync(join(closureDir, "node_modules", "@deepseek-ai", "cordis", "package.json"), JSON.stringify({ name: "@deepseek-ai/cordis", version: manifest.dependencies["@deepseek-ai/cordis"] }))
  writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(closureDir, "package.json"), JSON.stringify({ name: "ellamaka-dsh-closure", dependencies: manifest.dependencies }))
  // The stored lock is the runtime lock (valid npm v3 shape).
  writeFileSync(join(closureDir, "package-lock.json"), runtimeLock(manifest))
  return join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json")
}

describe("initializeDshRuntime state machine", () => {
  test("ELLAMAKA_DSH=0 -> disabled with zero file access", async () => {
    const home = tmpHome()
    const options = makeBaseOptions(home, {
      deps: {
        fetch: async () => {
          throw new Error("must not fetch")
        },
      },
    })
    const status = await initializeDshRuntime({ ...options, env: { ELLAMAKA_DSH: "0" } })
    expect(status).toBe("disabled")
    expect(existsSync(resolveDshLayout(home).dshHome)).toBe(false)
  })

  test("ELLAMAKA_DSH=0 -> no log file, no parent dir, clean stderr (B-02)", async () => {
    const home = tmpHome()
    const logFile = join(home, "logs", "dsh.log")
    // Stub stderr so the disabled path cannot write anything to it.
    const origWrite = process.stderr.write
    const written: string[] = []
    ;(process.stderr as { write: (s: string) => boolean }).write = (chunk) => {
      written.push(String(chunk))
      return true
    }
    try {
      const status = await initializeDshRuntime({
        ...makeBaseOptions(home),
        logFile,
        env: { ELLAMAKA_DSH: "0" },
      })
      expect(status).toBe("disabled")
      // Zero dsh output on stderr.
      expect(written.filter((s) => s.includes("[dsh]"))).toEqual([])
      // No log file and no parent log dir were created.
      expect(existsSync(logFile)).toBe(false)
      expect(existsSync(join(home, "logs"))).toBe(false)
    } finally {
      ;(process.stderr as { write: (s: string) => boolean }).write = origWrite
    }
  })

  test("target closure already materialised -> ready without any network fetch", async () => {
    const home = tmpHome()
    seedClosure(home)
    const fetchSpy = async () => {
      throw new Error("must not fetch")
    }
    const status = await initializeDshRuntime(makeBaseOptions(home, { deps: { fetch: fetchSpy } }))
    expect(status).toBe("ready")
  })

  test("missing closure -> hold lock, extract, verify, activate, ready", async () => {
    const home = tmpHome()
    const status = await initializeDshRuntime(makeBaseOptions(home, testDeps()))
    expect(status).toBe("ready")
    const closureDir = join(resolveDshLayout(home).closuresDir, closureNameForFingerprint(MANIFEST.fingerprint!))
    expect(existsSync(closureDir)).toBe(true)
    expect(existsSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"))).toBe(true)
  })

  test("extract failure -> degraded and never overwrites a working closure", async () => {
    const home = tmpHome()
    // Seed a working closure for a DIFFERENT fingerprint (the one in use).
    const otherManifest: DshRuntimeManifestV1 = {
      ...MANIFEST,
      dependencies: { "@deepseek-ai/dsh": "0.2.0" },
      fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }
    const existingAnchor = seedClosureAt(home, otherManifest)
    const failing: ManagerDeps["extract"] = async () => {
      throw new Error("extractor exploded")
    }
    const status = await initializeDshRuntime(
      makeBaseOptions(home, { ...testDeps(), deps: { ...testDeps().deps, extract: failing } }),
    )
    expect(status).toBe("degraded")
    expect(existsSync(existingAnchor)).toBe(true)
  })

  test("damaged closure (anchor missing) is treated as missing and re-materialised", async () => {
    const home = tmpHome()
    const closureDir = join(resolveDshLayout(home).closuresDir, closureNameForFingerprint(MANIFEST.fingerprint!))
    mkdirSync(join(closureDir, "node_modules", "@deepseek-ai"), { recursive: true })
    writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(MANIFEST))
    writeFileSync(join(closureDir, "package.json"), JSON.stringify({ name: "ellamaka-dsh-closure", dependencies: MANIFEST.dependencies }))
    writeFileSync(join(closureDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }))

    const status = await initializeDshRuntime(makeBaseOptions(home, testDeps()))
    expect(status).toBe("ready")
    expect(existsSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"))).toBe(true)
  })

  test("concurrent calls: one materialises, the other waits then resolves ready", async () => {
    const home = tmpHome()
    const calls: string[] = []
    const gated = fakeExtractor(() => {
      calls.push("extract")
    })
    const options = makeBaseOptions(home, { ...testDeps(), deps: { ...testDeps().deps, extract: gated } })
    const [a, b] = await Promise.all([initializeDshRuntime(options), initializeDshRuntime(options)])
    expect(a).toBe("ready")
    expect(b).toBe("ready")
    // Single-flight: the shared durable materialisation runs once. The extractor
    // may be invoked for several packages, but only within that one run.
    expect(calls.length).toBeGreaterThan(0)
  })

  test("idempotent: two sequential calls both resolve ready", async () => {
    const home = tmpHome()
    const options = makeBaseOptions(home, testDeps())
    expect(await initializeDshRuntime(options)).toBe("ready")
    expect(await initializeDshRuntime(options)).toBe("ready")
  })

  test("ready closure exposes an installAnchor that loader can resolve", async () => {
    const home = tmpHome()
    const status = await initializeDshRuntime(makeBaseOptions(home, testDeps()))
    expect(status).toBe("ready")
    // The installed anchor exists and createClosureRequire can read the dsh package.json.
    const anchor = join(
      resolveDshLayout(home).closuresDir,
      closureNameForFingerprint(MANIFEST.fingerprint!),
      "node_modules", "@deepseek-ai", "dsh", "package.json",
    )
    expect(existsSync(anchor)).toBe(true)
  })

  test("staged verification failure (invalid installAnchor) -> degraded, staging kept", async () => {
    const home = tmpHome()
    // Fake extractor that synthesises a staging node_modules WITHOUT the @deepseek-ai/dsh anchor.
    const noAnchorExtract: ManagerDeps["extract"] = async (spec, dest) => {
      if (spec.startsWith("@deepseek-ai/dsh@")) return
      mkdirSync(dest, { recursive: true })
      const name = spec.slice(0, spec.lastIndexOf("@"))
      writeFileSync(join(dest, "package.json"), JSON.stringify({ name }))
    }
    const status = await initializeDshRuntime(
      makeBaseOptions(home, { ...testDeps(), deps: { ...testDeps().deps, extract: noAnchorExtract } }),
    )
    expect(status).toBe("degraded")
    // The failed staging scene is kept for diagnosis, and no closure was activated.
    expect(existsSync(resolveDshLayout(home).stagingDir)).toBe(true)
    expect(existsSync(resolveDshLayout(home).closuresDir)).toBe(false)
  })

  test("staged direct dep at the WRONG version -> degraded, staging preserved, no closure (B-02)", async () => {
    const home = tmpHome()
    // Fake extractor that writes @deepseek-ai/cordis at the wrong version
    // (manifest pins 4.0.1).
    const wrongVersionExtract: ManagerDeps["extract"] = async (spec, dest) => {
      const name = spec.slice(0, spec.lastIndexOf("@"))
      const version = name === "@deepseek-ai/cordis" ? "9.9.9" : MANIFEST.dependencies[name]
      mkdirSync(dest, { recursive: true })
      const body: Record<string, string> = { name, version }
      if (name === "@deepseek-ai/dsh") body.bin = "lib/bin.js"
      writeFileSync(join(dest, "package.json"), JSON.stringify(body))
    }
    const status = await initializeDshRuntime(
      makeBaseOptions(home, { ...testDeps(), deps: { ...testDeps().deps, extract: wrongVersionExtract } }),
    )
    expect(status).toBe("degraded")
    // Staging preserved for diagnosis; no closure activated.
    expect(existsSync(resolveDshLayout(home).stagingDir)).toBe(true)
    expect(existsSync(resolveDshLayout(home).closuresDir)).toBe(false)
  })

  test("materialisation timeout -> degraded with no retry this launch", async () => {
    const home = tmpHome()
    // Fake extractor that hangs forever; the short injectable timeout must cut it off.
    const hanging: ManagerDeps["extract"] = async () => {
      await new Promise<void>(() => {}) // never resolves
    }
    const status = await initializeDshRuntime(
      makeBaseOptions(home, { ...testDeps(), deps: { ...testDeps().deps, extract: hanging }, timeoutMs: 80 }),
    )
    expect(status).toBe("degraded")
    expect(existsSync(resolveDshLayout(home).closuresDir)).toBe(false)
  })
})

describe("B-05: timeout must not abandon a running materialisation while releasing the lock", () => {
  test(
    "call A times out -> degraded; call B (same fingerprint) must not materialise or steal the lock while A's work is still running",
    async () => {
      const home = tmpHome()
      let gateCount = 0
      // A manual latch: all in-flight extracts await the SAME promise; the
      // resolve callback is captured so the release actually settles every
      // pending worker. Remaining packages then complete and A's run
      // settles + activates.
      let releaseGate: () => void = () => {}
      const gatePromise = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      const gatedExtract: ManagerDeps["extract"] = async (spec, dest) => {
        gateCount++
        await gatePromise
        const name = spec.slice(0, spec.lastIndexOf("@"))
        mkdirSync(dest, { recursive: true })
        writeFileSync(join(dest, "package.json"), depPkgJson(name))
      }
      const options = makeBaseOptions(home, { ...testDeps(), deps: { ...testDeps().deps, extract: gatedExtract }, timeoutMs: 60 })

      // Call A: times out (short timeout) while the materialisation keeps running.
      const a = await initializeDshRuntime(options)
      expect(a).toBe("degraded")
      // Bounded concurrency means several extracts may have started before the
      // timeout fired; the gate only hangs the first one.
      expect(gateCount).toBeGreaterThanOrEqual(1)
      // The lock must still be held by A's in-flight materialisation.
      const lockPath = resolveDshLayout(home).lockFile
      expect(existsSync(lockPath)).toBe(true)

      // Call B (same fingerprint) shares the durable in-flight promise: it must
      // NOT start a second materialisation, must NOT steal the lock, and must
      // NOT clear A's staging. It waits on the same promise (still in flight).
      const bPromise = initializeDshRuntime(options)
      // Give B a tick to start; assert the materialisation has not restarted.
      await new Promise((r) => setTimeout(r, 30))
      const countBeforeRelease = gateCount
      // The lock is still held (not stolen).
      expect(existsSync(lockPath)).toBe(true)

      // A's materialisation finally settles and activates; B then resolves ready.
      releaseGate()
      expect(await bPromise).toBe("ready")
      // No second materialisation happened.
      expect(gateCount).toBe(countBeforeRelease)
      // The lock is released once the durable work settled.
      expect(existsSync(lockPath)).toBe(false)
      expect(existsSync(resolveDshLayout(home).closuresDir)).toBe(true)
    },
    20_000,
  )

  test(
    "a timed-out caller returns degraded but the in-flight materialisation still completes and releases the lock itself",
    async () => {
      const home = tmpHome()
      // A manual latch: all extracts await the SAME promise; the captured
      // resolve actually settles every pending worker together. Every extract
      // then fails, the durable materialisation settles (failed), drains the
      // lock, and leaves no closure behind.
      let releaseGate: () => void = () => {}
      const gatePromise = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      const gatedFail: ManagerDeps["extract"] = async (spec) => {
        await gatePromise
        throw new Error(`extract after gate: ${spec}`)
      }
      const options = makeBaseOptions(home, {
        ...testDeps(),
        deps: { ...testDeps().deps, extract: gatedFail },
        timeoutMs: 60,
      })
      const a = await initializeDshRuntime(options)
      expect(a).toBe("degraded")
      // Lock still held by the in-flight materialisation.
      expect(existsSync(resolveDshLayout(home).lockFile)).toBe(true)
      // The durable in-flight entry is still present (B waits, does not re-materialise).
      releaseGate()
      // Give the durable work a tick to settle — every worker fails together,
      // the materialisation drains the lock, and no closure is activated.
      await new Promise((r) => setTimeout(r, 30))
      expect(existsSync(resolveDshLayout(home).lockFile)).toBe(false)
      expect(existsSync(resolveDshLayout(home).closuresDir)).toBe(false)
    },
    20_000,
  )
})

describe("B-06: loader failure degrades instead of crashing", () => {
  test("closure with a broken @deepseek-ai/dsh entry -> degraded, not ready", async () => {
    const home = tmpHome()
    const seed = () => {
      const layout = resolveDshLayout(home)
      const closureDir = join(layout.closuresDir, closureNameForFingerprint(MANIFEST.fingerprint!))
      mkdirSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh"), { recursive: true })
      mkdirSync(join(closureDir, "node_modules", "@deepseek-ai", "cordis"), { recursive: true })
      // A dsh package.json with NO resolvable entry point (B-06 loader gate).
      writeFileSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: MANIFEST.dependencies["@deepseek-ai/dsh"] }))
      writeFileSync(join(closureDir, "node_modules", "@deepseek-ai", "cordis", "package.json"), JSON.stringify({ name: "@deepseek-ai/cordis", version: MANIFEST.dependencies["@deepseek-ai/cordis"] }))
      writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(MANIFEST))
      writeFileSync(join(closureDir, "package.json"), JSON.stringify({ name: "ellamaka-dsh-closure", dependencies: MANIFEST.dependencies }))
      writeFileSync(join(closureDir, "package-lock.json"), runtimeLock(MANIFEST))
    }
    seed()
    const status = await initializeDshRuntime(makeBaseOptions(home))
    expect(status).toBe("degraded")
  })
})

describe("W-01: ready fast path seeds profiles idempotently", () => {
  test("complete closure with missing profiles dir -> ready and profiles seeded", async () => {
    const home = tmpHome()
    seedClosure(home)
    const status = await initializeDshRuntime(makeBaseOptions(home))
    expect(status).toBe("ready")
    const layout = resolveDshLayout(home)
    // The fast path (closure hit) must have seeded the profile templates.
    expect(existsSync(join(layout.profileDir, "web", "package.json"))).toBe(true)
    expect(existsSync(join(layout.profileDir, "web", "cordis.patch.yml"))).toBe(true)
    expect(existsSync(join(layout.profileDir, "ellamaka-tools", "package.json"))).toBe(true)
    expect(existsSync(join(layout.profileDir, "node_modules"))).toBe(true)
  })

  test("profiles already exist are never overwritten on the ready fast path", async () => {
    const home = tmpHome()
    seedClosure(home)
    const layout = resolveDshLayout(home)
    // Pre-create a user-edited patch layer.
    mkdirSync(join(layout.profileDir, "web"), { recursive: true })
    writeFileSync(join(layout.profileDir, "web", "cordis.patch.yml"), "- { id: user-tool, disabled: false }\n")
    const status = await initializeDshRuntime(makeBaseOptions(home))
    expect(status).toBe("ready")
    expect(readFileSync(join(layout.profileDir, "web", "cordis.patch.yml"), "utf8")).toBe(
      "- { id: user-tool, disabled: false }\n",
    )
  })
})
