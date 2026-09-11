/**
 * Exact sidecar-only environment keys. These belong exclusively to the sidecar
 * utility process (delivered via createSidecarEnv / utilityProcess.fork env)
 * and must never leak into the main process's process.env or any other process
 * in the desktop tree.
 *
 * The engine consumes a root switch and many OPENCODE_EXPERIMENTAL_* flags
 * beyond the two the desktop explicitly injects, so those are matched by
 * predicate (see isExperimentalKey / isSidecarOnlyOpencodeKey) rather than
 * enumerated here.
 */
export const SIDECAR_ONLY_OPENCODE_KEYS: readonly string[] = [
  "ELLAMAKA_SERVER_USERNAME",
  "ELLAMAKA_SERVER_PASSWORD",
  "OPENCODE_CLIENT",
  "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
]

/**
 * The engine's root experimental toggle (no trailing underscore) and the flag
 * prefix. Both are read via Config from process.env inside the sidecar (see
 * packages/opencode/src/effect/runtime-flags.ts).
 */
const ROOT_EXPERIMENTAL_KEY = "OPENCODE_EXPERIMENTAL"
const OPENCODE_EXPERIMENTAL_PREFIX = "OPENCODE_EXPERIMENTAL_"

/**
 * True for the root `OPENCODE_EXPERIMENTAL` switch or any `OPENCODE_EXPERIMENTAL_*`
 * flag. These are sidecar-only engine switches.
 */
export function isExperimentalKey(key: string): boolean {
  return key === ROOT_EXPERIMENTAL_KEY || key.startsWith(OPENCODE_EXPERIMENTAL_PREFIX)
}

/**
 * Returns true when a key is sidecar-only: a credential, the client identity,
 * the embedded-web-ui switch, or any experimental engine switch (root or
 * prefixed).
 */
export function isSidecarOnlyOpencodeKey(key: string): boolean {
  return SIDECAR_ONLY_OPENCODE_KEYS.includes(key) || isExperimentalKey(key)
}

/**
 * Returns a copy of the given env object with every sidecar-only OPENCODE key
 * removed. Used to keep a merged shell/app env clean before it is written back
 * to the main process's process.env. Matches experimental switches by predicate
 * so the root switch and any engine flag (known or future) are covered.
 */
export function stripSidecarOpencodeEnv(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isSidecarOnlyOpencodeKey(key)) next[key] = value
  }
  return next
}

// Captured user-configured experimental switches. preferAppEnv records the
// experimental values it strips from the main process here so createSidecarEnv
// can forward them to the sidecar instead of silently dropping them (D-03:
// move to createSidecarEnv, never discard). Module-level state is the cleanest
// hand-off from startup (preferAppEnv) to the later sidecar spawn, which runs
// through SidecarSupervisor's injected spawn factory.
let capturedExperimentalConfig: Record<string, string> = {}

/**
 * Records the user's experimental switch values from a merged shell/app env so
 * they can later be forwarded to the sidecar. Called by preferAppEnv before it
 * strips those keys from the main process.
 */
export function captureSidecarExperimentalConfig(env: Record<string, string>): void {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (isExperimentalKey(key)) next[key] = value
  }
  capturedExperimentalConfig = next
}

/**
 * Returns the captured user experimental config (a copy). createSidecarEnv
 * overlays these on top of the desktop defaults so user intent wins.
 */
export function getCapturedSidecarExperimentalConfig(): Record<string, string> {
  return { ...capturedExperimentalConfig }
}

/**
 * Deletes the sidecar credentials from the current process.env. ServerAuth
 * captures the auth config from ConfigProvider.fromEnv() during Server.listen,
 * so this is safe to call immediately after listen returns — and required so
 * engine PTY children (which forward ...process.env) never inherit the
 * credentials.
 */
export function clearSidecarCredentials(): void {
  delete process.env.ELLAMAKA_SERVER_PASSWORD
  delete process.env.ELLAMAKA_SERVER_USERNAME
}

/**
 * Awaits the sidecar's Server.listen and clears the credentials only after it
 * settles (resolve or reject). ServerAuth snapshots process.env via
 * ConfigProvider.fromEnv() during listen, so the credentials must be present
 * for the whole listen call and removed immediately afterwards. Extracting
 * this ordering makes the "clear after listen" contract independently testable
 * without importing sidecar.ts (which depends on process.parentPort at module
 * top level).
 */
export async function listenThenClearCredentials<T>(listen: () => Promise<T>): Promise<T> {
  try {
    return await listen()
  } finally {
    clearSidecarCredentials()
  }
}
