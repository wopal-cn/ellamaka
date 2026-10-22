// Pure helpers for the chat composer sandbox tri-state control. The mode is a
// PER-SESSION choice: kept in browser storage keyed by session, carried on the
// prompt payload, and never written to settings files. The space-level
// `effective.wopal.pluginConfig["dsh-adapter"].sandbox` value is the fallback
// when a session has no explicit choice.
//
//   read-only        → { enabled: true, mode: "read-only" }
//   workspace-write  → { enabled: true, mode: "workspace-write" }
//   full-access      → { enabled: false } (sandbox off; adapter default)
// The adapter is built into Ellamaka; behavior settings come from
// config-v2's pluginConfig table, independently of external plugin declarations.

export type SandboxPreset = "read-only" | "workspace-write" | "full-access"

export type SandboxOptions = {
  enabled: boolean
  mode?: string
}

export const SANDBOX_PRESETS: SandboxPreset[] = ["read-only", "workspace-write", "full-access"]

export function sandboxToPreset(cfg?: SandboxOptions): SandboxPreset {
  if (!cfg?.enabled) return "full-access"
  if (cfg.mode === "read-only") return "read-only"
  return "workspace-write"
}

export function presetToSandbox(preset: SandboxPreset): SandboxOptions {
  if (preset === "full-access") return { enabled: false }
  return { enabled: true, mode: preset }
}

export function isSandboxPreset(value: unknown): value is SandboxPreset {
  return typeof value === "string" && (SANDBOX_PRESETS as string[]).includes(value)
}

export function readSandboxOptions(sandbox: unknown): SandboxOptions | undefined {
  if (typeof sandbox !== "object" || sandbox === null) return undefined
  if (!("enabled" in sandbox) || typeof sandbox.enabled !== "boolean") return undefined
  return {
    enabled: sandbox.enabled,
    ...("mode" in sandbox && typeof sandbox.mode === "string" ? { mode: sandbox.mode } : {}),
  }
}

export function sandboxControlConfig(effective?: {
  wopal?: { pluginConfig?: Record<string, Record<string, unknown>> }
}): { sandbox?: unknown } {
  return {
    sandbox: effective?.wopal?.pluginConfig?.["dsh-adapter"]?.sandbox,
  }
}

// The wire value for a per-message sandbox choice. `full-access` folds to the
// adapter's disable semantics server-side; the wire value stays the preset so
// forks and history render the user's actual selection.
export function promptSandboxMode(preset: SandboxPreset): string {
  return preset
}

// Session-scoped in-memory tracker for the choice made in a composer whose
// session was not created yet at selection time (new-session composers). The
// submit flow drains it once the session exists, mirroring
// session-model-tracker. UI state itself persists via Persist.workspace.
export const NEW_SESSION_SANDBOX_KEY = "new-session-composer"

const pendingSessionSandbox = new Map<string, SandboxPreset>()

export function setPendingSessionSandbox(sessionKey: string, preset: SandboxPreset) {
  pendingSessionSandbox.set(sessionKey, preset)
}

export function drainPendingSessionSandbox(sessionKey: string): SandboxPreset | undefined {
  const preset = pendingSessionSandbox.get(sessionKey)
  if (preset) pendingSessionSandbox.delete(sessionKey)
  return preset
}

// The sandbox tri-state selector is visible only when the DSH sandbox is a
// runtime fact, not a config string (Issue #221). All of these must hold:
//   1. The composer is a dock composer (`variant === "dock"`).
//   2. The DSH runtime is `ready` — the kill switch is open (`ELLAMAKA_DSH`
//      not `0`, which maps to `disabled`) AND the runtime materialised and
//      mounted successfully (not `degraded`). `ready` therefore implies the
//      kill switch check.
//   3. The instance-level config enables the built-in adapter sandbox. `sandbox.enabled: false`
//      idles the adapter's tool projection — no sandbox mode is in force, so
//      there is nothing to select. Only `enabled: true` (with the mode as the
//      space default) shows the control.
// The DSH runtime status is the terminal status reported by /global/health.
export type DshRuntimeStatus = "disabled" | "preparing" | "ready" | "degraded"

export function shouldShowSandboxControl(input: {
  variant: string | undefined
  dshStatus: DshRuntimeStatus | undefined
  sandbox?: unknown
}): boolean {
  if (input.variant !== "dock") return false
  if (input.dshStatus === undefined) return false
  // Kill switch: `disabled` means `ELLAMAKA_DSH=0`; any other status means the
  // switch is open. `ready` additionally proves the runtime actually works.
  if (input.dshStatus === "disabled") return false
  if (input.dshStatus !== "ready") return false
  // Sandbox off (or unconfigured) idles the adapter: no mode to choose.
  return readSandboxOptions(input.sandbox)?.enabled === true
}

// "Allow always" on a sandbox-escalation approval card writes a standing
// allow rule for the escalated mode, so the session effectively runs under
// that mode from then on. The composer's tri-state selector must reflect
// that — it is the only visible sandbox state. The approval dock publishes
// the escalated mode here TOGETHER WITH the session the approval belongs to,
// and the composer (which owns the persisted choice) applies it only when the
// session matches its own. Escalation grants are session-scoped on the engine
// side, so the linkage must not leak the mode into other sessions.
const escalationListeners = new Map<string, Set<(preset: SandboxPreset) => void>>()

export function publishEscalatedSandboxPreset(sessionID: string, preset: SandboxPreset) {
  const listeners = escalationListeners.get(sessionID)
  if (!listeners) return
  // Snapshot subscriptions so callbacks may safely unsubscribe while notifying.
  const current = [...listeners]
  for (const listener of current) listener(preset)
}

export function subscribeEscalatedSandboxPreset(
  sessionID: string,
  listener: (preset: SandboxPreset) => void,
): () => void {
  let listeners = escalationListeners.get(sessionID)
  if (!listeners) {
    listeners = new Set()
    escalationListeners.set(sessionID, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = escalationListeners.get(sessionID)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) escalationListeners.delete(sessionID)
  }
}
