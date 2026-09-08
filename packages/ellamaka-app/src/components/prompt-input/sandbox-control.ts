// Pure helpers for the chat composer sandbox tri-state control. The mode is a
// PER-SESSION choice: kept in browser storage keyed by session, carried on the
// prompt payload, and never written to settings files. The space-level
// `ellamaka.dsh.sandbox` default (read from the dsh-adapter plugin spec) is
// the fallback when a session has no explicit choice.
//
//   read-only        → { enabled: true, mode: "read-only" }
//   workspace-write  → { enabled: true, mode: "workspace-write" }
//   full-access      → { enabled: false } (sandbox off; adapter default)
// Specs follow ConfigPlugin.Spec: a plugin is either a string url or a
// [url, options] tuple, and `plugin` is an array of such specs.

export type SandboxPreset = "read-only" | "workspace-write" | "full-access"

export type SandboxOptions = {
  enabled: boolean
  mode?: string
}

export type PluginSpec = string | [string, Record<string, unknown>]

export const SANDBOX_PRESETS: SandboxPreset[] = ["read-only", "workspace-write", "full-access"]

const DSH_ADAPTER_MARKER = "dsh-adapter"

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

function isTupleSpec(spec: PluginSpec): spec is [string, Record<string, unknown>] {
  return Array.isArray(spec)
}

function specUrl(spec: PluginSpec): string {
  return isTupleSpec(spec) ? spec[0] : spec
}

function isDshAdapterSpec(spec: PluginSpec): boolean {
  return specUrl(spec).includes(DSH_ADAPTER_MARKER)
}

export function hasDshAdapterPlugin(plugins: PluginSpec[] | undefined): boolean {
  if (!plugins) return false
  return plugins.some(isDshAdapterSpec)
}

export function readDshAdapterSandbox(plugins: PluginSpec[] | undefined): SandboxOptions | undefined {
  const spec = plugins?.find(isDshAdapterSpec)
  if (!spec || !isTupleSpec(spec)) return undefined
  const options = spec[1]
  const sandbox = options?.sandbox
  if (typeof sandbox !== "object" || sandbox === null) return undefined
  const record = sandbox as Record<string, unknown>
  if (typeof record.enabled !== "boolean") return undefined
  return {
    enabled: record.enabled,
    ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
  }
}

// Space-default writer. The composer does NOT call this (session choices
// never touch settings files); it stays for future space-default editing
// surfaces. Minimal-patch semantics: only the dsh-adapter spec's `sandbox`
// key changes; every other plugin entry and option field keeps its reference.
export function patchDshAdapterSandbox(
  plugins: PluginSpec[],
  sandbox: SandboxOptions,
): PluginSpec[] | undefined {
  const index = plugins.findIndex(isDshAdapterSpec)
  if (index < 0) return undefined
  const next = [...plugins]
  const spec = plugins[index]
  const options: Record<string, unknown> = isTupleSpec(spec) ? { ...spec[1] } : {}
  options.sandbox = { ...sandbox }
  if (!isTupleSpec(spec)) {
    next[index] = [spec, options]
  } else {
    next[index] = [spec[0], options]
  }
  return next
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
// runtime fact, not a config string (Issue #221). All three must hold:
//   1. The composer is a dock composer (`variant === "dock"`).
//   2. The DSH runtime is `ready` — the kill switch is open (`ELLAMAKA_DSH`
//      not `0`, which maps to `disabled`) AND the runtime materialised and
//      mounted successfully (not `degraded`). `ready` therefore implies the
//      kill switch check; `dshEnabled` is kept explicit for clarity.
//   3. The instance-level (directory) effective config loads dsh-adapter.
// The DSH runtime status is the terminal status reported by /global/health.
export type DshRuntimeStatus = "disabled" | "preparing" | "ready" | "degraded"

export function shouldShowSandboxControl(input: {
  variant: string | undefined
  dshStatus: DshRuntimeStatus | undefined
  plugins: PluginSpec[] | undefined
}): boolean {
  if (input.variant !== "dock") return false
  if (input.dshStatus === undefined) return false
  // Kill switch: `disabled` means `ELLAMAKA_DSH=0`; any other status means the
  // switch is open. `ready` additionally proves the runtime actually works.
  if (input.dshStatus === "disabled") return false
  if (input.dshStatus !== "ready") return false
  return hasDshAdapterPlugin(input.plugins)
}

// "Allow always" on a sandbox-escalation approval card writes a standing
// allow rule for the escalated mode, so the session effectively runs under
// that mode from then on. The composer's tri-state selector must reflect
// that — it is the only visible sandbox state. The approval dock publishes
// the escalated mode here and the composer (which owns the persisted choice)
// subscribes and applies it as if the user had picked it by hand.
const escalationListeners = new Set<(preset: SandboxPreset) => void>()

export function publishEscalatedSandboxPreset(preset: SandboxPreset) {
  for (const listener of escalationListeners) listener(preset)
}

export function subscribeEscalatedSandboxPreset(listener: (preset: SandboxPreset) => void): () => void {
  escalationListeners.add(listener)
  return () => escalationListeners.delete(listener)
}