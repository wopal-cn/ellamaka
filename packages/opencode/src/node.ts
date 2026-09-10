export { Config } from "@/config/config"
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export * as Log from "@wopal/ellamaka-core/util/log"
export { Database } from "@/storage/db"
export { JsonMigration } from "@/storage/json-migration"

// DSH runtime wiring surface (DESIGN-ellamaka-dsh §3.4): the unified Runtime
// Manager, the default embedded manifest, the install-anchor resolver, the
// closure module loader, and the web/tool container mount entry points. The
// Desktop sidecar consumes these through `virtual:opencode-server` (declared
// in `packages/ellamaka-desktop/src/main/env.d.ts`), so the Bridge ships
// compiled inside the sidecar bundle while the `@deepseek-ai/*` runtime is
// loaded at startup from the materialised closure.
export { initializeDshRuntime, DEFAULT_DSH_RUNTIME_MANIFEST, resolveInstallAnchor } from "@wopal/ellamaka-cordis/runtime"
export type { InstallAnchor } from "@wopal/ellamaka-cordis/runtime"
export { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
export type { DshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
export { bootDshWeb, bootDshTools } from "@wopal/ellamaka-cordis/dsh-web"
export type { DshWebHost, DshToolsHost } from "@wopal/ellamaka-cordis/dsh-web"
export { startDshPluginService } from "@wopal/ellamaka-cordis/plugins/runtime"
export type {
  DshPluginContainer,
  DshPluginServiceHandle,
  DshPluginServiceOptions,
} from "@wopal/ellamaka-cordis/plugins/runtime"
// The install-command decision table is shared with the CLI mount
// (`dsh-mount.ts`), so the Desktop sidecar resolves its launcher through the
// same rules instead of keeping a second, drifting copy. The sidecar is the
// one host that sets `allowEngineFallback`, because neither its `execPath`
// (Electron's helper) nor its `argv[1]` (this bundle) can run `dsh plugin`.
export { resolveInstallCommand } from "@wopal/ellamaka-cordis/plugins/install-command"
export type { InstallCommandProbe } from "@wopal/ellamaka-cordis/plugins/install-command"
// The sidecar publishes the mount-computed authenticated entry on the same
// process-singleton holder the CLI mount uses, so the `/workbench/dsh-url`
// endpoint answers with the launch-token URL in Desktop mode too.
export { setDshUrlGetter } from "@/workbench/dsh-url"
// The sidecar publishes the Runtime Manager's terminal status on the same
// process-singleton holder the CLI mount uses, so `/global/health` answers
// with a runtime fact in Desktop mode too.
export { setDshStatus } from "@/workbench/dsh-status"
export type { DshRuntimeStatus } from "@/workbench/dsh-status"
