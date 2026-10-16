import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("Desktop sidecar CorePreparation wiring", () => {
  test("starts the native listener before shared DSH preparation and no longer calls the legacy manager", () => {
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    expect(source).toContain("prepareDshHost")
    expect(source).not.toContain("initializeDshRuntime")
    const listener = source.indexOf("listener = serverListener")
    const mount = source.indexOf("await mountDshIfPresent(command)")
    expect(listener).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(listener)
  })
})
