import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "bun"

// build-env.ts evaluates environment at module load time (top-level awaits,
// Bun.file reads, Bun-only APIs), so it is exercised by spawning a fresh bun
// subprocess per scenario rather than importing it into this test process.
const PACKAGE_ROOT = `${import.meta.dir}/..`

const ENV_KEYS = [
  "ELLAMAKA_VERSION",
  "ELLAMAKA_RELEASE",
  "ELLAMAKA_CHANNEL",
  "ELLAMAKA_BUILD_ID",
  "OPENCODE_VERSION",
  "OPENCODE_RELEASE",
  "OPENCODE_CHANNEL",
  "OPENCODE_BUILD_ID",
  "OPENCODE_BUMP",
] as const

const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) savedEnv[key] = process.env[key]

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Drop every build-interface variable so only the explicit overrides leak
    // into the child — a stale OPENCODE_*/ELLAMAKA_* in the parent must never
    // skew the resolution under test.
    if (!(ENV_KEYS as readonly string[]).includes(key)) env[key] = value
  }
  return { ...env, ...overrides }
}

type ScriptShape = {
  channel: string
  version: string
  release: boolean
  preview: boolean
}

const SCRIPT_EVAL = `
  import { Script } from "./src/build-env.ts"
  console.log(JSON.stringify({
    channel: Script.channel,
    version: Script.version,
    release: Script.release,
    preview: Script.preview,
  }))
`

function readScript(overrides: Record<string, string>): ScriptShape {
  const result = spawnSync({
    cmd: ["bun", "-e", SCRIPT_EVAL],
    cwd: PACKAGE_ROOT,
    env: childEnv(overrides),
  })
  if (result.exitCode !== 0) {
    throw new Error(`build-env subprocess exited ${result.exitCode}: ${result.stderr.toString()}`)
  }
  const lines = result.stdout.toString().trim().split("\n")
  const shape: ScriptShape = JSON.parse(lines[lines.length - 1]!)
  return shape
}

function expectScriptFail(overrides: Record<string, string>): void {
  const result = spawnSync({
    cmd: ["bun", "-e", SCRIPT_EVAL],
    cwd: PACKAGE_ROOT,
    env: childEnv(overrides),
  })
  expect(result.exitCode).not.toBe(0)
}

const RELEASE = { ELLAMAKA_RELEASE: "1" }

describe("build-env: release build channel derivation (D-03)", () => {
  test("X.Y.Z derives stable", () => {
    const script = readScript({ ...RELEASE, ELLAMAKA_VERSION: "2.0.5" })
    expect(script.release).toBe(true)
    expect(script.channel).toBe("stable")
    expect(script.version).toBe("2.0.5")
  })

  test("X.Y.Z-rc.N derives stable", () => {
    const script = readScript({ ...RELEASE, ELLAMAKA_VERSION: "2.0.5-rc.3" })
    expect(script.channel).toBe("stable")
    expect(script.version).toBe("2.0.5-rc.3")
  })

  test("X.Y.Z-beta.N derives beta", () => {
    const script = readScript({ ...RELEASE, ELLAMAKA_VERSION: "2.0.5-beta.1" })
    expect(script.channel).toBe("beta")
    expect(script.version).toBe("2.0.5-beta.1")
  })

  test("release builds are not preview", () => {
    const script = readScript({ ...RELEASE, ELLAMAKA_VERSION: "2.0.5" })
    expect(script.preview).toBe(false)
  })

  test("consistent ELLAMAKA_CHANNEL is accepted", () => {
    const script = readScript({ ...RELEASE, ELLAMAKA_VERSION: "2.0.5-beta.1", ELLAMAKA_CHANNEL: "beta" })
    expect(script.channel).toBe("beta")
  })

  test("fail-closed: ELLAMAKA_CHANNEL=stable mismatches 2.0.5-beta.1", () => {
    expectScriptFail({ ...RELEASE, ELLAMAKA_VERSION: "2.0.5-beta.1", ELLAMAKA_CHANNEL: "stable" })
  })

  test("fail-closed: ELLAMAKA_CHANNEL=beta mismatches 2.0.5", () => {
    expectScriptFail({ ...RELEASE, ELLAMAKA_VERSION: "2.0.5", ELLAMAKA_CHANNEL: "beta" })
  })
})

describe("build-env: local build channel resolution", () => {
  test("ELLAMAKA_CHANNEL=main is honored", () => {
    const script = readScript({ ELLAMAKA_CHANNEL: "main" })
    expect(script.release).toBe(false)
    expect(script.channel).toBe("main")
    expect(script.preview).toBe(true)
  })

  test("ELLAMAKA_CHANNEL=local is honored", () => {
    const script = readScript({ ELLAMAKA_CHANNEL: "local" })
    expect(script.channel).toBe("local")
  })

  test("out-of-vocabulary ELLAMAKA_CHANNEL=prod is rejected", () => {
    expectScriptFail({ ELLAMAKA_CHANNEL: "prod" })
  })

  test("missing ELLAMAKA_CHANNEL falls back to local", () => {
    const script = readScript({})
    expect(script.channel).toBe("local")
  })

  test("legacy OPENCODE_CHANNEL is no longer read", () => {
    const script = readScript({ OPENCODE_CHANNEL: "main" })
    expect(script.channel).toBe("local")
  })

  test("injected ELLAMAKA_VERSION is preserved", () => {
    const script = readScript({ ELLAMAKA_CHANNEL: "main", ELLAMAKA_VERSION: "2.0.6-main.202609171200" })
    expect(script.version).toBe("2.0.6-main.202609171200")
  })

  test("missing ELLAMAKA_VERSION produces a dev version for local builds", () => {
    const script = readScript({ ELLAMAKA_CHANNEL: "local" })
    expect(script.version).toMatch(/^0\.0\.0-local-/)
  })
})
