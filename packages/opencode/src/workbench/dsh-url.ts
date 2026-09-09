import { Context, Layer } from "effect"

/**
 * The authenticated DSH iframe entry for the Workbench.
 *
 * The dsh web engine carries the official rc.1 browser-auth flow: the iframe
 * must enter through a launch-token URL (the exchange mints a persistent
 * signed cookie). The token belongs to the dsh web container's `connection`
 * service, which exists only inside the serve process after `mountDshEngine`
 * succeeds — so the mount publishes its entry getter here, and the
 * `/workbench/dsh-url` endpoint reads it per request. The endpoint answers
 * `url: undefined` before the mount or when the engine is disabled; the
 * frontend falls back to the plain `/dsh/` derivation (browser-auth disabled
 * deployments).
 *
 * The holder owns no token state: the mount's `DshWebHost.authenticatedPath`
 * is computed on read, and this module only stores the per-process getter
 * reference. The CLI mount side (a plain async function outside any Effect
 * runtime) uses `setDshUrlGetter` directly — the same process-singleton shape
 * as `globalThis.__ellamakaDshContainer`; handlers reach the same state
 * through the typed service below.
 */

const holder: { get: () => string | undefined } = { get: () => undefined }

/** Publish (or clear with `() => undefined`) the mount-computed entry getter. */
export function setDshUrlGetter(get: () => string | undefined): void {
  holder.get = get
}

/** The authenticated entry path getter; undefined before a mount fills it. */
export function getDshUrl(): string | undefined {
  return holder.get()
}

export class WorkbenchDshUrl extends Context.Service<WorkbenchDshUrl, {
  /** The authenticated entry path getter; undefined before a mount fills it. */
  readonly get: () => string | undefined
}>()("@opencode/WorkbenchDshUrl") {}

/** Thin adapter over the module-level holder for Effect handlers. */
export const layer: Layer.Layer<WorkbenchDshUrl> = Layer.succeed(
  WorkbenchDshUrl,
  WorkbenchDshUrl.of({ get: getDshUrl }),
)
