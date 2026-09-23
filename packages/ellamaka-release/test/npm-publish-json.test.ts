import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { isJsonObject, parseJsonObject, readJsonObject } from "../src/npm/json"

describe("isJsonObject", () => {
  test("accepts plain objects and rejects everything else", () => {
    expect(isJsonObject({})).toBe(true)
    expect(isJsonObject({ a: 1 })).toBe(true)
    expect(isJsonObject(null)).toBe(false)
    expect(isJsonObject([])).toBe(false)
    expect(isJsonObject("{}")).toBe(false)
    expect(isJsonObject(42)).toBe(false)
    expect(isJsonObject(undefined)).toBe(false)
  })
})

describe("parseJsonObject", () => {
  test("parses an object payload", () => {
    expect(parseJsonObject('{"name":"@wopal/ellamaka-sdk"}', "pkg")).toEqual({ name: "@wopal/ellamaka-sdk" })
  })

  test("fails closed on a non-object payload, naming the source", () => {
    expect(() => parseJsonObject("[]", "packages/plugin/package.json")).toThrow(
      /packages\/plugin\/package\.json: expected a JSON object/,
    )
  })
})

describe("readJsonObject", () => {
  test("reads an object manifest from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-npm-json-"))
    try {
      const path = join(dir, "package.json")
      writeFileSync(path, '{"version":"2.0.5"}')
      expect(readJsonObject(path)).toEqual({ version: "2.0.5" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails closed on a malformed manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-npm-json-"))
    try {
      const path = join(dir, "package.json")
      writeFileSync(path, "not json")
      expect(() => readJsonObject(path)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
