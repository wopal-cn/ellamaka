import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { scopedEnv } from "./fixture/process-env"

const catalogVariables = [
  "ELLAMAKA_MODELS_URL",
  "ELLAMAKA_MODELS_PATH",
  "ELLAMAKA_MODELS_FALLBACK_PATH",
  "OPENCODE_MODELS_URL",
  "OPENCODE_MODELS_PATH",
] as const

const originalCatalogVariables = new Map(catalogVariables.map((key) => [key, process.env[key]]))

// ELLAMAKA_DSH_TOOLS is a kill switch, default ON (DESIGN-dsh-base.md, constraint
// #11). `ELLAMAKA_DSH_TOOLS=0` disables dsh; unset or any non-"0" value enables it.
describe("ELLAMAKA_DSH_TOOLS kill switch", () => {
  test("enabled when ELLAMAKA_DSH_TOOLS is unset (default on)", () => {
    using environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: undefined })
    void environment
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
  })

  test("disabled when ELLAMAKA_DSH_TOOLS=0", () => {
    using environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: "0" })
    void environment
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(false)
  })

  test("enabled when ELLAMAKA_DSH_TOOLS=1", () => {
    using environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: "1" })
    void environment
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
  })

  test("enabled when ELLAMAKA_DSH_TOOLS is any non-zero value", () => {
    using environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: "true" })
    void environment
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
  })

  test("evaluated at access time, not module load", () => {
    using environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: undefined })
    void environment
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
    environment[Symbol.dispose]()
    using disabled = scopedEnv({ ELLAMAKA_DSH_TOOLS: "0" })
    void disabled
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(false)
  })
})

describe("Ellamaka model catalog configuration", () => {
  afterEach(() => {
    for (const key of catalogVariables) {
      const value = originalCatalogVariables.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("uses the ELLAMAKA catalog variables at access time", () => {
    process.env.OPENCODE_MODELS_URL = "https://legacy.invalid"
    process.env.OPENCODE_MODELS_PATH = "/tmp/legacy-models.json"
    delete process.env.ELLAMAKA_MODELS_URL
    delete process.env.ELLAMAKA_MODELS_PATH
    delete process.env.ELLAMAKA_MODELS_FALLBACK_PATH
    expect(Flag.ELLAMAKA_MODELS_URL).toBeUndefined()
    expect(Flag.ELLAMAKA_MODELS_PATH).toBeUndefined()
    expect(Flag.ELLAMAKA_MODELS_FALLBACK_PATH).toBeUndefined()

    process.env.ELLAMAKA_MODELS_URL = "https://catalog.example.test"
    process.env.ELLAMAKA_MODELS_PATH = "/tmp/ellamaka-models.json"
    process.env.ELLAMAKA_MODELS_FALLBACK_PATH = "/tmp/ellamaka-models-fallback.json"
    expect(Flag.ELLAMAKA_MODELS_URL).toBe("https://catalog.example.test")
    expect(Flag.ELLAMAKA_MODELS_PATH).toBe("/tmp/ellamaka-models.json")
    expect(Flag.ELLAMAKA_MODELS_FALLBACK_PATH).toBe("/tmp/ellamaka-models-fallback.json")
  })

  test("does not expose deprecated OPENCODE catalog flags", () => {
    expect("OPENCODE_MODELS_URL" in Flag).toBe(false)
    expect("OPENCODE_MODELS_PATH" in Flag).toBe(false)
    expect("OPENCODE_DISABLE_MODELS_FETCH" in Flag).toBe(false)
  })
})
