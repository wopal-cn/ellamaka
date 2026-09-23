import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  createAuthCheck,
  createBunRuntime,
  createRegistryTarballFetcher,
  packLocalTarball,
  publishPackage,
  type PublishRuntime,
} from "../src/npm/execute"
import { parseJsonObject } from "../src/npm/json"
import type { PublishPlanEntry } from "../src/npm/plan"

// Fixture packages live in an OS temp dir: tests must never touch the real
// workspace packages.
const tempDirs: string[] = []

function fixturePackage(exports: Record<string, unknown> = { ".": "./src/index.ts" }): {
  repoRoot: string
  entry: PublishPlanEntry
} {
  const repoRoot = mkdtempSync(join(tmpdir(), "ellamaka-npm-publish-"))
  tempDirs.push(repoRoot)
  const dir = "packages/plugin"
  mkdirSync(join(repoRoot, dir), { recursive: true })
  writeFileSync(
    join(repoRoot, dir, "package.json"),
    `${JSON.stringify(
      {
        name: "@wopal/ellamaka-plugin",
        version: "2.0.5",
        main: "./dist/index.js",
        exports,
        files: ["dist"],
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  )
  return {
    repoRoot,
    entry: {
      name: "@wopal/ellamaka-plugin",
      version: "2.0.5",
      dir,
      tarball: "wopal-ellamaka-plugin-2.0.5.tgz",
      decision: "publish",
      reason: "not published yet",
    },
  }
}

interface RecordingRuntime extends PublishRuntime {
  commands: string[][]
  /** package.json content observed while each command ran ("" when the cwd has none). */
  manifests: string[]
}

function recordingRuntime(hooks: { onCommand?: (command: string[], cwd: string) => void } = {}): RecordingRuntime {
  const runtime: RecordingRuntime = {
    commands: [],
    manifests: [],
    run(command, options) {
      runtime.commands.push(command)
      const manifest = join(options.cwd, "package.json")
      runtime.manifests.push(existsSync(manifest) ? readFileSync(manifest, "utf8") : "")
      hooks.onCommand?.(command, options.cwd)
    },
  }
  return runtime
}

function manifestPath(repoRoot: string, dir: string): string {
  return join(repoRoot, dir, "package.json")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("publishPackage", () => {
  test("builds, packs into the staging dir, then publishes that tarball", () => {
    const { repoRoot, entry } = fixturePackage()
    const stagingDir = join(repoRoot, ".staging")
    const runtime = recordingRuntime()

    publishPackage(entry, { repoRoot, stagingDir, registry: "https://registry.npmjs.org/", runtime, log: () => {} })

    expect(runtime.commands).toEqual([
      ["bun", "run", "build"],
      ["bun", "pm", "pack", "--destination", stagingDir],
      [
        "npm",
        "publish",
        join(stagingDir, "wopal-ellamaka-plugin-2.0.5.tgz"),
        "--access",
        "public",
        "--registry",
        "https://registry.npmjs.org/",
      ],
    ])
  })

  test("rewrites exports to dist for the duration of pack and publish", () => {
    const { repoRoot, entry } = fixturePackage()
    const stagingDir = join(repoRoot, ".staging")
    const runtime = recordingRuntime()

    publishPackage(entry, { repoRoot, stagingDir, registry: "https://registry.npmjs.org/", runtime, log: () => {} })

    // The build must see the dev shape; pack/publish must see the dist shape.
    expect(runtime.manifests.map((manifest) => parseJsonObject(manifest, "package.json").exports)).toEqual([
      { ".": "./src/index.ts" },
      { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    ])
  })

  test("restores the source package.json byte-for-byte after publishing", () => {
    const { repoRoot, entry } = fixturePackage()
    const path = manifestPath(repoRoot, entry.dir)
    const original = readFileSync(path, "utf8")

    publishPackage(entry, {
      repoRoot,
      stagingDir: join(repoRoot, ".staging"),
      registry: "https://registry.npmjs.org/",
      runtime: recordingRuntime(),
      log: () => {},
    })

    expect(readFileSync(path, "utf8")).toBe(original)
  })

  test("restores the source package.json when publish fails, and rethrows", () => {
    const { repoRoot, entry } = fixturePackage()
    const path = manifestPath(repoRoot, entry.dir)
    const original = readFileSync(path, "utf8")
    const runtime = recordingRuntime({
      onCommand: (command) => {
        if (command[0] === "npm") throw new Error("npm publish failed with exit code 1: E403 Forbidden")
      },
    })

    expect(() =>
      publishPackage(entry, {
        repoRoot,
        stagingDir: join(repoRoot, ".staging"),
        registry: "https://registry.npmjs.org/",
        runtime,
        log: () => {},
      }),
    ).toThrow(/E403/)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  test("never rewrites exports when the build fails", () => {
    const { repoRoot, entry } = fixturePackage()
    const path = manifestPath(repoRoot, entry.dir)
    const original = readFileSync(path, "utf8")
    const runtime = recordingRuntime({
      onCommand: (command) => {
        if (command[0] === "bun") throw new Error("build failed")
      },
    })

    expect(() =>
      publishPackage(entry, {
        repoRoot,
        stagingDir: join(repoRoot, ".staging"),
        registry: "https://registry.npmjs.org/",
        runtime,
        log: () => {},
      }),
    ).toThrow(/build failed/)
    expect(readFileSync(path, "utf8")).toBe(original)
    expect(existsSync(join(repoRoot, entry.dir, "dist"))).toBe(false)
  })

  test("never leaves a rewritten manifest when the publish-time write fails", () => {
    // The restore guard must cover the rewrite write itself, not just the
    // pack/publish commands: a partial write (ENOSPC/EIO) would otherwise
    // leave the package.json with publish-time `exports` that break
    // `typecheck`/`test` for everyone.
    const { repoRoot, entry } = fixturePackage()
    const path = manifestPath(repoRoot, entry.dir)
    const original = readFileSync(path, "utf8")
    const runtime = recordingRuntime()
    let writes = 0

    expect(() =>
      publishPackage(entry, {
        repoRoot,
        stagingDir: join(repoRoot, ".staging"),
        registry: "https://registry.npmjs.org/",
        runtime,
        log: () => {},
        writeManifest: () => {
          writes++
          if (writes === 1) throw new Error("EIO: i/o error, write")
        },
      }),
    ).toThrow(/EIO/)

    expect(writes).toBe(2) // the failed rewrite write + the restoring write
    expect(readFileSync(path, "utf8")).toBe(original)
    // The failure aborts before pack/publish: only the build ran.
    expect(runtime.commands.map((command) => command[0])).toEqual(["bun"])
  })

  test("reports both the publish failure and an unrestorable manifest", () => {
    const { repoRoot, entry } = fixturePackage()
    const attempt = () =>
      publishPackage(entry, {
        repoRoot,
        stagingDir: join(repoRoot, ".staging"),
        registry: "https://registry.npmjs.org/",
        runtime: recordingRuntime(),
        log: () => {},
        writeManifest: () => {
          throw new Error("EACCES: permission denied")
        },
      })

    // The restore failure must not mask why the publish was attempted, and it
    // must tell the operator the file is left rewritten.
    expect(attempt).toThrow(/could not restore .*package\.json.*EACCES.*publish failure was: EACCES/s)
    expect(attempt).toThrow(/restore the file from git/)
  })
})

describe("packLocalTarball", () => {
  test("builds, packs into the staging dir, and returns the packed bytes", () => {
    const { repoRoot, entry } = fixturePackage()
    const stagingDir = join(repoRoot, ".staging")
    const packed = new Uint8Array([1, 2, 3])
    const runtime = recordingRuntime({
      onCommand: (command) => {
        if (command[0] === "bun" && command[1] === "pm") writeFileSync(join(stagingDir, entry.tarball), packed)
      },
    })

    expect(packLocalTarball(entry, { repoRoot, stagingDir, runtime, log: () => {} })).toEqual(packed)
    expect(runtime.commands).toEqual([
      ["bun", "run", "build"],
      ["bun", "pm", "pack", "--destination", stagingDir],
    ])
  })

  test("packs with the publish-time exports rewrite", () => {
    const { repoRoot, entry } = fixturePackage()
    const stagingDir = join(repoRoot, ".staging")
    const runtime = recordingRuntime({
      onCommand: (command) => {
        if (command[0] === "bun" && command[1] === "pm")
          writeFileSync(join(stagingDir, entry.tarball), new Uint8Array())
      },
    })

    packLocalTarball(entry, { repoRoot, stagingDir, runtime, log: () => {} })

    // The build sees the dev shape; the pack must see the dist shape — the same
    // rule `publishPackage` follows, from the same code.
    expect(runtime.manifests.map((manifest) => parseJsonObject(manifest, "package.json").exports)).toEqual([
      { ".": "./src/index.ts" },
      { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
    ])
  })

  test("restores the source package.json byte-for-byte", () => {
    const { repoRoot, entry } = fixturePackage()
    const path = manifestPath(repoRoot, entry.dir)
    const original = readFileSync(path, "utf8")
    const runtime = recordingRuntime({
      onCommand: (command) => {
        if (command[0] === "bun" && command[1] === "pm")
          writeFileSync(join(repoRoot, ".staging", entry.tarball), new Uint8Array())
      },
    })

    packLocalTarball(entry, { repoRoot, stagingDir: join(repoRoot, ".staging"), runtime, log: () => {} })
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  test("requires `bun run build` to have produced the manifest the build expects", () => {
    // `bun pm pack` must run against the rewritten manifest; a runtime that
    // never ran the build still gets the same sequence, so the sequence itself
    // is the assertion above.
    const { repoRoot, entry } = fixturePackage()
    const runtime = recordingRuntime({
      onCommand: (command) => {
        if (command[0] === "bun" && command[1] === "pm")
          writeFileSync(join(repoRoot, ".staging", entry.tarball), new Uint8Array())
      },
    })
    packLocalTarball(entry, { repoRoot, stagingDir: join(repoRoot, ".staging"), runtime, log: () => {} })
    expect(runtime.commands[0]).toEqual(["bun", "run", "build"])
  })

  test("restores the manifest and rethrows when packing fails", () => {
    const { repoRoot, entry } = fixturePackage()
    const path = manifestPath(repoRoot, entry.dir)
    const original = readFileSync(path, "utf8")
    const runtime = recordingRuntime({
      onCommand: (command) => {
        if (command[0] === "bun" && command[1] === "pm") throw new Error("bun pm pack failed with exit code 1")
      },
    })

    expect(() =>
      packLocalTarball(entry, {
        repoRoot,
        stagingDir: join(repoRoot, ".staging"),
        runtime,
        log: () => {},
      }),
    ).toThrow(/bun pm pack failed/)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  test("fails when the packer produced no tarball to read", () => {
    const { repoRoot, entry } = fixturePackage()
    const runtime = recordingRuntime()

    expect(() =>
      packLocalTarball(entry, {
        repoRoot,
        stagingDir: join(repoRoot, ".staging"),
        runtime,
        log: () => {},
      }),
    ).toThrow(/wopal-ellamaka-plugin-2\.0\.5\.tgz/)
  })
})

describe("createRegistryTarballFetcher", () => {
  const registry = "https://registry.example/"

  test("packs the published version out of the registry and returns its bytes", () => {
    const stagingDir = mkdtempSync(join(tmpdir(), "ellamaka-fetch-"))
    tempDirs.push(stagingDir)
    const packed = new Uint8Array([9, 9, 9])
    const runtime = recordingRuntime({
      onCommand: (_command, cwd) => writeFileSync(join(cwd, "wopal-ellamaka-plugin-2.0.5.tgz"), packed),
    })

    const fetch = createRegistryTarballFetcher({ stagingDir, runtime })
    expect(fetch("@wopal/ellamaka-plugin", "2.0.5", registry)).toEqual(packed)
    expect(runtime.commands[0]?.slice(0, 5)).toEqual([
      "npm",
      "pack",
      "@wopal/ellamaka-plugin@2.0.5",
      "--registry",
      registry,
    ])
    expect(runtime.commands[0]?.[5]).toBe("--pack-destination")
  })

  test("fails closed when the registry does not produce a tarball", () => {
    const stagingDir = mkdtempSync(join(tmpdir(), "ellamaka-fetch-"))
    tempDirs.push(stagingDir)
    const fetch = createRegistryTarballFetcher({ stagingDir, runtime: recordingRuntime() })
    expect(() => fetch("@wopal/ellamaka-plugin", "2.0.5", registry)).toThrow(/wopal-ellamaka-plugin-2\.0\.5\.tgz/)
  })

  test("leaves no tarball behind in the staging dir", () => {
    const stagingDir = mkdtempSync(join(tmpdir(), "ellamaka-fetch-"))
    tempDirs.push(stagingDir)
    const runtime = recordingRuntime({
      onCommand: (_command, cwd) => writeFileSync(join(cwd, "wopal-ellamaka-plugin-2.0.5.tgz"), new Uint8Array([1])),
    })

    createRegistryTarballFetcher({ stagingDir, runtime })("@wopal/ellamaka-plugin", "2.0.5", registry)
    expect(readdirSync(stagingDir)).toEqual([])
  })
})

describe("createAuthCheck", () => {
  const registry = "https://registry.npmjs.org/"

  test("passes when the registry knows the user", () => {
    expect(() => createAuthCheck({ whoami: () => true, env: {} })(registry)).not.toThrow()
  })

  test("fails closed with an actionable message when no credential is available", () => {
    expect(() => createAuthCheck({ whoami: () => false, env: {} })(registry)).toThrow(
      /npm login.*NPM_TOKEN|NPM_TOKEN.*OIDC/s,
    )
    expect(() => createAuthCheck({ whoami: () => false, env: {} })(registry)).toThrow(registry)
  })

  test("defers to OIDC trusted publishing when the job grants an id token", () => {
    // `npm whoami` cannot introspect an OIDC identity — the exchange happens
    // inside `npm publish`, so the pre-check must not block the release job.
    expect(() =>
      createAuthCheck({ whoami: () => false, env: { ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.test" } })(registry),
    ).not.toThrow()
  })
})

describe("createBunRuntime", () => {
  test("inherits the terminal so interactive 2FA ceremonies can run", () => {
    // `npm publish` on a security-key/2FA account only drives the browser
    // ceremony when the child process has a TTY on stdin (`npm/lib/utils/
    // auth.js` bails out on `!process.stdin.isTTY` before the web-OTP branch).
    // Bun.spawnSync defaults stdin to /dev/null, which silently turns every
    // interactive publish into a bare "provide --otp" failure — so the
    // inherited stdin must stay pinned here.
    const original = Bun.spawnSync
    const calls: { command: string[]; options?: Record<string, unknown> }[] = []
    Bun.spawnSync = ((command: string[], options?: Record<string, unknown>) => {
      calls.push({ command, options })
      return { exitCode: 0 }
    }) as typeof Bun.spawnSync
    try {
      createBunRuntime().run(["npm", "publish"], { cwd: "/tmp" })
    } finally {
      Bun.spawnSync = original
    }

    expect(calls).toEqual([
      {
        command: ["npm", "publish"],
        options: { cwd: "/tmp", stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      },
    ])
  })
})
