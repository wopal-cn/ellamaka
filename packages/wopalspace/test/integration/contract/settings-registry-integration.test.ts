import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SettingsRegistryBusyError,
  SettingsRegistryInvalidError,
  updateSettingsEntry,
} from "../../../src/settings-registry"

const roots: string[] = []

function workspace(initial: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "wopalspace-settings-"))
  roots.push(root)
  mkdirSync(join(root, "config"), { recursive: true })
  const file = join(root, "config", "settings.jsonc")
  writeFileSync(file, initial)
  return { root, file }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("protected JSONC settings registry", () => {
  test("preserves comments, unknown fields and unrelated entries", () => {
    const { file } = workspace(
      [
        "{",
        "  // keep this comment",
        '  "wopal": { "dsh": { "web": { "enabled": false } } },',
        '  "unrelated": { "kept": true },',
        '  "ontologies": { "existing": { "path": "/old", "upstream": "https://example.invalid/old", "custom": 1 } }',
        "}",
        "",
      ].join("\n"),
    )
    expect(
      updateSettingsEntry(file, ["ontologies", "fresh"], { path: "/new", upstream: "https://example.invalid/new" }),
    ).toBe(true)
    expect(
      updateSettingsEntry(file, ["ontologies", "fresh"], { path: "/new", upstream: "https://example.invalid/new" }),
    ).toBe(false)
    const text = readFileSync(file, "utf8")
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"kept": true')
    expect(text).toContain('"custom": 1')
    expect(text).toContain('"fresh"')
    expect(text).toContain('"wopal"')
  })

  test("creates the file and its parent directory when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "wopalspace-settings-"))
    roots.push(root)
    const file = join(root, "nested", "config", "settings.jsonc")
    updateSettingsEntry(file, ["wopal", "x"], 1)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ wopal: { x: 1 } })
  })

  test("rejects invalid JSONC without replacing the existing bytes", () => {
    const { file } = workspace('{ "broken": ')
    expect(() => updateSettingsEntry(file, ["a"], 1)).toThrow(SettingsRegistryInvalidError)
    expect(readFileSync(file, "utf8")).toBe('{ "broken": ')
  })

  test("reports busy and leaves the file intact when the lock stays held", () => {
    const { file } = workspace("{}\n")
    writeFileSync(file + ".lock", "")
    expect(() => updateSettingsEntry(file, ["a"], 1, { lockTimeoutMs: 25 })).toThrow(SettingsRegistryBusyError)
    expect(readFileSync(file, "utf8")).toBe("{}\n")
    rmSync(file + ".lock", { force: true })
    expect(existsSync(file + ".lock")).toBe(false)
  })

  test("concurrent processes updating different keys do not lose an update", async () => {
    const { root, file } = workspace('{ "ontologies": {} }\n')
    const script = join(root, "update.ts")
    writeFileSync(
      script,
      [
        "const [moduleUrl, target, key, value] = process.argv.slice(2)",
        "const { updateSettingsEntry } = await import(moduleUrl!)",
        'updateSettingsEntry(target!, ["ontologies", key!], { n: Number(value) })',
        "",
      ].join("\n"),
    )
    const moduleUrl = new URL("../../../src/settings-registry.ts", import.meta.url).href
    const children = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn({
        cmd: [process.execPath, script, moduleUrl, file, "key" + index, String(index)],
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const codes = await Promise.all(children.map((child) => child.exited))
    expect(codes).toEqual(Array.from({ length: 8 }, () => 0))
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || !("ontologies" in parsed)) throw new Error("missing ontologies")
    const ontologies: Record<string, unknown> = {}
    const rawOntologies = parsed.ontologies
    if (!rawOntologies || typeof rawOntologies !== "object" || Array.isArray(rawOntologies))
      throw new Error("invalid ontologies")
    for (const [key, entry] of Object.entries(rawOntologies)) ontologies[key] = entry
    expect(Object.keys(ontologies).sort()).toEqual(Array.from({ length: 8 }, (_, index) => "key" + index).sort())
    for (let index = 0; index < 8; index += 1) expect(ontologies["key" + index]).toEqual({ n: index })
  })
})
