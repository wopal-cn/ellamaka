import { describe, expect, test } from "bun:test"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { scopedEnv } from "./fixture/process-env"

// ELLAMAKA_DSH_TOOLS is a kill switch, default ON (DESIGN-dsh-base.md, constraint
// #11). `ELLAMAKA_DSH_TOOLS=0` disables dsh; unset or any non-"0" value enables it.
describe("ELLAMAKA_DSH_TOOLS kill switch", () => {
  test("enabled when ELLAMAKA_DSH_TOOLS is unset (default on)", () => {
    using _environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: undefined })
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
  })

  test("disabled when ELLAMAKA_DSH_TOOLS=0", () => {
    using _environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: "0" })
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(false)
  })

  test("enabled when ELLAMAKA_DSH_TOOLS=1", () => {
    using _environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: "1" })
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
  })

  test("enabled when ELLAMAKA_DSH_TOOLS is any non-zero value", () => {
    using _environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: "true" })
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
  })

  test("evaluated at access time, not module load", () => {
    using _defaultEnvironment = scopedEnv({ ELLAMAKA_DSH_TOOLS: undefined })
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
    {
      using _disabledEnvironment = scopedEnv({ ELLAMAKA_DSH_TOOLS: "0" })
      expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(false)
    }
    expect(Flag.ELLAMAKA_DSH_TOOLS).toBe(true)
  })
})

describe("Ellamaka model catalog configuration", () => {
  test("uses the ELLAMAKA catalog variables at access time", () => {
    using _legacyEnvironment = scopedEnv({
      OPENCODE_MODELS_URL: "https://legacy.invalid",
      OPENCODE_MODELS_PATH: "/tmp/legacy-models.json",
      ELLAMAKA_MODELS_URL: undefined,
      ELLAMAKA_MODELS_PATH: undefined,
      ELLAMAKA_MODELS_FALLBACK_PATH: undefined,
    })
    expect(Flag.ELLAMAKA_MODELS_URL).toBeUndefined()
    expect(Flag.ELLAMAKA_MODELS_PATH).toBeUndefined()
    expect(Flag.ELLAMAKA_MODELS_FALLBACK_PATH).toBeUndefined()

    {
      using _catalogEnvironment = scopedEnv({
        ELLAMAKA_MODELS_URL: "https://catalog.example.test",
        ELLAMAKA_MODELS_PATH: "/tmp/ellamaka-models.json",
        ELLAMAKA_MODELS_FALLBACK_PATH: "/tmp/ellamaka-models-fallback.json",
      })
      expect(Flag.ELLAMAKA_MODELS_URL).toBe("https://catalog.example.test")
      expect(Flag.ELLAMAKA_MODELS_PATH).toBe("/tmp/ellamaka-models.json")
      expect(Flag.ELLAMAKA_MODELS_FALLBACK_PATH).toBe("/tmp/ellamaka-models-fallback.json")
    }
  })

  test("does not expose deprecated OPENCODE catalog flags", () => {
    expect("OPENCODE_MODELS_URL" in Flag).toBe(false)
    expect("OPENCODE_MODELS_PATH" in Flag).toBe(false)
    expect("OPENCODE_DISABLE_MODELS_FETCH" in Flag).toBe(false)
  })
})
