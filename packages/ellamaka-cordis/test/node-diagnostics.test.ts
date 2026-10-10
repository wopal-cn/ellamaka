import { describe, expect, test } from "bun:test"
import { initializeNodeDiagnostics } from "../src/runtime/node-diagnostics"

describe("Node diagnostics compatibility", () => {
  test("publishes the missing diagnostic API once", () => {
    const util = { getSystemErrorName: (_code: number) => "ENOENT" } as {
      getSystemErrorName(code: number): string
      getSystemErrorMessage?(code: number): string
    }
    let syncs = 0
    initializeNodeDiagnostics(util, () => {
      syncs++
    })
    expect(util.getSystemErrorMessage?.(-2)).toBe("ENOENT")
    initializeNodeDiagnostics(util, () => {
      syncs++
    })
    expect(syncs).toBe(1)
  })
  test("leaves the native implementation untouched", () => {
    const native = () => "native diagnostic"
    const util = { getSystemErrorName: () => "ENOENT", getSystemErrorMessage: native }
    initializeNodeDiagnostics(util, () => {
      throw new Error("must not sync native exports")
    })
    expect(util.getSystemErrorMessage).toBe(native)
  })
})
