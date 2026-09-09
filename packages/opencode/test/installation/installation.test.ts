import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { findEllamakaArtifact } from "../../src/installation"
import { AppProcess } from "@wopal/ellamaka-core/process"
import { testEffect } from "../lib/effect"
import {
  readJsoncConfig,
  getWorkspaceAutoupdate,
  shouldSkipAutoUpgrade,
  shouldNotifyUpdate,
  isUpdateAvailable,
} from "../../src/cli/upgrade"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const appProcess = AppProcess.layer.pipe(Layer.provide(mockSpawner(spawnHandler)))
  return Installation.layer.pipe(Layer.provide(mockHttpClient(httpHandler)), Layer.provide(appProcess))
}

function makeTempDir() {
  const dir = path.join(tmpdir(), `ellamaka-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ============================================================================
// Layer 1: Pure function tests
// ============================================================================

describe("findEllamakaArtifact", () => {
  const manifest = {
    version: "1.0.0",
    artifacts: [
      { name: "ellamaka-darwin-arm64.tar.gz", os: "darwin", arch: "arm64", url: "https://a", sha256: "a" },
      { name: "ellamaka-darwin-x64.tar.gz", os: "darwin", arch: "x64", url: "https://b", sha256: "b" },
      { name: "ellamaka-darwin-x64-baseline.tar.gz", os: "darwin", arch: "x64", variant: "baseline", url: "https://c", sha256: "c" },
      { name: "ellamaka-linux-x64.tar.gz", os: "linux", arch: "x64", url: "https://d", sha256: "d" },
      { name: "ellamaka-windows-x64.zip", os: "windows", arch: "x64", url: "https://e", sha256: "e" },
    ],
    checksumsUrl: "https://checksums",
  }

  test("prefers exact match without variant", () => {
    const result = findEllamakaArtifact(manifest, "darwin", "arm64")
    expect(result.name).toBe("ellamaka-darwin-arm64.tar.gz")
  })

  test("falls back to variant match when no exact match", () => {
    const result = findEllamakaArtifact(manifest, "darwin", "x64")
    expect(result.name).toBe("ellamaka-darwin-x64.tar.gz")
  })

  test("maps win32 to windows", () => {
    const result = findEllamakaArtifact(manifest, "win32", "x64")
    expect(result.name).toBe("ellamaka-windows-x64.zip")
  })
})

describe("readJsoncConfig", () => {
  test("parses valid JSONC with comments", () => {
    const tmp = makeTempDir()
    const filepath = path.join(tmp, "settings.jsonc")
    writeFileSync(filepath, `{
      // this is a comment
      "ellamaka": {
        "autoupdate": false
      }
    }`)
    const result = readJsoncConfig(filepath)
    expect(result).toEqual({ ellamaka: { autoupdate: false } })
    rmSync(tmp, { recursive: true, force: true })
  })

  test("returns null for invalid JSON", () => {
    const tmp = makeTempDir()
    const filepath = path.join(tmp, "bad.jsonc")
    writeFileSync(filepath, "not json")
    const result = readJsoncConfig(filepath)
    expect(result).toBeNull()
    rmSync(tmp, { recursive: true, force: true })
  })

  test("returns null for non-existent file", () => {
    const result = readJsoncConfig("/nonexistent/path/settings.jsonc")
    expect(result).toBeNull()
  })
})

describe("getWorkspaceAutoupdate", () => {
  test("reads autoupdate: false from settings.jsonc", () => {
    const tmp = makeTempDir()
    const configDir = path.join(tmp, ".wopal", "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "settings.jsonc"), `{ "ellamaka": { "autoupdate": false } }`)

    const result = getWorkspaceAutoupdate(tmp)
    expect(result).toBe(false)
    rmSync(tmp, { recursive: true, force: true })
  })

  test("settings.local.jsonc overrides settings.jsonc", () => {
    const tmp = makeTempDir()
    const configDir = path.join(tmp, ".wopal", "config")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path.join(configDir, "settings.jsonc"), `{ "ellamaka": { "autoupdate": false } }`)
    writeFileSync(path.join(configDir, "settings.local.jsonc"), `{ "ellamaka": { "autoupdate": "notify" } }`)

    const result = getWorkspaceAutoupdate(tmp)
    expect(result).toBe("notify")
    rmSync(tmp, { recursive: true, force: true })
  })

  test("returns undefined when no config files exist", () => {
    const tmp = makeTempDir()
    const result = getWorkspaceAutoupdate(tmp)
    expect(result).toBeUndefined()
    rmSync(tmp, { recursive: true, force: true })
  })

  test("returns undefined when no spaceRoot provided", () => {
    const result = getWorkspaceAutoupdate()
    expect(result).toBeUndefined()
  })
})

// ============================================================================
// Layer 2: Effect integration tests
// ============================================================================

describe("installation method", () => {
  const it = testEffect(
    testLayer(
      () => jsonResponse({}),
      () => "",
    ),
  )

  it.effect("detects wopal install when binary is under .wopal/bin", () =>
    Effect.gen(function* () {
      const originalExecPath = process.execPath
      try {
        Object.defineProperty(process, "execPath", {
          value: "/home/user/.wopal/bin/ellamaka",
          configurable: true,
        })
        const method = yield* Installation.use.method()
        expect(method).toBe("ellamaka")
      } finally {
        Object.defineProperty(process, "execPath", {
          value: originalExecPath,
          configurable: true,
        })
      }
    }),
  )
})

describe("installation latest", () => {
  const manifest = {
    version: "2.0.0",
    artifacts: [
      { name: "ellamaka-darwin-arm64.tar.gz", os: "darwin", arch: "arm64", url: "https://a", sha256: "a" },
    ],
    checksumsUrl: "https://checksums",
  }

  const it = testEffect(
    testLayer((request) => {
      if (request.url.includes("download.coursedao.com/ellamaka/latest/manifest.json")) {
        return jsonResponse(manifest)
      }
      return jsonResponse({})
    }),
  )

  it.effect("reads latest version from ellamaka CDN manifest", () =>
    Effect.gen(function* () {
      const result = yield* Installation.use.latest("ellamaka")
      expect(result).toBe("2.0.0")
    }),
  )
})

describe("installation upgrade", () => {
  const manifest = {
    version: "2.0.0",
    artifacts: [
      { name: "ellamaka-darwin-arm64.tar.gz", os: "darwin", arch: "arm64", url: "https://cd/ellamaka-darwin-arm64.tar.gz", sha256: "abc" },
    ],
    checksumsUrl: "https://checksums",
  }

  const it = testEffect(
    testLayer(
      (request) => {
        if (request.url.includes("download.coursedao.com/ellamaka/v2.0.0/manifest.json")) {
          return jsonResponse(manifest)
        }
        return jsonResponse({})
      },
      (cmd, args) => {
        if (cmd === "bash") return { code: 0, stdout: "INSTALLED:/test/bin/ellamaka", stderr: "" }
        return ""
      },
    ),
  )

  it.effect("upgrades via ellamaka CDN", () =>
    Effect.gen(function* () {
      const result = yield* Installation.use.upgrade("ellamaka", "2.0.0")
      expect(result).toBeUndefined()
    }),
  )

  it.effect("returns typed error on upgrade failure", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Installation.use.upgrade("ellamaka", "9.9.9"))
      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error.stderr).toContain("ellamaka")
    }),
  )
})

describe("shouldSkipAutoUpgrade", () => {
  test("stable latest channel should NOT skip auto-upgrade", () => {
    expect(shouldSkipAutoUpgrade("latest", "1.15.13")).toBe(false)
  })

  test("local channel (dev.sh) should skip auto-upgrade", () => {
    expect(shouldSkipAutoUpgrade("local", "local")).toBe(true)
  })

  test("main channel (dev build) should skip auto-upgrade", () => {
    expect(shouldSkipAutoUpgrade("main", "1.15.13-main.20260731135022")).toBe(true)
  })

  test("unknown preview channel should skip auto-upgrade", () => {
    expect(shouldSkipAutoUpgrade("beta", "1.15.14-beta.1")).toBe(true)
  })
})

describe("shouldNotifyUpdate", () => {
  test("local channel (source checkout) never notifies", () => {
    expect(shouldNotifyUpdate("local", "local", "2.0.5-rc.1")).toBe(false)
  })

  test("local channel never notifies even when a newer release exists", () => {
    expect(shouldNotifyUpdate("local", "0.0.0-local-20260909", "2.0.5-rc.1")).toBe(false)
  })

  test("preview channel build notifies when an update is available", () => {
    expect(shouldNotifyUpdate("main", "1.15.13-main.20260731135022", "2.0.5-rc.1")).toBe(true)
  })

  test("stable channel notifies when an update is available", () => {
    expect(shouldNotifyUpdate("latest", "2.0.4", "2.0.5-rc.1")).toBe(true)
  })

  test("stable channel does not notify when already latest", () => {
    expect(shouldNotifyUpdate("latest", "2.0.5-rc.1", "2.0.5-rc.1")).toBe(false)
  })
})

describe("isUpdateAvailable", () => {
  test("stable version lower than latest returns true", () => {
    expect(isUpdateAvailable("1.15.13", "2.0.0")).toBe(true)
  })

  test("same version returns false", () => {
    expect(isUpdateAvailable("1.15.13", "1.15.13")).toBe(false)
  })

  test("current version higher than latest returns false (dev build ahead of stable)", () => {
    expect(isUpdateAvailable("2.0.2-main.20260813132430", "2.0.1")).toBe(false)
  })

  test("dev prerelease numerically ahead of stable returns false", () => {
    // 2.0.2-main.1 has a higher numeric X.Y.Z than 2.0.1, so it is NOT behind
    expect(isUpdateAvailable("2.0.2-main.1", "2.0.1")).toBe(false)
  })

  test("dev prerelease with lower stable number returns true (newer stable available)", () => {
    expect(isUpdateAvailable("2.0.2-main.1", "2.0.3")).toBe(true)
  })

  test("invalid current version treated as needing update", () => {
    expect(isUpdateAvailable("local", "2.0.0")).toBe(true)
  })
})

describe("getReleaseType", () => {
  test("patch update", () => {
    expect(Installation.getReleaseType("2.0.1", "2.0.2")).toBe("patch")
  })

  test("minor update", () => {
    expect(Installation.getReleaseType("2.0.1", "2.1.0")).toBe("minor")
  })

  test("major update", () => {
    expect(Installation.getReleaseType("2.0.1", "3.0.0")).toBe("major")
  })

  test("prerelease to stable of same numbers is a patch", () => {
    expect(Installation.getReleaseType("2.0.2-main.1", "2.0.2")).toBe("patch")
  })

  test("prerelease numerically ahead of stable is not an upgrade (major/minor/patch still patch)", () => {
    expect(Installation.getReleaseType("2.0.2-main.1", "2.0.1")).toBe("patch")
  })
})