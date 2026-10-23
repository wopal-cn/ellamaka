import { describe, expect, test } from "bun:test"
import {
  SANDBOX_PRESETS,
  sandboxToPreset,
  presetToSandbox,
  readSandboxOptions,
  sandboxControlConfig,
  promptSandboxMode,
  setPendingSessionSandbox,
  drainPendingSessionSandbox,
  shouldShowSandboxControl,
  publishEscalatedSandboxPreset,
  subscribeEscalatedSandboxPreset,
  type SandboxPreset,
} from "./sandbox-control"

describe("sandbox preset mapping", () => {
  test("SANDBOX_PRESETS is the fixed tri-state list", () => {
    expect(SANDBOX_PRESETS).toEqual(["read-only", "workspace-write", "full-access"])
  })

  test("enabled + read-only maps to read-only", () => {
    expect(sandboxToPreset({ enabled: true, mode: "read-only" })).toBe("read-only")
  })

  test("enabled + workspace-write maps to workspace-write", () => {
    expect(sandboxToPreset({ enabled: true, mode: "workspace-write" })).toBe("workspace-write")
  })

  test("enabled without or with unknown mode falls back to workspace-write", () => {
    expect(sandboxToPreset({ enabled: true })).toBe("workspace-write")
    expect(sandboxToPreset({ enabled: true, mode: "danger-full-access" })).toBe("workspace-write")
  })

  test("disabled maps to full-access regardless of stale mode", () => {
    expect(sandboxToPreset({ enabled: false })).toBe("full-access")
    expect(sandboxToPreset({ enabled: false, mode: "read-only" })).toBe("full-access")
  })

  test("undefined config shows full-access (sandbox off is the adapter default)", () => {
    expect(sandboxToPreset(undefined)).toBe("full-access")
  })

  test("preset to sandbox round-trips read-only and workspace-write", () => {
    expect(presetToSandbox("read-only")).toEqual({ enabled: true, mode: "read-only" })
    expect(presetToSandbox("workspace-write")).toEqual({ enabled: true, mode: "workspace-write" })
  })

  test("full-access omits mode entirely", () => {
    expect(presetToSandbox("full-access")).toEqual({ enabled: false })
    expect(presetToSandbox("full-access")).not.toHaveProperty("mode")
  })

  test("round trip is stable for every preset", () => {
    for (const preset of SANDBOX_PRESETS) {
      expect(sandboxToPreset(presetToSandbox(preset))).toBe(preset)
    }
  })
})

describe("sandbox control visibility matrix (Issue #221)", () => {
  const base = { variant: "dock", sandbox: { enabled: true, mode: "read-only" } }

  test("dock composer + ready runtime + sandbox-enabled dsh-adapter config shows the control", () => {
    expect(shouldShowSandboxControl({ ...base, dshStatus: "ready" })).toBe(true)
  })

  test("the internal adapter uses config-v2 sandbox data and keeps the configured default", () => {
    expect(shouldShowSandboxControl({ ...base, dshStatus: "ready" })).toBe(true)
    expect(sandboxToPreset(base.sandbox)).toBe("read-only")
  })

  test("non-dock composer never shows the control", () => {
    for (const variant of ["new-session", "inline", "shell"]) {
      expect(shouldShowSandboxControl({ variant, dshStatus: "ready", sandbox: base.sandbox })).toBe(false)
    }
  })

  test("unknown runtime status (probe pending/undefined) hides the control", () => {
    expect(shouldShowSandboxControl({ ...base, dshStatus: undefined })).toBe(false)
  })

  test("kill switch closed (disabled) hides the control even with config declared", () => {
    expect(shouldShowSandboxControl({ ...base, dshStatus: "disabled" })).toBe(false)
  })

  test("degraded runtime hides the control even with config declared", () => {
    expect(shouldShowSandboxControl({ ...base, dshStatus: "degraded" })).toBe(false)
  })

  test("preparing runtime hides the control (not yet ready)", () => {
    expect(shouldShowSandboxControl({ ...base, dshStatus: "preparing" })).toBe(false)
  })

  test("ready runtime shows the internal adapter without an external plugin list", () => {
    expect(shouldShowSandboxControl({ variant: "dock", dshStatus: "ready", sandbox: base.sandbox })).toBe(true)
  })

  test("sandbox disabled hides the control: the adapter idles the tool projection", () => {
    expect(
      shouldShowSandboxControl({
        variant: "dock",
        dshStatus: "ready",
        sandbox: { enabled: false, mode: "workspace-write" },
      }),
    ).toBe(false)
  })

  test("dsh-adapter without a sandbox option hides the control (absent means off)", () => {
    expect(shouldShowSandboxControl({ variant: "dock", dshStatus: "ready" })).toBe(false)
  })
})

describe("config-v2 sandbox inputs", () => {
  test("reads the internal adapter configuration independently of external plugin declarations", () => {
    const effective = {
      ellamaka: { plugin: ["file:///x/plugins/wopal-plugin"] },
      wopal: { pluginConfig: { "dsh-adapter": { sandbox: { enabled: true, mode: "read-only" } } } },
    }
    const inputs = sandboxControlConfig(effective)
    expect(inputs).toEqual({ sandbox: { enabled: true, mode: "read-only" } })
    expect(shouldShowSandboxControl({ variant: "dock", dshStatus: "ready", ...inputs })).toBe(true)
    expect(sandboxToPreset(readSandboxOptions(inputs.sandbox))).toBe("read-only")
  })

  test("returns no sandbox config when the pluginConfig entry is missing", () => {
    expect(sandboxControlConfig({ wopal: { pluginConfig: {} } })).toEqual({ sandbox: undefined })
    expect(readSandboxOptions({ enabled: "yes" })).toBeUndefined()
  })
})

describe("per-message sandbox mode", () => {
  test("promptSandboxMode carries the preset verbatim", () => {
    for (const preset of SANDBOX_PRESETS) {
      expect(promptSandboxMode(preset)).toBe(preset)
    }
  })

  test("pending tracker set/drain round-trips per composer key", () => {
    setPendingSessionSandbox("composer:new-1", "read-only")
    expect(drainPendingSessionSandbox("composer:new-1")).toBe("read-only")
    expect(drainPendingSessionSandbox("composer:new-1")).toBeUndefined()
  })

  test("pending tracker keys are independent and drain clears only the hit key", () => {
    setPendingSessionSandbox("composer:new-2", "workspace-write")
    setPendingSessionSandbox("composer:new-3", "full-access")
    expect(drainPendingSessionSandbox("composer:new-2")).toBe("workspace-write")
    expect(drainPendingSessionSandbox("composer:new-2")).toBeUndefined()
    expect(drainPendingSessionSandbox("composer:new-3")).toBe("full-access")
    expect(drainPendingSessionSandbox("composer:new-4")).toBeUndefined()
  })
})

describe("escalation preset bus (session-scoped)", () => {
  test("publish routes the preset only to listeners subscribed to the same session", () => {
    const seenA: SandboxPreset[] = []
    const seenB: SandboxPreset[] = []
    const unA = subscribeEscalatedSandboxPreset("ses-a", (preset) => seenA.push(preset))
    const unB = subscribeEscalatedSandboxPreset("ses-b", (preset) => seenB.push(preset))
    try {
      publishEscalatedSandboxPreset("ses-a", "workspace-write")
      expect(seenA).toEqual(["workspace-write"])
      expect(seenB).toEqual([])

      publishEscalatedSandboxPreset("ses-b", "full-access")
      expect(seenA).toEqual(["workspace-write"])
      expect(seenB).toEqual(["full-access"])
    } finally {
      unA()
      unB()
    }
  })

  test("unsubscribed listeners no longer receive publishes", () => {
    const seen: SandboxPreset[] = []
    const unsubscribe = subscribeEscalatedSandboxPreset("ses-x", (preset) => seen.push(preset))
    unsubscribe()
    publishEscalatedSandboxPreset("ses-x", "read-only")
    expect(seen).toEqual([])
  })

  test("publishing to a session with no subscriber is a no-op", () => {
    const seen: SandboxPreset[] = []
    const unsubscribe = subscribeEscalatedSandboxPreset("ses-x", (preset) => seen.push(preset))
    try {
      expect(() => publishEscalatedSandboxPreset("ses-unknown", "full-access")).not.toThrow()
      expect(seen).toEqual([])
    } finally {
      unsubscribe()
    }
  })
})
