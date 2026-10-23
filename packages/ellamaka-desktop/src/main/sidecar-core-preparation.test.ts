import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("Desktop sidecar CorePreparation wiring", () => {
  test("starts the native listener before shared DSH preparation and no longer calls the legacy manager", () => {
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    expect(source).toContain("prepareDshHost")
    expect(source).not.toContain("initializeDshRuntime")
    const listener = source.indexOf("listener = serverListener")
    const mount = source.indexOf("dshInitialization = initializeDsh(command)")
    expect(listener).toBeGreaterThan(-1)
    expect(mount).toBeGreaterThan(listener)
  })

  test("reports server readiness before DSH preparation so the window never waits for DSH", () => {
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    const ready = source.indexOf('parentPort.postMessage({ type: "ready" })')
    const initialize = source.indexOf("dshInitialization = initializeDsh(command)")
    expect(ready).toBeGreaterThan(-1)
    expect(initialize).toBeGreaterThan(ready)
  })

  test("adoption runs the confirmed preparation and waits for the startup attempt", () => {
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    const adoption = source.indexOf("async function adoptLegacyDshHome")
    expect(adoption).toBeGreaterThan(-1)
    const body = source.slice(adoption)
    expect(body).toContain("await dshInitialization?.catch")
    expect(body).toContain("await initializeDsh(command, true)")
  })
})
