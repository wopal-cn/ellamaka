import { describe, expect, test } from "bun:test"
import { resolveWorkbenchRuntimeStatus } from "./workbench-runtime"
import {
  advanceWorkbenchServerIdentity,
  resolveWorkbenchServerIdentity,
  shouldTriggerCleanup,
} from "./workbench-sidecar-cleanup"

describe("resolveWorkbenchRuntimeStatus", () => {
  test("returns online when health and the latest event stream are connected", () => {
    expect(resolveWorkbenchRuntimeStatus(true, "connected")).toBe("online")
  })
  test("keeps the overlay state for unavailable health regardless of event status", () => {
    expect(resolveWorkbenchRuntimeStatus(false, "connected")).toBe("offline")
  })
  test("reports reconnecting only while the latest stream is actually reconnecting", () => {
    expect(resolveWorkbenchRuntimeStatus(true, "reconnecting")).toBe("degraded")
    expect(resolveWorkbenchRuntimeStatus(true, "connecting")).toBe("recovering")
  })
})

// ── WorkbenchSidecarCleanupBinding: shouldTriggerCleanup decision logic ──
// The component's effect delegates to this pure function. Tests cover the
// full transition matrix including the regression case where the first
// non-empty key (initial sidecar ready, generation 0→1) must NOT trigger
// cleanup.

describe("shouldTriggerCleanup", () => {
  test("undefined → undefined does not trigger (before any server connects)", () => {
    expect(shouldTriggerCleanup(undefined, undefined)).toBe(false)
  })

  test("undefined → first non-empty key does not trigger (initial sidecar ready, generation 0→1)", () => {
    expect(shouldTriggerCleanup(undefined, "http://127.0.0.1:12345#gen1")).toBe(false)
  })

  test("same key does not trigger (no-op re-render)", () => {
    expect(shouldTriggerCleanup("http://127.0.0.1:12345#gen1", "http://127.0.0.1:12345#gen1")).toBe(false)
  })

  test("non-empty → different non-empty triggers cleanup (sidecar restart, generation 1→2)", () => {
    expect(shouldTriggerCleanup("http://127.0.0.1:12345#gen1", "http://127.0.0.1:12345#gen2")).toBe(true)
  })

  test("non-empty → undefined does not trigger (server disconnect, not a restart)", () => {
    expect(shouldTriggerCleanup("http://127.0.0.1:12345#gen1", undefined)).toBe(false)
  })

  test("URL switch on Web triggers cleanup", () => {
    expect(shouldTriggerCleanup("http://server-a:8080", "http://server-b:8080")).toBe(true)
  })
})

describe("resolveWorkbenchServerIdentity", () => {
  test("waits for the first authoritative sidecar generation", () => {
    expect(
      resolveWorkbenchServerIdentity({
        key: "sidecar",
        current: {
          type: "sidecar",
          variant: "base",
          http: { url: "http://127.0.0.1:12345" },
        },
      }),
    ).toBeUndefined()
  })

  test("uses the live sidecar generation instead of the stable desktop alias", () => {
    expect(
      resolveWorkbenchServerIdentity({
        key: "sidecar",
        current: {
          type: "sidecar",
          variant: "base",
          generation: 2,
          http: { url: "http://127.0.0.1:12345" },
        },
      }),
    ).toBe("http://127.0.0.1:12345#gen2")
  })

  test("keeps the selected key for regular HTTP servers", () => {
    expect(
      resolveWorkbenchServerIdentity({
        key: "http://server.example.test",
        current: { type: "http", http: { url: "http://server.example.test" } },
      }),
    ).toBe("http://server.example.test")
  })

  test("keeps the last generation across a temporary missing connection", () => {
    const lost = advanceWorkbenchServerIdentity("http://127.0.0.1:12345#gen1", undefined)
    expect(lost).toEqual({ key: "http://127.0.0.1:12345#gen1", triggerCleanup: false })

    expect(advanceWorkbenchServerIdentity(lost.key, "http://127.0.0.1:12345#gen2")).toEqual({
      key: "http://127.0.0.1:12345#gen2",
      triggerCleanup: true,
    })
  })
})
