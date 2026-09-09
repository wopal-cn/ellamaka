import { describe, expect, test } from "bun:test"
import {
  SANDBOX_PRESETS,
  sandboxToPreset,
  presetToSandbox,
  readDshAdapterSandbox,
  hasDshAdapterPlugin,
  patchDshAdapterSandbox,
  promptSandboxMode,
  setPendingSessionSandbox,
  drainPendingSessionSandbox,
  shouldShowSandboxControl,
  type SandboxOptions,
} from "./sandbox-control"

type Spec = string | [string, Record<string, unknown>]

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

describe("dsh-adapter visibility", () => {
  test("detects dsh-adapter in string plugin specs", () => {
    expect(hasDshAdapterPlugin(["file:///x/plugins/dsh-adapter/index.ts"])).toBe(true)
  })

  test("detects dsh-adapter in tuple plugin specs", () => {
    expect(hasDshAdapterPlugin([["file:///x/dsh-adapter/index.ts", { sandbox: { enabled: true } }]])).toBe(true)
  })

  test("rejects plugins without dsh-adapter in the path", () => {
    expect(hasDshAdapterPlugin(["file:///x/plugins/other/index.ts"])).toBe(false)
    expect(hasDshAdapterPlugin([])).toBe(false)
  })

  test("substring dsh-adapter matches, unrelated names do not", () => {
    expect(hasDshAdapterPlugin(["dsh-adapter"])).toBe(true)
    expect(hasDshAdapterPlugin(["adapter-dsh"])).toBe(false)
    expect(hasDshAdapterPlugin(["notdsh-adapterx"])).toBe(true)
  })
})

describe("sandbox control visibility matrix (Issue #221)", () => {
  const plugins = ["file:///x/plugins/dsh-adapter/index.ts"]
  const base = { variant: "dock", plugins }

  test("dock composer + ready runtime + dsh-adapter config shows the control", () => {
    expect(shouldShowSandboxControl({ ...base, dshStatus: "ready" })).toBe(true)
  })

  test("non-dock composer never shows the control", () => {
    for (const variant of ["new-session", "inline", "shell"]) {
      expect(shouldShowSandboxControl({ variant, dshStatus: "ready", plugins })).toBe(false)
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

  test("ready runtime but no dsh-adapter in the effective config hides the control", () => {
    expect(shouldShowSandboxControl({ variant: "dock", dshStatus: "ready", plugins: ["file:///x/other.ts"] })).toBe(false)
    expect(shouldShowSandboxControl({ variant: "dock", dshStatus: "ready", plugins: undefined })).toBe(false)
  })
})

describe("patchDshAdapterSandbox", () => {
  const tupleSpec: Spec = ["file:///x/dsh-adapter/index.ts", { tools: ["bash"], sandbox: { enabled: true } }]

  test("patches sandbox on the dsh-adapter tuple spec and keeps other fields", () => {
    const next = patchDshAdapterSandbox([tupleSpec, "file:///x/other.ts"], { enabled: false })
    expect(next).toEqual([
      ["file:///x/dsh-adapter/index.ts", { tools: ["bash"], sandbox: { enabled: false } }],
      "file:///x/other.ts",
    ])
  })

  test("does not mutate the input config", () => {
    const plugin = [tupleSpec, "file:///x/other.ts"] as const as Spec[]
    patchDshAdapterSandbox(plugin, { enabled: false })
    expect(plugin[0]).toEqual(tupleSpec)
  })

  test("keeps other plugin entries untouched (reference preserved)", () => {
    const other = "file:///x/other.ts"
    const next = patchDshAdapterSandbox([tupleSpec, other], { enabled: true, mode: "read-only" })
    expect(next).toBeDefined()
    if (!next) return
    expect(next[1]).toBe(other)
    expect(next[0]).not.toBe(tupleSpec)
    expect((next[0] as Spec & [string, Record<string, unknown>])[0]).toBe("file:///x/dsh-adapter/index.ts")
  })

  test("adds sandbox when the dsh-adapter spec has options without sandbox", () => {
    const next = patchDshAdapterSandbox([["file:///x/dsh-adapter/index.ts", { tools: ["bash"] }]], {
      enabled: true,
      mode: "read-only",
    })
    expect(next).toEqual([["file:///x/dsh-adapter/index.ts", { tools: ["bash"], sandbox: { enabled: true, mode: "read-only" } }]])
  })

  test("promotes a bare string dsh-adapter spec to a tuple with options", () => {
    const next = patchDshAdapterSandbox(["file:///x/dsh-adapter/index.ts"], { enabled: false })
    expect(next).toEqual([["file:///x/dsh-adapter/index.ts", { sandbox: { enabled: false } }]])
  })

  test("returns undefined when no dsh-adapter spec exists", () => {
    expect(patchDshAdapterSandbox(["file:///x/other.ts"], { enabled: false })).toBeUndefined()
  })

  test("full-access patch drops the mode key", () => {
    const next = patchDshAdapterSandbox([tupleSpec], { enabled: false })
    expect((next![0] as [string, Record<string, unknown>])[1]).toEqual({ tools: ["bash"], sandbox: { enabled: false } })
    expect(Object.keys((next![0] as [string, Record<string, unknown>])[1].sandbox as SandboxOptions)).toEqual([
      "enabled",
    ])
  })
})

describe("readDshAdapterSandbox", () => {
  test("reads sandbox from a tuple spec", () => {
    expect(readDshAdapterSandbox([["file:///x/dsh-adapter/index.ts", { sandbox: { enabled: true, mode: "read-only" } }]])).toEqual({
      enabled: true,
      mode: "read-only",
    })
  })

  test("returns undefined for bare string spec or missing sandbox", () => {
    expect(readDshAdapterSandbox(["file:///x/dsh-adapter/index.ts"])).toBeUndefined()
    expect(readDshAdapterSandbox([["file:///x/dsh-adapter/index.ts", { tools: ["bash"] }]])).toBeUndefined()
    expect(readDshAdapterSandbox(undefined)).toBeUndefined()
  })

  test("ignores malformed sandbox shapes", () => {
    expect(readDshAdapterSandbox([["file:///x/dsh-adapter/index.ts", { sandbox: "nope" }]])).toBeUndefined()
  })

  test("reads the sandbox written by patch (read/patch consistency)", () => {
    const next = patchDshAdapterSandbox(["file:///x/dsh-adapter/index.ts"], { enabled: true, mode: "workspace-write" })
    expect(readDshAdapterSandbox(next)).toEqual({ enabled: true, mode: "workspace-write" })
    expect(sandboxToPreset(readDshAdapterSandbox(next))).toBe("workspace-write")
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