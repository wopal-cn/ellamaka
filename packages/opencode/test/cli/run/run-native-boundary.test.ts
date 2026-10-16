import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("run native/attach boundary", () => {
  test("CLI run disables built-in adoption before any instance bootstrap", () => {
    const source = readFileSync(join(import.meta.dir, "../../../src/index.ts"), "utf8")
    expect(source).toContain('if (command === "run") process.env.ELLAMAKA_DSH = "0"')
    expect(source.indexOf('if (command === "run")')).toBeLessThan(source.indexOf("await Global.ensure()"))
  })
  test("run never mounts DSH and attach does not require a local InstanceRef", () => {
    const source = readFileSync(join(import.meta.dir, "../../../src/cli/cmd/run.ts"), "utf8")
    expect(source).not.toContain("mountDsh")
    expect(source).toContain("instance: (args) => !args.attach")
    expect(source).toContain("args.attach ? Effect.succeed(undefined) : InstanceRef")
    expect(source).not.toContain("const localInstance = yield* InstanceRef")
  })
})
