import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const packageRoot = join(import.meta.dir, "..", "..", "..")

function productionTypeScriptFiles(root: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...productionTypeScriptFiles(path))
    else if (entry.isFile() && path.endsWith(".ts")) result.push(path)
  }
  return result
}

describe("wopalspace Node runtime compatibility", () => {
  test("shared Space parsers execute in a Node-target bundle", async () => {
    const root = mkdtempSync(join(packageRoot, ".node-runtime-compat-"))
    try {
      const entry = join(root, "entry.ts")
      const assembly = join(packageRoot, "src", "space", "assembly.ts")
      const localConfig = join(packageRoot, "src", "space", "local-config.ts")
      const archetypeSource = `version: 1
type: coding
agents: []
skills: []
rules: []
commands: []
plugins: {}
paths: []
`
      const schemaSource = `version: 1
runtime:
  path: .wopal
  files: []
  dirs: []
space:
  files: []
  dirs: []
`
      const settingsSource = `{"ellamaka":{"plugin":["demo"]}}`
      writeFileSync(
        entry,
        `import { parseArchetypeDocument, parseSpaceSchemaDocument } from ${JSON.stringify(assembly)};\n` +
          `import { declaredPluginNamesFromSettings } from ${JSON.stringify(localConfig)};\n` +
          `const archetype = parseArchetypeDocument(${JSON.stringify(archetypeSource)});\n` +
          `const schema = parseSpaceSchemaDocument(${JSON.stringify(schemaSource)}, "fixture");\n` +
          `const plugins = [...declaredPluginNamesFromSettings(${JSON.stringify(settingsSource)})("ellamaka")];\n` +
          `console.log(JSON.stringify({ archetype, runtimePath: schema.runtime.path, plugins }));\n`,
      )
      const built = await Bun.build({
        entrypoints: [entry],
        outdir: join(root, "out"),
        target: "node",
        format: "esm",
        external: ["yaml", "jsonc-parser"],
      })
      expect(built.success).toBe(true)
      const proc = Bun.spawnSync({
        cmd: ["node", join(root, "out", "entry.js")],
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(proc.stderr.toString()).toBe("")
      expect(proc.exitCode).toBe(0)
      const output: unknown = JSON.parse(proc.stdout.toString())
      if (output === null || typeof output !== "object" || Array.isArray(output)) throw new Error("invalid Node output")
      const archetype = Reflect.get(output, "archetype")
      if (archetype === null || typeof archetype !== "object" || Array.isArray(archetype)) {
        throw new Error("invalid archetype output")
      }
      const manifest = Reflect.get(archetype, "manifest")
      if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("invalid manifest output")
      }
      expect(Reflect.get(archetype, "ok")).toBe(true)
      expect(Reflect.get(manifest, "type")).toBe("coding")
      expect(Reflect.get(output, "runtimePath")).toBe(".wopal")
      expect(Reflect.get(output, "plugins")).toEqual(["demo"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("production WopalSpace sources do not depend on the Bun global", () => {
    const files = productionTypeScriptFiles(join(packageRoot, "src"))
    const offenders = files
      .filter((file) => /\bBun\./.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(packageRoot.length + 1))
    expect(offenders).toEqual([])
  })
})
