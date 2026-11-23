import { createSignal } from "solid-js"

/**
 * Runtime app version, resolved from the connected server's /global/health
 * response. The web UI is embedded in the CLI binary and cannot read the
 * build-time OPENCODE_VERSION constant directly; it must fetch the version
 * over HTTP. The server health poll writes the resolved version here; the
 * platform.version getter falls back to the static package version when this
 * is still undefined (health not yet resolved or unavailable).
 */
const [version, setVersion] = createSignal<string | undefined>(undefined)

export const appVersion = version
export const setAppVersion = setVersion

/**
 * Resolve the version to surface for a given active server key from a health
 * store. Returns undefined when the server has no health entry or its health
 * carries no version, so callers fall back to the package version instead of
 * retaining a previous server's version.
 */
export function resolveAppVersion(
  health: Record<string, { version?: string } | undefined>,
  key: string,
): string | undefined {
  return health[key]?.version
}

/**
 * Resolve the version surfaced by platform.version: the resolved runtime
 * version when available, otherwise the static package fallback. Mirrors the
 * getter in entry.tsx so the fallback behavior is unit-testable.
 */
export function resolvePlatformVersion(runtime: string | undefined, fallback: string): string {
  return runtime ?? fallback
}
