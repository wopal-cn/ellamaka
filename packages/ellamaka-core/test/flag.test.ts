import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@wopal/ellamaka-core/flag/flag"

const catalogVariables = [
  "ELLAMAKA_MODELS_URL",
  "ELLAMAKA_MODELS_PATH",
  "OPENCODE_MODELS_URL",
  "OPENCODE_MODELS_PATH",
] as const

const originalCatalogVariables = new Map(catalogVariables.map((key) => [key, process.env[key]]))

// ELLAMAKA_DSH is a kill switch, default ON (DESIGN-dsh-poc §3.4, constraint
// #11). `ELLAMAKA_DSH=0` disables dsh; unset or any non-"0" value enables it.
describe("ELLAMAKA_DSH kill switch", () => {
  afterEach(() => {
    delete process.env.ELLAMAKA_DSH
  })

  test("enabled when ELLAMAKA_DSH is unset (default on)", () => {
    delete process.env.ELLAMAKA_DSH
    expect(Flag.ELLAMAKA_DSH).toBe(true)
  })

  test("disabled when ELLAMAKA_DSH=0", () => {
    process.env.ELLAMAKA_DSH = "0"
    expect(Flag.ELLAMAKA_DSH).toBe(false)
  })

  test("enabled when ELLAMAKA_DSH=1", () => {
    process.env.ELLAMAKA_DSH = "1"
    expect(Flag.ELLAMAKA_DSH).toBe(true)
  })

  test("enabled when ELLAMAKA_DSH is any non-zero value", () => {
    process.env.ELLAMAKA_DSH = "true"
    expect(Flag.ELLAMAKA_DSH).toBe(true)
  })

  test("evaluated at access time, not module load", () => {
    delete process.env.ELLAMAKA_DSH
    expect(Flag.ELLAMAKA_DSH).toBe(true)
    process.env.ELLAMAKA_DSH = "0"
    expect(Flag.ELLAMAKA_DSH).toBe(false)
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
    expect(Flag.ELLAMAKA_MODELS_URL).toBeUndefined()
    expect(Flag.ELLAMAKA_MODELS_PATH).toBeUndefined()

    process.env.ELLAMAKA_MODELS_URL = "https://catalog.example.test"
    process.env.ELLAMAKA_MODELS_PATH = "/tmp/ellamaka-models.json"
    expect(Flag.ELLAMAKA_MODELS_URL).toBe("https://catalog.example.test")
    expect(Flag.ELLAMAKA_MODELS_PATH).toBe("/tmp/ellamaka-models.json")
  })

  test("does not expose deprecated OPENCODE catalog flags", () => {
    expect("OPENCODE_MODELS_URL" in Flag).toBe(false)
    expect("OPENCODE_MODELS_PATH" in Flag).toBe(false)
    expect("OPENCODE_DISABLE_MODELS_FETCH" in Flag).toBe(false)
  })
})
