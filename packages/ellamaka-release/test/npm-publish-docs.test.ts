import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const currentDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(currentDir, "..", "..", "..")
const sdkDir = join(root, "packages", "sdk", "js")

// The tarball is the only thing an outside consumer can read: documentation
// left in the source tree does not exist for them.
describe("published SDK documentation", () => {
  const manifest = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"))

  test("ships the README and the example sources", () => {
    expect(manifest.files).toContain("README.md")
    expect(manifest.files).toContain("examples")
  })

  test("compiles the examples so plain Node can run them", () => {
    // Node refuses to strip types under node_modules, so a .ts example shipped
    // as-is is unrunnable for the readers who need it most.
    expect(manifest.scripts.build).toContain("build-examples.ts")
    expect(manifest.scripts["typecheck:examples"]).toContain("tsconfig.examples.json")
    expect(existsSync(join(sdkDir, "tsconfig.examples.json"))).toBe(true)
  })

  test("every example source has a compiled counterpart", () => {
    const sources = readdirSync(join(sdkDir, "examples")).filter((file) => file.endsWith(".ts"))
    expect(sources.length).toBeGreaterThan(0)
    for (const source of sources)
      expect(existsSync(join(sdkDir, "dist", "examples", source.replace(/\.ts$/, ".js")))).toBe(true)
  })

  test("documents install, authentication and the error shape", () => {
    const readme = readFileSync(join(sdkDir, "README.md"), "utf8")
    for (const section of ["## Install", "## Authentication", "## Errors", "## Examples"])
      expect(readme).toContain(section)
    // The generated client attaches no credentials by itself; a README that
    // implies otherwise sends every authenticated consumer into a 401.
    expect(readme).toContain("Authorization")
    expect(readme).toContain("throwOnError")
  })

  test("README run commands point at shippable files", () => {
    const readme = readFileSync(join(sdkDir, "README.md"), "utf8")
    const commands = [...readme.matchAll(/@wopal\/ellamaka-sdk\/(dist\/examples\/[a-z-]+\.js)/g)].map(
      (match) => match[1]!,
    )
    // Node refuses to strip types under node_modules, so a run command that
    // points at a .ts file is dead on arrival even though the file ships.
    expect(readme).not.toMatch(/@wopal\/ellamaka-sdk\/examples\//)
    expect(commands.length).toBeGreaterThan(0)
    for (const command of new Set(commands)) expect(existsSync(join(sdkDir, command))).toBe(true)
  })
})
