import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("standalone dsh init removal", () => {
  test("the command implementation and registration are gone", () => {
    const implementation = join(import.meta.dir, "../../../src/cli/cmd/dsh-init.ts")
    const index = readFileSync(join(import.meta.dir, "../../../src/index.ts"), "utf8")
    expect(existsSync(implementation)).toBe(false)
    expect(index).not.toContain("DshInitCommand")
    expect(index).not.toContain(".command(DshInitCommand)")
  })
})
