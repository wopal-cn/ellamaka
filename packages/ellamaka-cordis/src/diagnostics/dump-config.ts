import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import type { ConfigDumpLayer as OfficialConfigDumpLayer } from "@deepseek-ai/dsh-app-boot"
import {
  createPackageDshRuntimeApi,
  type DshRuntimeApi,
} from "../runtime/loader.js"
import { dshHomeDirOf } from "../runtime/status.js"

const require = createRequire(import.meta.url)

/**
 * The dump layer shape, identical to the official `ConfigDumpLayer` the
 * closure's `renderConfigDump` consumes; re-exported so the CLI's JSON
 * envelope stays in lockstep with the official layer contract.
 */
export type ConfigDumpLayer = OfficialConfigDumpLayer

/** The official loader patch row type, derived through the dump layer contract. */
type OfficialPatchOptions = OfficialConfigDumpLayer["patches"][number]

export interface ProfileDumpInput {
  dir: string
  patchPath: string
  layers: { packageName: string; patches: OfficialPatchOptions[] }[]
  patches: OfficialPatchOptions[]
}

export interface DshOverlayPatches {
  /** The overlay file path (absolute — becomes the dump layer label). */
  file: string
  /** The parsed patch rows from the overlay file. */
  patches: OfficialPatchOptions[]
}

export interface ComposeDshDumpLayersInput {
  profile: ProfileDumpInput
  /** Loader patch rows passed verbatim (the Bridge's builders emit them). */
  extraPatches: Record<string, unknown>[]
  /** Loader patch rows for the official home (the Bridge's builders emit them). */
  homePatches: Record<string, unknown>[]
  /**
   * `--patch` overlay layers in argv order (official `dsh --dump-config
   * --patch a.yml --patch b.yml`): appended AFTER the home layer, one layer
   * per file, label = the absolute file path. Back-compat: optional.
   */
  overlayPatches?: DshOverlayPatches[]
}

/**
 * Pure builder that assembles the config dump layers in the exact boot order:
 * bundle layers (label = packageName; EVERY bundle, official or user plugin)
 * -> user patch layer (when non-empty, label = profile.patchPath, patches = profile.patches)
 * -> extra layers (when non-empty, label = "ellamaka bridge extra patches", patches = extraPatches)
 * -> home layers (when non-empty, label = "ellamaka home patches", patches = homePatches)
 * -> `--patch` overlay layers (one per file in argv order, label = absolute file path)
 */
export function composeDshDumpLayers(input: ComposeDshDumpLayersInput): ConfigDumpLayer[] {
  const layers: ConfigDumpLayer[] = []

  // 1. Bundle layers
  for (const layer of input.profile.layers) {
    layers.push({
      label: layer.packageName,
      patches: layer.patches,
    })
  }

  // 2. User patch layer (only when non-empty)
  if (input.profile.patches.length > 0) {
    layers.push({
      label: input.profile.patchPath,
      patches: input.profile.patches,
    })
  }

  // 3. Bridge extra layer (when non-empty)
  if (input.extraPatches.length > 0) {
    layers.push({
      label: "ellamaka bridge extra patches",
      patches: input.extraPatches,
    })
  }

  // 5. Home layer (when non-empty)
  if (input.homePatches.length > 0) {
    layers.push({
      label: "ellamaka home patches",
      patches: input.homePatches,
    })
  }

  // 5. --patch overlay layers (official argv order: applied last, later wins)
  for (const overlay of input.overlayPatches ?? []) {
    layers.push({
      label: overlay.file,
      patches: overlay.patches,
    })
  }

  return layers
}

/**
 * Home patch rows that give plugins an explicit home rooted at the DSH home
 * (`<dshRoot>/home`, official layout; DESIGN-dsh-poc §3.4).
 */
export function homePatches(homeDir: string): Record<string, unknown>[] {
  return [
    { id: "settings", config: { dshHome: homeDir } },
    { id: "credentials", config: { dshHome: homeDir } },
    { id: "attachment-local", config: { dshHome: homeDir } },
    { id: "shell-env", config: { dshHome: homeDir } },
    { id: "agent-instructions", config: { dshHome: homeDir, maxBytes: 65536 } },
    { id: "skill-filesystem", config: { dshHome: homeDir } },
    { id: "llm-deepseek", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
  ]
}

export interface WebExtraPatchesOptions {
  disableCodeRuntime?: boolean
  extraPatches?: Record<string, unknown>[]
}

/**
 * Bridge extra patches for the web profile mount.
 *
 * `code-runtime` depends on node:module.stripTypeScriptTypes (Node 22.18+),
 * which the bun dev runtime lacks. It is a code-execution capability, not part
 * of the web UI chat surface. The CLI serve path (bun) disables it via
 * `disableCodeRuntime`; the Desktop sidecar (Node 22.18+) keeps it.
 *
 * `webserver`: the official webserver binds a real socket; the virtual profile
 * provides VirtualWebServer instead, so disable the real one.
 *
 * `web-runtime`: the iframe serves under /dsh; a root-path URL would be a
 * wrong entry point, so close web-runtime's URL printing and shell/prompt
 * injection. Full config replacement preserves the connection-trust fields.
 *
 * rc.1 no longer injects an `agent-presets` row: the preset roster is owned
 * by the official bundle (`default: standard` shipped set inside
 * `@deepseek-ai/dsh-agent-presets`, user root derived from the `dshHomePath`
 * service), so the host adds nothing here — the dump output matches the
 * official `dsh --dump-config` shape exactly.
 */
export function webExtraPatches(opts: WebExtraPatchesOptions): Record<string, unknown>[] {
  return [
    ...(opts.disableCodeRuntime ? [{ id: "code-runtime", disabled: true }] : []),
    { id: "webserver", disabled: true },
    {
      id: "web-runtime",
      config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] },
    },
    ...(opts.extraPatches ?? []),
  ]
}

export interface ToolsExtraPatchesOptions {
  extraPatches?: Record<string, unknown>[]
}

/**
 * Bridge extra patches for the tools profile mount.
 *
 * `hmr`: HMR needs --expose-internals (bun lacks it); the tool surface has no
 * hot-reload need, so disable it to boot under bun.
 *
 * `tool-bash`: the per-call tool adapter context has no live session, so
 * background bash (which waits on session lifecycle) must stay off.
 */
export function toolsExtraPatches(opts?: ToolsExtraPatchesOptions): Record<string, unknown>[] {
  return [
    { id: "hmr", disabled: true },
    { id: "tool-bash", config: { enableRunInBackground: false } },
    ...(opts?.extraPatches ?? []),
  ]
}

export interface DumpDshConfigOptions {
  wopalHome?: string
  profileName: string
  defaultOnly?: boolean
  runtime?: DshRuntimeApi
  /**
   * The Ellamaka territory root (`$WOPAL_HOME/dsh`), NOT the DSH home; the
   * official-layout DSH home (`<root>/home`) is derived internally.
   */
  dshHome?: string
  installAnchor?: string
  /**
   * `--patch` overlay paths in argv order (official `dsh --dump-config`).
   * Each file is loaded through the closure's `loadOverlayPatches` — a
   * missing file THROWS (the caller named it, its absence is a
   * misconfiguration, never "no overlay"). Ignored when `defaultOnly` (the
   * official CLI rejects that shape one layer up; defense in depth here).
   */
  overlayPatches?: string[]
}

/**
 * Load a profile and compose its FULL dump layer list (bundle -> plugin ->
 * user -> extra -> home). The ONE composition the single YAML output renders
 * through the official `renderConfigDump`.
 */
export async function composeDshDumpProfileLayers(options: DumpDshConfigOptions): Promise<{
  rootConfig: string
  layers: OfficialConfigDumpLayer[]
}> {
  const runtime = options.runtime ?? createPackageDshRuntimeApi()
  const wopalHome = options.wopalHome ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
  // `dshHome`/`dshRoot` here is the Ellamaka territory root (`$WOPAL_HOME/dsh`),
  // NOT the DSH home; the official-layout home derives from it.
  const dshRoot = options.dshHome ?? join(wopalHome, "dsh")
  const homeDir = dshHomeDirOf(dshRoot)
  const installAnchor = realpathSync(
    options.installAnchor ?? require.resolve("@deepseek-ai/dsh/package.json"),
  )

  const profile = runtime.appBoot.loadProfile(
    "ellamaka",
    options.profileName,
    installAnchor,
    homeDir,
    { userLayer: options.defaultOnly === true ? false : undefined },
  )

  const rootConfig = join(profile.dir, "cordis.yml")
  // The dump anchors on the same empty root file the boot includes
  // (`renderConfigDump` readFileSync's it). Write it only when the content
  // differs: a running engine rebuilds its standing composition on mtime/size,
  // so a same-content write on the live home is not idempotent (B1.5 incident,
  // plan-b15-dump-config.md 事故教训). On the boot's own home the file is
  // already "[]\n", so this branch always skips.
  if (!existsSync(rootConfig) || readFileSync(rootConfig, "utf8") !== "[]\n") {
    writeFileSync(rootConfig, "[]\n")
  }

  let extra: Record<string, unknown>[] = []
  if (options.defaultOnly !== true) {
    if (options.profileName === "web") {
      extra = webExtraPatches({
        disableCodeRuntime: true,
      })
    } else if (options.profileName === "ellamaka-tools") {
      extra = toolsExtraPatches()
    }
  }

  // --patch overlays (official argv order, loaded LAST so a missing or
  // unparsable file throws before any composition happens on its layer).
  const overlays: DshOverlayPatches[] = []
  if (options.defaultOnly !== true) {
    for (const file of options.overlayPatches ?? []) {
      const absolute = resolve(file)
      overlays.push({ file: absolute, patches: runtime.appBoot.loadOverlayPatches("dsh", absolute) })
    }
  }

  const layers = composeDshDumpLayers({
    profile: {
      dir: profile.dir,
      patchPath: profile.patchPath,
      // EVERY manifest bundle is an official loadProfile layer (official or
      // user plugin) — the official dump semantics, verbatim.
      layers: profile.layers,
      patches: profile.patches,
    },
    extraPatches: extra,
    homePatches: options.defaultOnly === true ? [] : homePatches(homeDir),
    overlayPatches: overlays,
  })
  return { rootConfig, layers }
}

/**
 * Dump the effective dsh config patch stack for a profile.
 * Zero-write, boot-free diagnostic using official renderConfigDump.
 */
export async function dumpDshConfig(options: DumpDshConfigOptions): Promise<string> {
  const runtime = options.runtime ?? createPackageDshRuntimeApi()
  const { rootConfig, layers } = await composeDshDumpProfileLayers(options)
  return runtime.appBoot.renderConfigDump("ellamaka", rootConfig, layers)
}
