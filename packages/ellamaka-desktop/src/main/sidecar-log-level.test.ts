import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { currentSidecarLogLevel, resetSidecarLogLevelForTest, setSidecarLogLevel } from "./sidecar-log-level"

/**
 * The sidecar's single level hub: `sidecar.ts` maps every DSH host through
 * `toDshLogLevel(currentSidecarLogLevel())` and re-targets the engine log
 * live from this value, so a reader that bypasses the hub cannot stay in sync
 * (rook W-03 regression guard).
 */
describe("sidecar log level hub", () => {
  beforeEach(resetSidecarLogLevelForTest)

  test("starts at INFO and reflects every setSidecarLogLevel", () => {
    expect(currentSidecarLogLevel()).toBe("INFO")
    setSidecarLogLevel("DEBUG")
    expect(currentSidecarLogLevel()).toBe("DEBUG")
    setSidecarLogLevel("WARN")
    expect(currentSidecarLogLevel()).toBe("WARN")
    setSidecarLogLevel("ERROR")
    expect(currentSidecarLogLevel()).toBe("ERROR")
  })

  test("resets to the module default for test isolation", () => {
    setSidecarLogLevel("DEBUG")
    resetSidecarLogLevelForTest()
    expect(currentSidecarLogLevel()).toBe("INFO")
  })
})

/**
 * The toggle wiring (rook re-review W-01): the sidecar's `setLogLevel`
 * message path must drive the hub, the engine `Log.setLevel`, AND the
 * process-tree `ELLAMAKA_LOG_LEVEL` write-back. Storage-helper tests alone
 * would pass even if `sidecar.ts` stopped using the hub.
 *
 * The seam is `handleSidecarMessage` — the same function the module-scope
 * `parentPort.on("message")` binding calls — because bun shares one module
 * registry across test files and the port binding happens in whichever file
 * imports `sidecar.ts` first. The `virtual:opencode-server` mock overrides
 * the preload's registration for this file; `Log.setLevel` is only needed at
 * message time, never at import time.
 */
/**
 * The engine `Log.setLevel` spy lives in the preload's `virtual:opencode-server`
 * shim (`__mockDshSetLevelCalls`): a per-file `mock.module` override cannot
 * re-patch the specifier once another test file has materialized it, so the
 * recording shim is part of the shared preload mock instead.
 */
type MockGlobal = { __mockDshSetLevelCalls?: string[] }
const setLevelCalls = () => (globalThis as unknown as MockGlobal).__mockDshSetLevelCalls ?? []

// sidecar.ts reads process.parentPort at module scope; stub it at module top
// level (same pattern as sidecar-install-command.test.ts) before importing.
;(process as unknown as { parentPort: unknown }).parentPort = {
  postMessage: () => {},
  on: () => {},
}

const sidecarPromise = import("./sidecar")

describe("sidecar setLogLevel message wiring", () => {
  const savedEnv = process.env.ELLAMAKA_LOG_LEVEL

  beforeEach(() => {
    ;(globalThis as unknown as MockGlobal).__mockDshSetLevelCalls = []
  })

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ELLAMAKA_LOG_LEVEL
    else process.env.ELLAMAKA_LOG_LEVEL = savedEnv
    resetSidecarLogLevelForTest()
  })

  test("a setLogLevel message updates hub, engine level and the process-tree env", async () => {
    const { handleSidecarMessage } = await sidecarPromise

    handleSidecarMessage({ type: "setLogLevel", level: "DEBUG" })
    // setLogLevel awaits the virtual module import; give the microtask a beat.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(currentSidecarLogLevel()).toBe("DEBUG")
    expect(setLevelCalls()).toEqual(["DEBUG"])
    expect(process.env.ELLAMAKA_LOG_LEVEL).toBe("DEBUG")
  })

  test("an invalid level message is rejected before touching the hub", async () => {
    const { handleSidecarMessage } = await sidecarPromise

    handleSidecarMessage({ type: "setLogLevel", level: "VERBOSE" })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(currentSidecarLogLevel()).toBe("INFO")
    expect(setLevelCalls()).toEqual([])
  })
})
