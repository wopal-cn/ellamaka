import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { load, resolve } from "./source-ts-loader"

function testRoot(name: string) {
  return mkdtempSync(join(tmpdir(), `${name}-`))
}

function nextResolve(specifier: string) {
  return Promise.resolve({ url: specifier })
}

describe("source-ts-loader", () => {
  test("maps a missing .js plugin import to its TypeScript source", async () => {
    const root = testRoot("source-loader-plugin")
    const source = join(root, ".wopal", "plugins", "wopal-plugin", "src", "rules")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "index.ts"), "export {}")

    const parentURL = pathToFileURL(join(root, ".wopal", "plugins", "wopal-plugin", "src", "index.ts")).href
    const result = await resolve("./rules/index.js", { parentURL }, nextResolve)

    expect(result.url).toBe(pathToFileURL(join(source, "index.ts")).href)
  })

  test("maps a missing .js skill import to its TypeScript source", async () => {
    const root = testRoot("source-loader-skill")
    const source = join(root, ".wopal", "skills", "example", "scripts")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "shared.ts"), "export {}")

    const parentURL = pathToFileURL(join(source, "entry.ts")).href
    const result = await resolve("./shared.js", { parentURL }, nextResolve)

    expect(result.url).toBe(pathToFileURL(join(source, "shared.ts")).href)
  })

  test("keeps an existing JavaScript import and all non-plugin source untouched", async () => {
    const root = testRoot("source-loader-boundary")
    const pluginSource = join(root, ".wopal", "plugins", "example", "src")
    mkdirSync(pluginSource, { recursive: true })
    writeFileSync(join(pluginSource, "shared.js"), "export {}")
    writeFileSync(join(pluginSource, "shared.ts"), "export {}")

    const pluginParent = pathToFileURL(join(pluginSource, "entry.ts")).href
    const existing = await resolve("./shared.js", { parentURL: pluginParent }, nextResolve)
    expect(existing.url).toBe("./shared.js")

    const cordisParent = pathToFileURL(join(root, "packages", "ellamaka-cordis", "src", "entry.ts")).href
    const outside = await resolve("./shared.js", { parentURL: cordisParent }, nextResolve)
    expect(outside.url).toBe("./shared.js")
  })
})

describe("source-ts-loader load hook", () => {
  test("transforms TypeScript parameter properties for Node", async () => {
    const root = testRoot("source-loader-transform")
    const source = join(root, ".wopal", "plugins", "example", "src", "index.ts")
    mkdirSync(join(root, ".wopal", "plugins", "example", "src"), { recursive: true })
    writeFileSync(
      source,
      "export class A { constructor(private readonly value: string) {} get() { return this.value } }\n",
    )
    const loaded: { format: string; source: string } = await load(pathToFileURL(source).href, {}, nextResolve)
    expect(loaded.format).toBe("module")
    expect(loaded.source).toContain("this.value = value")
    expect(loaded.source).not.toContain("private readonly value")
  })
})
