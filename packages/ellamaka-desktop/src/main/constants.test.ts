import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { join } from "node:path"

// constants.ts evaluates import.meta.env.ELLAMAKA_CHANNEL at module load time,
// so each scenario runs in a fresh bun subprocess (with the electron mock
// preload) rather than importing the module into this test process.
const PACKAGE_ROOT = join(import.meta.dir, "../..")
const ELECTRON_MOCK = join(PACKAGE_ROOT, "electron-mock.ts")

const ENV_KEYS = ["ELLAMAKA_CHANNEL"] as const

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
    if (!(ENV_KEYS as readonly string[]).includes(key)) env[key] = value
  }
  return { ...env, ...overrides }
}

type ConstantsShape = { channel: string; updaterEnabled: boolean }

const EVAL = `
  import { CHANNEL, UPDATER_ENABLED } from "./src/main/constants.ts"
  console.log(JSON.stringify({ channel: CHANNEL, updaterEnabled: UPDATER_ENABLED }))
`

function readConstants(overrides: Record<string, string>): ConstantsShape {
  const result = spawnSync({
    cmd: ["bun", "--preload", ELECTRON_MOCK, "-e", EVAL],
    cwd: PACKAGE_ROOT,
    env: childEnv(overrides),
  })
  if (result.exitCode !== 0) {
    throw new Error(`constants subprocess exited ${result.exitCode}: ${result.stderr.toString()}`)
  }
  const lines = result.stdout.toString().trim().split("\n")
  return JSON.parse(lines[lines.length - 1] ?? "{}")
}

describe("desktop channel constants", () => {
  test("stable channel resolves to stable and enables the updater", () => {
    const shape = readConstants({ ELLAMAKA_CHANNEL: "stable" })
    expect(shape.channel).toBe("stable")
    expect(shape.updaterEnabled).toBe(true)
  })

  test("beta channel resolves to beta and enables the updater", () => {
    const shape = readConstants({ ELLAMAKA_CHANNEL: "beta" })
    expect(shape.channel).toBe("beta")
    expect(shape.updaterEnabled).toBe(true)
  })

  test("main channel resolves to main and disables the updater", () => {
    const shape = readConstants({ ELLAMAKA_CHANNEL: "main" })
    expect(shape.channel).toBe("main")
    expect(shape.updaterEnabled).toBe(false)
  })

  test("local channel resolves to local and disables the updater", () => {
    const shape = readConstants({ ELLAMAKA_CHANNEL: "local" })
    expect(shape.channel).toBe("local")
    expect(shape.updaterEnabled).toBe(false)
  })

  test("out-of-vocabulary channel folds to local", () => {
    const shape = readConstants({ ELLAMAKA_CHANNEL: "prod" })
    expect(shape.channel).toBe("local")
    expect(shape.updaterEnabled).toBe(false)
  })
})
