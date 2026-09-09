/** @jsx h */
import { createResource, type JSX } from "solid-js"
import h from "solid-js/h"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { useWorkbenchState } from "./view-store"

/**
 * Loopback hosts are the same physical server under different names
 * (localhost / 127.0.0.1 / ::1). The backend mints its authenticated entry on
 * the address it bound (127.0.0.1) while the frontend SDK may remember the
 * server URL on localhost; a literal origin comparison would discard a valid
 * launch-token entry as "different origin". Normalize loopback hosts before
 * comparing so the token entry is honored across alias spellings.
 */
function sameOrigin(a: URL, b: URL): boolean {
  if (a.origin !== b.origin) {
    const loopback = (url: URL) =>
      url.protocol === "http:" || url.protocol === "https:"
        ? url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
        : false
    if (!(loopback(a) && loopback(b)) || a.protocol !== b.protocol || a.port !== b.port) return false
  }
  return true
}

/**
 * Derive the DSH iframe URL from the active server URL. The DSH web UI is
 * mounted under the backend origin's `/dsh/` path (single-port scheme,
 * DESIGN-dsh-poc §2.1).
 *
 * rc.1 browser-auth: the mounted engine publishes an authenticated entry
 * (launch-token URL, `/workbench/dsh-url` endpoint). The entry wins when it
 * shares the iframe's target origin; otherwise — engine disabled, not yet
 * mounted, or stale server info — the plain `/dsh/` derivation is the
 * fallback (browser-auth disabled deployments).
 *
 * `pageOrigin` retargets the iframe onto the serving page's origin. Each
 * serving surface owns a `/dsh` proxy, so the browser-auth cookie stays on
 * the iframe's same origin through its token exchange and API requests.
 */
export function dshIframeSrc(
  serverUrl: string | undefined,
  authenticatedEntry?: string,
  pageOrigin?: string,
): string | undefined {
  if (!serverUrl) return undefined
  const targetOrigin = pageOrigin ?? new URL(serverUrl).origin
  if (authenticatedEntry) {
    try {
      const entry = new URL(authenticatedEntry)
      if (sameOrigin(entry, new URL(targetOrigin))) return authenticatedEntry
      if (sameOrigin(entry, new URL(serverUrl)) && pageOrigin) {
        return targetOrigin + entry.pathname + entry.search
      }
    } catch {
      // Malformed entry — fall through to the plain derivation.
    }
  }
  return new URL("/dsh/", targetOrigin).toString()
}

/**
 * The DSH iframe: embeds the DSH web UI under the backend origin's `/dsh/`
 * path. Absent a DSH closure the iframe simply won't connect.
 */
export function DshIframe(props: { src?: string }): JSX.Element {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-v2-background-bg-deep">
      <iframe
        title="DSH"
        src={props.src}
        class="h-full w-full border-0"
        allow="clipboard-write; clipboard-read"
      />
    </div>
  )
}

/**
 * Visibility styles for the keep-alive swap. Both layers stay mounted; only
 * display toggles, so the iframe never reloads and DSH session state survives
 * tab switches. Visible layer participates in layout (`contents`); hidden
 * layer drops out of layout (`none`) so the iframe cannot intercept input.
 */
export function dshSurfaceStyle(visible: boolean): { display: string } {
  return { display: visible ? "contents" : "none" }
}

/**
 * The DSH surface replaces the Assistant (general) tab content. The iframe is
 * mounted once and kept alive (visibility toggle only) so DSH session state
 * survives tab switches, mirroring the Space Keep-Alive invariant. It covers
 * the full content area below the titlebar, including the SpaceRail — the DSH
 * UI ships its own sidebar.
 */
export function DshSurface(props: { children: JSX.Element }): JSX.Element {
  const wb = useWorkbenchState()
  const server = useServer()
  const sdk = useServerSDK()
  const platform = usePlatform()
  const [entry] = createResource(
    () => wb.dshVisible,
    (visible) => (visible ? sdk.client.workbench.dshUrl() : undefined),
  )
  // The packaged desktop renderer lives on the privileged `oc://renderer`
  // origin, where Chromium refuses WebSocket URLs; the DSH realtime channel
  // needs WebSocket, so the iframe targets the main-process standard-HTTP
  // proxy instead. Dev desktop (http://localhost:5173) and serve mode use
  // the serving page origin directly.
  const pageOrigin = () => {
    if (globalThis.location?.protocol === "oc:") return platform.dshProxyOrigin
    return globalThis.location?.origin
  }
  const src = () => dshIframeSrc(server.current?.http.url, entry()?.data?.url, pageOrigin())
  const visible = () => wb.dshVisible
  return (
    <>
      <div style={dshSurfaceStyle(visible())}>
        <DshIframe src={src()} />
      </div>
      <div style={dshSurfaceStyle(!visible())}>{props.children}</div>
    </>
  )
}
