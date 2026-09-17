/**
 * `mountOnboarding` — the zero-intrusion mount entry.
 *
 * Creates one {@link OnboardingService} for the mount's lifetime, assembles
 * the HTTP/SSE router, and registers a `NodeRouteMount` on the host. The host
 * contract is declared structurally (see {@link OnboardingRouteHost}) so this
 * package never imports the host's module graph.
 *
 * @module @wopal/ellamaka-onboarding/mount
 */
import { createOnboardingRouter } from "./router"
import { OnboardingService } from "./service"
import type { NodeRouteMount } from "./types"

export interface OnboardingMountOptions {
  /** WOPAL_HOME path; defaults to the process env and then `~/.wopal`. */
  home?: string
  /** Mount path prefix; defaults to `/api/onboarding`. */
  prefix?: string
  /** Server password used for credential checks (Basic/Bearer/auth_token). */
  serverPassword?: string
  /** Server username; defaults to `ellamaka`. */
  serverUsername?: string
  /**
   * Invoked after `complete()` persists the finished state. The mount point
   * sits above `Server.listen`, outside the Effect runtime, so this hook only
   * carries what the mounting host can act on (Workbench refetches spaces on
   * navigation; no server-side refresh is required for the hot transition).
   */
  onComplete?: () => void | Promise<void>
}

/** The host surface the mount requires (structurally compatible with opencode's Listener). */
export interface OnboardingRouteHost {
  mountNodeRoute(mount: NodeRouteMount): () => void
}

/**
 * Mount the onboarding HTTP surface on a host server.
 *
 * @returns a disposer that unregisters the mount and stops the service's
 * event stream listeners.
 */
export function mountOnboarding(server: OnboardingRouteHost, options: OnboardingMountOptions = {}): () => void {
  const service = new OnboardingService({
    home: options.home,
    onComplete: options.onComplete,
  })

  const router = createOnboardingRouter(service, {
    serverPassword: options.serverPassword,
    serverUsername: options.serverUsername,
  })

  const mount: NodeRouteMount = {
    prefix: options.prefix ?? "/api/onboarding",
    // The mount brings its own complete authentication (auth.ts), so it
    // declares "self" on the host auth stack it bypasses. The host rejects a
    // missing/unknown policy at mount time.
    auth: "self",
    request: (req, res) => router.request(req, res),
  }

  const unmount = server.mountNodeRoute(mount)

  return () => {
    unmount()
    service.events.removeAllListeners()
  }
}
