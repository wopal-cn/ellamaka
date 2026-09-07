/**
 * Mount a dsh profile onto an existing cordis context (single container).
 *
 * The host replays the dsh `boot()` sequence on the caller's context instead
 * of creating a second container. Two entry points share one core:
 *
 * - {@link mountDshWeb} loads the `web` profile (dsh-base + dsh-web-app) and
 *   binds the dsh NATIVE webserver to a second loopback port — the surface
 *   the Workbench iframe embeds. The port is chosen by the caller (explicit,
 *   or `0` for an OS-assigned port).
 * - {@link mountDshTools} loads the `ellamaka-tools` profile (dsh-base with
 *   the agent-loop-only plugins disabled) with NO webserver — the pure tool
 *   backend the dsh-adapter drives with a lightweight per-call context.
 *
 * dsh source is untouched and community plugins keep working.
 *
 * @module @wopal/ellamaka-cordis/dsh-web
 */
import type { Context } from "@deepseek-ai/cordis"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createCordisLogExporter, type EllamakaLogLevel } from "./log-bridge.js"
import { VirtualWebServer, DSH_MOUNT_PREFIX } from "./dsh-virtual-webserver.js"
import {
  createPackageDshRuntimeApi,
  type DshRuntimeApi,
} from "./runtime/loader.js"
import { composeFullPatchStack, healPluginsModuleFallback, resolveUserBundleNames, type DshPluginStackContext } from "./plugins/compose.js"
import { createBunHmr } from "./plugins/bun-hmr.js"
import { wrapInternalWithProfilesFallback } from "./plugins/resolve-specifiers.js"
import { dshHomeDirOf } from "./runtime/status.js"
import { homePatches as makeHomePatches, webExtraPatches, toolsExtraPatches } from "./diagnostics/dump-config.js"
import type { Entry } from "@deepseek-ai/cordis-plugin-loader"

/** The bundled web profile: dsh-base + dsh-web-app. */
const WEB_PROFILE_NAME = "web"
/** The tool-container profile: dsh-base with agent-loop plugins disabled. */
const TOOLS_PROFILE_NAME = "ellamaka-tools"

const require = createRequire(import.meta.url)

/**
 * Select the patch-file watcher from the capability that the running loader
 * actually exposes. Electron utility processes may run Node without its
 * private ESM loader even when their fork arguments contain
 * `--expose-internals`; the official HMR plugin rejects that shape.
 */
export function selectUserPatchHmr(input: { isBun: boolean; loaderInternal: unknown }): "adapter" | "official" {
  return input.isBun || input.loaderInternal === undefined ? "adapter" : "official"
}



/**
 * Shipped agent-preset composition (rc.1): the preset roster is owned by the
 * official `agent-presets` row in the dsh-web-app bundle — `default: standard`,
 * the shipped set bundled inside `@deepseek-ai/dsh-agent-presets`
 * (`includeShippedRoot`), and the harness-home user root derived from the
 * `dshHomePath` service this mount provides (pointed at `home/`). rc.2-era
 * hosts assembled an anchor-relative `config/agent-presets` root by hand; rc.1
 * removed that directory and the host-side assembly with it.
 */

/**
 * Default patch layer for the `ellamaka-tools` profile. Written on first
 * mount (never afterwards — user edits win), so the disable list lives in the
 * user-owned profile file, not in code.
 *
 * The tool container is a pure tool backend: the dsh-adapter drives its tools
 * with a lightweight per-call context (no live dsh sessions, no agent loops).
 * The rows below are agent-loop infrastructure — they need live sessions or
 * serve the dsh chat surface — and are disabled so the container stays
 * session-free and its tool surface stays clean. Re-enable a row only when
 * adopting the corresponding capability together with its full runtime
 * context.
 *
 * `approval` is intentionally NOT disabled: dsh's sandbox escalation
 * (`sandbox_permissions`) resolves its one-shot approval through the native
 * ApprovalService. The adapter's per-call facade satisfies the plugin's
 * runtime preconditions (open turn via turn/start..turn/end, appendable
 * events for the approval/asked + approval/decided audit pair), and the
 * adapter registers the `approval/request` answerer that bridges the ask to
 * ellamaka Permission. An absent answerer still fails closed
 * (`unavailable`), and a `never` escalation policy rejects in-service.
 */
const TOOLS_PROFILE_PATCH = `# Patch layer for the ellamaka tool-container profile.
#
# The tool container is a pure tool backend: the dsh-adapter drives its tools
# with a lightweight per-call context (no live dsh sessions, no agent loops).
# The rows below are agent-loop infrastructure — they need live sessions or
# serve the dsh chat surface — and are disabled so the container stays
# session-free and its tool surface stays clean. Re-enable a row only when
# adopting the corresponding capability together with its full runtime
# context.
#
# \`approval\` is intentionally NOT disabled: dsh's sandbox escalation
# (\`sandbox_permissions\`) resolves its one-shot approval through the native
# ApprovalService. The adapter's per-call facade satisfies the plugin's
# runtime preconditions (open turn via turn/start..turn/end, appendable
# events for the approval/asked + approval/decided audit pair), and the
# adapter registers the \`approval/request\` answerer that bridges the ask to
# ellamaka Permission. An absent answerer still fails closed
# (\`unavailable\`), and a \`never\` escalation policy rejects in-service.

# --- session & agent-loop core ---
# Session lifecycle belongs to ellamaka; the container must stay session-free.
- { id: session, disabled: true }
# Flushes the calling agent's live session before every tool call; the
# adapter's per-call context has no live session, so this would throw.
- { id: session-checkpoint-policy, disabled: true }
- { id: agent, disabled: true }
# rc.1 base row: the DeepSeek plugin inventory publishes against the agents
# surface; the tool container carries none.
- { id: plugin-package-inventory-deepseek, disabled: true }
- { id: agent-loop, disabled: true }
- { id: agent-default-model, disabled: true }
- { id: agent-instructions, disabled: true }

# --- session persistence / query / projection / telemetry ---
- { id: session-title, disabled: true }
- { id: session-title-llm, disabled: true }
- { id: session-persistence-jsonl, disabled: true }
# rc.1 base row: the DeepSeek-native session log stream needs live sessions.
- { id: session-log-deepseek, disabled: true }
- { id: session-query-sqlite, disabled: true }
# \`session-projection\` stays ENABLED (it is the provider of the
# \`sessionProjections\` service, not a session consumer): rc.1 made the
# sandbox policy session-aware (\`sandboxMode\` is a projection), so the
# whole sandbox chain hangs off that service. The registry stays empty
# without session event streams, and \`stateOf\` falls back to the
# deployment default mode — exactly the tool container's semantics.
- { id: session-projection-cache, disabled: true }
- { id: session-telemetry-otel, disabled: true }

# --- llm runtime & credentials (no model calls in the tool container) ---
- { id: llm, disabled: true }
- { id: llm-retry, disabled: true }
- { id: llm-deepseek, disabled: true }
# rc.1 base row: DeepSeek LLM API extensions belong to the llm face.
- { id: deepseek-llm-api-extensions, disabled: true }
- { id: llm-pi-ai, disabled: true }
- { id: settings, disabled: true }
- { id: credentials, disabled: true }

# --- api gateway (typert) ---
- { id: typert, disabled: true }
- { id: typert-loader, disabled: true }
- { id: typert-gateway, disabled: true }

# --- interactive surface (questions, permission presets) ---
# 'approval' is ENABLED (not listed below): dsh's native escalation
# choreography (approveEscalation) resolves 'sandbox_permissions' asks
# through it. The per-call facade carries the open turn
# (turn/start..turn/end from the adapter) and the audit-pair sink
# (session.append), and the host bridges 'approval/request' to ellamaka
# Permission — a rejected/missing answerer fails closed.
- { id: user-questions, disabled: true }
- { id: permission, disabled: true }

# --- subagent delegation (agent-loop stack; ellamaka has native subagents) ---
- { id: subagent, disabled: true }
- { id: subagent-spawn-in-process, disabled: true }
- { id: subagent-fork-in-process, disabled: true }
- { id: tool-subagent, disabled: true }
- { id: tool-subagent-fork, disabled: true }
- { id: tool-subagent-control, disabled: true }
- { id: tool-subagent-report, disabled: true }
- { id: tool-subagent-list-agents, disabled: true }
- { id: workflow-worker-thread, disabled: true }
- { id: tool-workflow, disabled: true }
- { id: tool-ralph, disabled: true }

# --- background jobs ---
- { id: jobs, disabled: true }
- { id: tool-jobs, disabled: true }

# --- goals / plan mode / commands / skills ---
- { id: goal, disabled: true }
- { id: goal-round-driver, disabled: true }
- { id: tool-goal, disabled: true }
- { id: command-goal, disabled: true }
- { id: plan-mode, disabled: true }
- { id: commands, disabled: true }
- { id: command-feedback, disabled: true }
- { id: command-compact, disabled: true }
- { id: skill, disabled: true }
- { id: skill-filesystem, disabled: true }
- { id: tool-skill, disabled: true }

# --- compaction / token accounting ---
- { id: compaction-basic, disabled: true }
- { id: token-meter, disabled: true }
- { id: tool-result-pruner, disabled: true }

# --- web search (needs llm + credentials) ---
- { id: web, disabled: true }
- { id: web-search-deepseek, disabled: true }
# rc.1 base row: the http fetcher is the 'web' service provider; disabled
# with the rest of the web face.
- { id: web-fetch-http, disabled: true }
- { id: tool-web, disabled: true }

# --- attachments / todo / reminders (agent-loop UX) ---
- { id: attachment-local, disabled: true }
- { id: tool-todo, disabled: true }
- { id: repeat-tool-reminder, disabled: true }
`

// Revision 1 migration: older host-seeded tool profiles disabled approval.
// The profile patch is otherwise user-owned and must never be overwritten, so
// migrate only this exact obsolete host row and preserve every other byte.
const LEGACY_APPROVAL_DISABLED_ROW = "- { id: approval, disabled: true }"

export function migrateToolsProfileApprovalPatch(content: string): string {
  const lines = content.split("\n")
  const next = lines.filter((line) => line.trim() !== LEGACY_APPROVAL_DISABLED_ROW)
  return next.length === lines.length ? content : next.join("\n")
}

// Revision 2 migration (rc.1): the sandbox chain became session-aware —
// `dsh-sandbox-policy` now injects the `sessionProjections` service, so the
// tool container must enable the `session-projection` provider (the registry
// stays empty with no session stream and `stateOf` falls back to the
// deployment default mode). User profiles seeded by the rc.2-era host row
// disabled it, and rc.1 added session/agent-face base rows that must stay
// disabled here. Like revision 1: migrate only these exact host-owned rows,
// preserve every other byte, and never overwrite a user-owned patch.
const LEGACY_SESSION_PROJECTION_DISABLED_ROW = "- { id: session-projection, disabled: true }"
const RC1_TOOLS_DISABLED_ROWS = [
  "- { id: session-log-deepseek, disabled: true }",
  "- { id: plugin-package-inventory-deepseek, disabled: true }",
  "- { id: session-projection-cache, disabled: true }",
  "- { id: web-fetch-http, disabled: true }",
  "- { id: deepseek-llm-api-extensions, disabled: true }",
]

export function migrateToolsProfileRc1Patch(content: string): string {
  let lines = content.split("\n")
  let changed = false
  const withoutLegacy = lines.filter((line) => line.trim() !== LEGACY_SESSION_PROJECTION_DISABLED_ROW)
  if (withoutLegacy.length !== lines.length) {
    lines = withoutLegacy
    changed = true
  }
  for (const row of RC1_TOOLS_DISABLED_ROWS) {
    if (!lines.some((line) => line.trim() === row)) {
      lines.push(row)
      changed = true
    }
  }
  return changed ? lines.join("\n") : content
}

/** A handle to a mounted dsh engine. */
export interface DshHost {
  /** The port the dsh native webserver bound; absent when no webserver mounts. */
  readonly port?: number
  /** The URL of the dsh web UI; absent when no webserver mounts. */
  readonly url?: string
  /** The host context the dsh tree mounted onto (hot-reload composition). */
  readonly ctx?: Context
  /**
   * The root include entry the boot composition mounted. Hot reload replays
   * `entry.update` on this handle (Plugin Runtime Service, D-02/D-03).
   */
  readonly includeEntry?: Entry
  /**
   * The full patch-stack context this container booted with (bundle layers,
   * user patches, extras, home patches). The Plugin Runtime Service passes
   * it to `composeFullPatchStack` so a hot replay rebuilds the ENTIRE stack
   * instead of replacing it with plugin rows only (rook B-01).
   */
  readonly stackContext?: DshPluginStackContext
  /** Unmount the dsh plugin tree; the host context stays alive. */
  dispose(): Promise<void>
}

/** A handle to a virtually-mounted dsh web engine. */
export interface DshWebHost {
  /** The mount path under which the DSH surface is served on the Ellamaka listener. */
  readonly mountPath: "/dsh"
  /** The VirtualWebServer the official web profile registered its routes on. */
  readonly webServer: VirtualWebServer
  /** The host context the dsh tree mounted onto (hot-reload composition). */
  readonly ctx: Context
  /** The root include entry the boot composition mounted. */
  readonly includeEntry: Entry
  /** The full boot patch-stack context (hot replay input, rook B-01). */
  readonly stackContext: DshPluginStackContext
  /**
   * The iframe entry path under the Ellamaka origin carrying the official
   * browser-auth launch token (`/dsh/?token=...`): the first visit exchanges
   * the token for a persistent signed cookie (official `BrowserAuth`), and the
   * outbound Location rewrite on {@link webServer} keeps the follow-up 303 on
   * the mount. Computed on read from the official `connection` service, never
   * persisted.
   */
  readonly authenticatedPath: string
  /** Unmount the dsh plugin tree; the host context stays alive. */
  dispose(): Promise<void>
}

export interface DshHostOptions {
  /**
   * The Ellamaka territory root (`$WOPAL_HOME/dsh`), NOT the DSH home; the
   * official-layout DSH home (`<root>/home`) is derived internally.
   */
  home?: string
  /** The loopback port for the dsh webserver; `0` asks the OS for a free one. */
  port: number
  /**
   * Explicit path to the `@deepseek-ai/dsh` package.json acting as the
   * installation anchor. When omitted, `require.resolve` locates it from
   * this host package's closure. Desktop packaged mode passes the
   * materialised closure copy under `$WOPAL_HOME/dsh` because `require.resolve`
   * cannot reach it from the bundled sidecar.
   */
  installAnchor?: string
  /**
   * Optional prepare hook run before the plugin tree mounts. Receives the
   * host context so callers can provide extra services dsh plugins need.
   */
  prepare?: (ctx: Context) => Promise<void> | void
  /**
   * Optional path to a dedicated dsh-plugins log file. When set, a cordis
   * log Exporter is registered on the host context so every dsh plugin's
   * `ctx.logger` output lands in this file (independent of the ellamaka main
   * log). When omitted, dsh plugin logs fall through to the default cordis
   * console exporter.
   */
  logFile?: string
  /** Minimum log level for the dsh-plugins log; defaults to DEBUG. */
  logLevel?: EllamakaLogLevel
  /**
   * Optional extra patch rows applied after the profile layers. Used by
   * callers to disable profile entries that only serve the dsh agent loop
   * (e.g. session-checkpoint-policy) when the container is driven as a
   * tool backend rather than a full dsh session host.
   */
  extraPatches?: Record<string, unknown>[]
  /**
   * Disable the `code-runtime` plugin. It depends on
   * `node:module.stripTypeScriptTypes` (Node 22.18+), which the bun dev
   * runtime lacks — so the CLI serve path (bun) must disable it. The Desktop
   * sidecar runs under Node 22.18+ and should keep it enabled. Defaults to
   * `false` (enabled).
   */
  disableCodeRuntime?: boolean
  /**
   * The resolved DSH runtime module handle, loaded via
   * `@wopal/ellamaka-cordis/runtime` from the materialised closure
   * (DESIGN-dsh-poc §3.4.6). When omitted, the module falls back to the
   * package closure (source/dev mode) — keeping existing callers unchanged.
   */
  runtime?: DshRuntimeApi
}

/** Internal mount options shared by the web and base entry points. */
type MountProfileOptions = DshHostOptions & {
  profileName: string
  /** Extra patch rows applied after the profile layers. */
  extraPatches: Record<string, unknown>[]
  /** Whether the mounted profile must provide a webserver service. */
  requireWebServer: boolean
  /** When set, provide this VirtualWebServer instead of binding a real socket. */
  virtualWebServer?: VirtualWebServer
}

/**
 * Mount a dsh profile onto an existing cordis context.
 *
 * Replays the dsh `boot()` sequence (baseUrl, dshHomePath, Loader, prepare,
 * root include, activation audit) on the caller's context — one process, one
 * container. When `requireWebServer` is set, the dsh webserver must bind and
 * its port is returned; otherwise no webserver is expected.
 *
 * @param ctx - the host cordis context (e.g. a CordisHub's ctx).
 * @param options - profile name, home, port, extra patches, and whether a
 *   webserver is required.
 * @returns a {@link DshHost} handle.
 */
async function mountProfile(ctx: Context, opts: MountProfileOptions): Promise<DshHost> {
  const { home, port, prepare, logFile, logLevel, profileName, extraPatches, requireWebServer, virtualWebServer } = opts
  // The DSH runtime module handle: preferred from an injected runtime. The
  // package-closure fallback below is a DEV-ONLY seam (B-01) — every production
  // mount call site (CLI serve/web, TUI, Desktop sidecar) injects the
  // closure-resolved runtime via `DshHostOptions.runtime`; packaged hosts ship
  // without `@deepseek-ai/*` in their own closure and MUST never reach this
  // fallback.
  const runtime = opts.runtime ?? createPackageDshRuntimeApi()
  // dsh runtime isolation (DESIGN-dsh-poc §3.4): every dsh engine runtime byte
  // (settings/sessions/storages/credentials/.../home-patch) lands under
  // `$WOPAL_HOME/dsh/home`, NOT `~/.dsh`. Done via pure config injection —
  // this mount never reads `process.env.DSH_HOME` for its own paths. When
  // the caller omits `home`, fall
  // back to the standard `$WOPAL_HOME/dsh` so isolation still holds.
  const dshRoot = home ?? join(process.env.WOPAL_HOME ?? join(homedir(), ".wopal"), "dsh")
  // The DSH home (100% official layout) derived from the territory root: both
  // official resolution paths (A-class config injection and B-class env reads)
  // converge there.
  const homeDir = dshHomeDirOf(dshRoot)
  // Profile patch rows that give the dsh plugins that read `config.dshHome`
  // (via `resolveDshHome(config.dshHome)`) an explicit home rooted at the
  // DSH home. These rows REPLACE each plugin's whole config, so any non-home
  // fields the base bundle sets (e.g. agent-instructions `maxBytes`) are
  // restated here.
  //
  // Two plugins are genuine exceptions (B-02) that resolve the anonymous-user-id
  // and/or the upload index via `resolveDshHome()` with NO configurable home
  // seam and no schema-exposed path (verified against the plugin source):
  //   - llm-deepseek: `getOrCreateAnonymousUserId()` + `~/.dsh/llm-deepseek/files-v3.json`
  //   - session-telemetry-otel: `getOrCreateAnonymousUserId()` at
  //     `~/.dsh/.anonymous-user-id` when telemetry is enabled (it can be turned
  //     on by an inherited `DSH_TELEMETRY_MODE` env, not just the default
  //     DISABLED).
  // `resolveDshHome()` falls back to `~/.dsh` when `DSH_HOME` is unset. The
  // host sets `DSH_HOME=$WOPAL_HOME/dsh/home` at process launch
  // (dev.sh / Desktop sidecar, constraint #10 2026-09-05 revision), so an
  // env-resolving plugin lands in the DSH home too — both resolution paths
  // agree. These two still stay DISABLED until their env-resolution paths
  // are re-verified against the live env — re-enable only after confirming
  // every write lands inside the home.
  const homePatches = makeHomePatches(homeDir)
  // The dsh installation anchor: resolve the @deepseek-ai/dsh package.json
  // from this host package so loadProfile finds the bundle layers in the
  // host's node_modules closure. Desktop packaged mode overrides it to the
  // materialised closure copy under $WOPAL_HOME/dsh because require.resolve cannot
  // reach the resource directory from the bundled sidecar. The realpath is used
  // so profile resolution and the loader's node_modules walk reach the full
  // installed closure even when the anchor path is a symlink (pnpm layout,
  // test fixtures); for a real materialised closure it is a no-op.
  const installAnchor = realpathSync(opts.installAnchor ?? require.resolve("@deepseek-ai/dsh/package.json"))

  const { healProfilesModuleFallback, loadProfile, resolveProfileDir, initProfile } = runtime.appBoot
  // The dsh-plugins log Exporter is registered before any plugin mounts, so
  // every dsh plugin's ctx.logger output lands in the dedicated file. The
  // Exporter is auto-disposed with the host fiber (zero manual cleanup). The
  // closure-resolved runtime is injected so the exporter never falls back to
  // the host package closure on packaged hosts (B-01).
  if (logFile) {
    const exporter = createCordisLogExporter({
      logFile,
      minLevel: logLevel ?? "DEBUG",
      runtime,
      write: (line) => {
        try {
          appendFileSync(logFile, line, "utf-8")
        } catch {
          try {
            mkdirSync(dirname(logFile), { recursive: true })
            appendFileSync(logFile, line, "utf-8")
          } catch {
            // log write failures must never break the dsh mount
          }
        }
      },
    })
    ctx.logger.exporter(exporter)
  }

  // Link the profiles/node_modules fallback in the (possibly temp) home so the
  // profile's plugin rows resolve against this installation's dependency
  // closure (matches how the dsh launcher boots a profile). rc.1 API: an
  // options object + async (was `(anchor, home?)` sync in rc.2).
  await healProfilesModuleFallback({ installAnchor, home: homeDir })
  // Plugin supply chain heal (D-05): one symlink per installed user plugin
  // under the same profiles/node_modules fallback, so a bare plugin-layer
  // name resolves by parent-walk. Self-owned — the official closure heal is
  // untouched; this only adds the user install area's links.
  healPluginsModuleFallback(dshRoot)

  // The tool-container profile seeds its default patch layer (disable the
  // agent-loop-only plugins) on first mount. The file is user-owned: once the
  // user edits it (anything beyond initProfile's empty template), it is never
  // overwritten.
  if (profileName === TOOLS_PROFILE_NAME) {
    const dir = resolveProfileDir(profileName, homeDir)
    initProfile(dir, runtime.appBoot.DEFAULT_PROFILE_BUNDLES)
    const patchPath = join(dir, runtime.appBoot.PROFILE_PATCH_FILENAME)
    try {
      const current = readFileSync(patchPath, "utf-8")
      const stripped = current
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
        .trim()
      if (stripped === "[]") {
        writeFileSync(patchPath, TOOLS_PROFILE_PATCH)
      } else {
        const migrated = migrateToolsProfileRc1Patch(migrateToolsProfileApprovalPatch(current))
        if (migrated !== current) writeFileSync(patchPath, migrated)
      }
    } catch {
      writeFileSync(patchPath, TOOLS_PROFILE_PATCH)
    }
  }

  // Load the profile (bundle layers + user patch layer).
  const profile = loadProfile("ellamaka", profileName, installAnchor, homeDir)
  // The plugin layer (D-04): composed from the store — the single source of
  // truth — so boot and hot reload share one composition (D-03). Store order
  // is layer order; profiles never carry a bundles manifest for plugins.
  // Bare names resolve at this composition point (B1 拆雷): Bridge-owned rows
  // reach the Loader as absolute file:// URLs (closure -> profiles order).
  // The full patch stack (official bundle layers -> user -> extras -> home),
  // composed by the ONE function the hot replay also calls (rook B-01): boot
  // and hot reload are the same composition. EVERY manifest bundle — official
  // or user plugin — is an official loadProfile layer (full official parse);
  // bare names inside the layers resolve to file:// URLs here (B1 拆雷).
  const stackContext: DshPluginStackContext = {
    // A closure over the official loader: a hot replay recomposes FRESH so a
    // plugin installed after boot mounts on the next replay (official
    // reconcilePlugins semantics); bare names resolve per composition (B1 拆雷).
    profileLayers: (): { packageName: string; patches: unknown[] }[] =>
      resolveUserBundleNames(
        loadProfile("ellamaka", profileName, installAnchor, homeDir).layers.map((layer) => ({
          packageName: layer.packageName,
          patches: layer.patches,
        })),
        { installAnchor, dshRoot, profile: profileName },
      ) as { packageName: string; patches: unknown[] }[],
    userPatches: profile.patches,
    extraPatches,
    homePatches,
  }
  const patches = composeFullPatchStack(stackContext)
  const rootConfig = join(profile.dir, "cordis.yml")
  // The root config is the host-owned include: an empty entry list. The
  // bundle + profile patch layers carry every plugin.
  writeFileSync(rootConfig, "[]\n")

  // Replay the dsh boot() sequence on the host context (single container).
  ctx.baseUrl = pathToFileURL(dirname(rootConfig)).href + "/"
  // Override the ctx-injected `dshHomePath` so `!!js dshHomePath('sessions')`
  // (etc.) expressions in the bundle patch layers resolve under the DSH home
  // — the default resolver reads `$DSH_HOME`/`~/.dsh` (DESIGN-dsh-poc §3.4
  // A-type); the host sets `DSH_HOME` to this same home dir at launch, so
  // both resolution paths agree.
  ctx.provide("dshHomePath", (...segments: string[]) => join(homeDir, ...segments))
  const loaderFiber = await ctx.registry.plugin(runtime.pluginLoader)
  // B1 拆雷 (DESIGN-dsh-poc 「Bun 下不伪造 loader.internal（拆雷）」): the
  // Bridge no longer injects a fake `loader.internal` when the runtime
  // provides none — the fake object fooled the official hmr capability guard
  // into misusing Node-private loader APIs and was the rc.2 incident's
  // breeding ground. Under bun `ModuleLoader.fromInternal()` returns
  // undefined, official bare-name imports fall back to native `import()`
  // (Path 1, spike record), and Bridge-composed rows arrive as absolute
  // file:// URLs resolved at the composition point (resolveUserBundleNames).
  // Intrinsic host setup: the launch environment snapshot and the cmdline
  // service (--port) that the web-startup plugin reads to bind the webserver.
  const { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } = runtime.launchEnv
  ctx.provide(
    DSH_LAUNCH_ENVIRONMENT_KEY,
    createLaunchEnvironmentSnapshot([{ source: "process", values: process.env as Record<string, string> }]),
  )
  // `--no-open` keeps the dsh web UI from launching the default browser: the
  // Workbench embeds the dsh surface in an iframe, so an external tab is noise.
  runtime.cmdline.provideCmdline(ctx, { args: ["--port", String(port), "--no-open"], exit: () => {} })
  // In virtual mode, the VirtualWebServer is constructed before the Loader
  // mounts (its Service constructor registers it as `webServer`), so the
  // official web plugins register their routes against it instead of a real
  // socket. The official `webserver` entry is disabled via extraPatches.
  await prepare?.(ctx)
  // When the runtime provides a REAL internal loader (Node sidecar), wrap its
  // import with the profiles fallback (rook W-01): the internal loader
  // resolves official closure packages but not user plugins under
  // `profiles/node_modules`, so EVERY internal import path must end with a
  // profiles-anchored require whose parent-walk hits the healed plugin
  // symlinks. An unresolved name throws the original error. This runs AFTER
  // `prepare` so an internal injected there is wrapped too, and BEFORE the
  // root include mount below (the only consumer of internal.import).
  const preparedLoader = ctx.get("loader")
  if (preparedLoader !== undefined && preparedLoader.internal !== undefined) {
    wrapInternalWithProfilesFallback(preparedLoader.internal, dshRoot)
  }
  // Bare package names in the patch layers (e.g. `@deepseek-ai/dsh-web-app`)
  // must resolve against the closure the install anchor lives in, not the
  // host module graph: a bundled host (packaged CLI bunfs, Desktop sidecar)
  // carries no dsh packages, so the Node internal loader resolves them via
  // this parent URL — the dsh home root, whose `node_modules/` ancestry holds
  // the materialised closure (DESIGN-dsh-poc §2.2). From source the same
  // closure is materialised too (the kill switch guards its absence), so
  // passing the base unconditionally is mode-independent.
  const bareModuleBaseUrl = pathToFileURL(join(installAnchor, "..", "..", "..")).href + "/"
  const includeEntry = await runtime.appBoot.mountRootInclude(
    ctx,
    rootConfig,
    patches as Parameters<typeof runtime.appBoot.mountRootInclude>[2],
    bareModuleBaseUrl,
  )
  await ctx.get("loader")?.await()
  if (ctx.get("loader") === undefined || includeEntry === undefined) {
    throw new Error("ellamaka-cordis: dsh boot did not provide a loader service")
  }
  await runtime.appBoot.assertEntriesActivated(ctx, "ellamaka")

  // User patch-layer reload is selected by the loader capability, not merely
  // by the runtime name. Bun has no Node private loader. Packaged Electron
  // utility processes can also lack it after packaging. The adapter implements
  // the exact watchUserPatches contract (registerConfig + serial refresh),
  // while a fully-capable Node host retains the official empty-root watcher.
  const patchFile = join(profile.dir, "cordis.patch.yml")
  const loader = ctx.get("loader") as
    | { internal?: unknown; create(options: { name: string; config?: unknown }): Promise<unknown> }
    | undefined
  const hmrBackend = selectUserPatchHmr({
    isBun: process.versions.bun !== undefined,
    loaderInternal: loader?.internal,
  })
  let hmrStop: () => Promise<void> = async () => {}
  let watchAvailable = true
  if (hmrBackend === "adapter") {
    if (process.versions.bun === undefined) {
      ctx.logger.warn(
        new Error("[dsh] Node loader internals unavailable; using the compatible configuration HMR adapter"),
      )
    }
    const bunHmr = createBunHmr({
      containers: [{ profile: profileName, ctx, includeEntry: includeEntry as unknown as { id: string; update(o: unknown): Promise<void> } }],
      dshRoot,
      ctx,
      installAnchor,
    })
    await bunHmr.mount()
    hmrStop = () => bunHmr.stop()
  } else if (ctx.get("hmr") === undefined) {
    // The official empty-root instance supplies registerConfig to
    // watchUserPatches when the loader exposes the required internals.
    if (loader?.create !== undefined) {
      if (ctx.get("timer") === undefined) {
        await loader.create({ name: "@deepseek-ai/cordis-plugin-timer" })
      }
      await loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } })
    } else {
      ctx.logger.warn(new Error("[dsh] official HMR requires a loader with create(); patch watching unavailable"))
      watchAvailable = false
    }
  }
  const watchDispose =
    watchAvailable === false
      ? async () => {}
      : await runtime.appBoot
          .watchUserPatches(ctx, {
            binName: "ellamaka",
            filename: patchFile,
            compose: (userRows): typeof userRows => {
              // The candidate composition: official bundle layers (every
              // bundle, official or user plugin) are carried by the boot-time
              // stack context; the refreshed user rows replace the snapshot
              // captured at boot.
              return composeFullPatchStack({
                profileLayers: stackContext.profileLayers,
                userPatches: [...userRows],
                extraPatches: stackContext.extraPatches,
                homePatches: stackContext.homePatches,
              }) as typeof userRows
            },
          })
          .catch((error: unknown) => {
            // The official caller degrades when the file cannot be watched; the
            // container keeps its boot composition (hmr logs via the loader).
            console.warn("[dsh] user patch-layer watching unavailable:", (error as Error).message)
            return async () => {}
          })

  const dispose = async () => {
    try {
      await watchDispose()
    } catch {
      // Already disposed.
    }
    await hmrStop()
    const loader = ctx.get("loader")
    if (loader !== undefined) await loader.remove(includeEntry.id)
    await loaderFiber.dispose()
  }

  if (!requireWebServer) {
    return { ctx, includeEntry, stackContext, dispose }
  }

  const webServer = ctx.get("webServer")
  if (webServer === undefined) {
    throw new Error("ellamaka-cordis: dsh boot did not provide a webServer service")
  }
  const boundPort = webServer.port
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    ctx,
    includeEntry,
    stackContext,
    dispose,
  }
}

/**
 * Mount the dsh web engine virtually onto an existing cordis context.
 *
 * Loads the `web` profile (dsh-base + dsh-web-app) and provides a
 * {@link VirtualWebServer} so the official web plugins register their routes
 * against it instead of a second listening socket. The official `webserver`
 * entry is disabled; `web-runtime`'s root-path URL printing and shell/prompt
 * injection are closed (the iframe serves under `/dsh`, so a root-path URL
 * would be a wrong entry point). `web-startup` and `provideCmdline` stay so
 * the port and trust judgement keep reading the Ellamaka public listener.
 *
 * @param ctx - the host cordis context (e.g. a CordisHub's ctx).
 * @param options - home, port, and optional prepare hook.
 * @returns a {@link DshWebHost} handle.
 */
export async function mountDshWeb(ctx: Context, opts: DshHostOptions): Promise<DshWebHost> {
  const runtime = opts.runtime ?? createPackageDshRuntimeApi()
  // Resolve home once so mountProfile and the agent-presets user root agree.
  const dshRoot = opts.home ?? join(process.env.WOPAL_HOME ?? join(homedir(), ".wopal"), "dsh")
  const virtualWebServer = new VirtualWebServer(ctx, { host: "127.0.0.1", port: opts.port, runtime })
  const host = await mountProfile(ctx, {
    ...opts,
    home: dshRoot,
    profileName: WEB_PROFILE_NAME,
    requireWebServer: true,
    virtualWebServer,
    extraPatches: webExtraPatches({
      disableCodeRuntime: opts.disableCodeRuntime,
      extraPatches: opts.extraPatches,
    }),
  })
  // Register the DSH iframe prefix adaptation as the last index tap: rewrite
  // static asset URLs to /dsh and inject the browser fetch/WebSocket/
  // EventSource adapter as a real <script> node (a bare text splice into
  // </head> would not execute). frontend-static renders the index through
  // applyIndexTaps, so this runs after the official taps.
  virtualWebServer.tapIndex((html) => {
    const rewritten = virtualWebServer.rewriteIndex(html)
    const script = `<script>${virtualWebServer.iframeAdapterScript()}</script>`
    return rewritten.replace("</head>", `${script}</head>`)
  })
  return {
    mountPath: DSH_MOUNT_PREFIX,
    webServer: virtualWebServer,
    ctx: host.ctx!,
    includeEntry: host.includeEntry!,
    stackContext: host.stackContext!,
    get authenticatedPath(): string {
      // The official HostConnectionService mints the process launch token and
      // carries `authenticatedUrl`; the web profile always mounts it. A
      // missing service means the profile composition changed — fail loud
      // rather than hand the iframe an unauthenticated entry URL.
      const connection = host.ctx!.get("connection") as
        | { authenticatedUrl(baseUrl: string): string }
        | undefined
      if (connection === undefined) {
        throw new Error("ellamaka-cordis: dsh web profile did not provide the connection service")
      }
      const url = new URL(connection.authenticatedUrl("http://dsh.invalid"))
      url.pathname = `${DSH_MOUNT_PREFIX}/`
      return `${url.pathname}?${url.searchParams}`
    },
    // Dispose the VirtualWebServer first (closes every upgrade socket it
    // dispatched, per DESIGN-dsh-poc §2.1 item 10) before unmounting the
    // Loader, so Node closeAllConnections() does not strand raw WebSockets.
    dispose: async () => {
      virtualWebServer.dispose()
      await host.dispose()
    },
  }
}

/**
 * Mount the tool-container profile onto an existing cordis context.
 *
 * A dedicated dsh profile for ellamaka's direct tool adoption: same
 * {@link mountProfile} boot sequence, but the entry list comes from the
 * `ellamaka-tools` profile (dsh-base bundles) whose user-owned patch layer
 * disables the agent-loop-only plugins. Tools execute with a lightweight
 * per-call context — no live dsh sessions, no checkpoint flush.
 *
 * @param ctx - the host cordis context.
 * @param options - home, port, and optional prepare hook.
 * @returns a {@link DshHost} handle.
 */
export async function mountDshTools(ctx: Context, opts: DshHostOptions): Promise<DshToolsHost> {
  const host = await mountProfile(ctx, {
    ...opts,
    profileName: TOOLS_PROFILE_NAME,
    requireWebServer: false,
    extraPatches: toolsExtraPatches({ extraPatches: opts.extraPatches }),
  })
  return { ...host, ctx, includeEntry: host.includeEntry!, stackContext: host.stackContext! }
}

/**
 * Boot the dsh web engine on a fresh context (standalone use, tests).
 *
 * Convenience wrapper around {@link mountDshWeb} that owns the container:
 * dispose tears the whole context down.
 */
export async function bootDshWeb(opts: DshHostOptions): Promise<DshWebHost> {
  const runtime = opts.runtime ?? createPackageDshRuntimeApi()
  const ctx = new runtime.cordis.Context()
  const host = await mountDshWeb(ctx, opts)
  return {
    mountPath: host.mountPath,
    webServer: host.webServer,
    ctx: host.ctx!,
    includeEntry: host.includeEntry!,
    stackContext: host.stackContext!,
    get authenticatedPath() {
      return host.authenticatedPath
    },
    dispose: async () => {
      await host.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Boot the ellamaka-tools profile on a fresh context (standalone use,
 * desktop sidecar).
 *
 * Convenience wrapper around {@link mountDshTools} that owns the container.
 * The context itself is returned in the handle so the caller can expose it
 * (e.g. `globalThis.__ellamakaDshContainer`) — the tool container has no
 * webserver, its services reach the adapter through direct object access.
 */
export interface DshToolsHost extends DshHost {
  /** The cordis context backing the tool container. */
  readonly ctx: Context
  /** The root include entry the boot composition mounted. */
  readonly includeEntry: Entry
  /** The full boot patch-stack context (hot replay input, rook B-01). */
  readonly stackContext: DshPluginStackContext
}

export async function bootDshTools(opts: DshHostOptions): Promise<DshToolsHost> {
  const runtime = opts.runtime ?? createPackageDshRuntimeApi()
  const ctx = new runtime.cordis.Context()
  const host = await mountDshTools(ctx, opts)
  return {
    port: host.port,
    url: host.url,
    ctx,
    includeEntry: host.includeEntry!,
    stackContext: host.stackContext!,
    dispose: async () => {
      await host.dispose()
      await ctx.fiber.dispose()
    },
  }
}
