/**
 * Authentication-failure helpers shared by every error surface (workbench
 * toasts, panel fallbacks, the shell error boundary). The SDK wraps non-2xx
 * responses with `cause: { status }` (error-interceptor.ts), so a rejected
 * call carries its HTTP status structurally — no message string matching.
 */

/** True when the error is an HTTP 401 from the server (stale credentials). */
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const cause = (error as { cause?: unknown }).cause
  if (typeof cause !== "object" || cause === null) return false
  return (cause as { status?: unknown }).status === 401
}

type AuthToastGate = {
  /** Show `toast` unless an identical 401 notice is already active. */
  unauthorized: (toast: () => void) => void
  /** Credential recovery: allow the next 401 to surface again. */
  reset: () => void
}

let sharedGate: AuthToastGate | undefined

/**
 * The app-wide 401 toast gate. One episode — one notification: every 401
 * toast site funnels through this gate so a stale-credential burst surfaces
 * a single notice instead of one toast per failing request. `reset` fires
 * when credentials change (server switch / save) so a future episode
 * notifies again.
 */
export function authToastGate(): AuthToastGate {
  if (!sharedGate) sharedGate = createAuthToastGate()
  return sharedGate
}

/**
 * One 401 means "credentials are stale" — the fact, not its per-request
 * echo, is what the user needs. While the failure persists, the first 401
 * toast is shown and every later one is swallowed (the workbench also raises
 * its dedicated overlay); a recovery resets the gate so a NEW stale episode
 * notifies again.
 */
export function createAuthToastGate(): AuthToastGate {
  let active = false
  return {
    unauthorized(toast) {
      if (active) return
      active = true
      toast()
    },
    reset() {
      active = false
    },
  }
}
