/**
 * The app-wide toast entry for server errors. Every 401 funnel through here:
 * the first stale-credential episode raises one notice, the per-request
 * echoes are swallowed while the failure persists (the workbench overlay and
 * error-boundary guide carry the recovery flow), and saving fresh
 * credentials re-arms the gate (server.tsx `add`/`setActive`). Non-401
 * toasts pass through untouched.
 *
 * `showToast` stays the raw primitive for non-server UI feedback; import
 * `showServerToast` where the toast may be triggered by a rejected server
 * call.
 */
import { showToast } from "@wopal/ui/toast"
import { authToastGate, isUnauthorizedError } from "@/utils/auth-error"

type ToastInput = Parameters<typeof showToast>[0]

export function showServerToast(input: ToastInput, error?: unknown): void {
  if (error !== undefined && isUnauthorizedError(error)) {
    authToastGate().unauthorized(() => showToast(input))
    return
  }
  showToast(input)
}
