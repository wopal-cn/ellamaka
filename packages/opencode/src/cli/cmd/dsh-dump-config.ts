import { Effect } from "effect"
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { mergeDeep } from "remeda"
import { Global } from "@wopal/ellamaka-core/global"
import { detectWopalSpace } from "@wopal/ellamaka-brand/detect"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  resolveInstallAnchor,
} from "@wopal/ellamaka-cordis/runtime"
import { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
import { dumpDshConfig } from "@wopal/ellamaka-cordis/diagnostics/dump-config"
import { CliError, effectCmd } from "../effect-cmd"
import { trustedDshAuthorities, localDshInterfaceAddresses, isWildcardBind } from "./dsh-mount"
import { AppRuntime } from "@/effect/app-runtime"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"

/**
 * `ellamaka dsh dump-config` — the ellamaka COMPATIBILITY extension form
 * (Plan 223 D-03). The official shape is the root flags:
 * `dsh --dump-config --profile web --patch a.yml` (wired on the `dsh` parent
 * in src/index.ts); this subcommand keeps the pre-223 ellamaka usage working
 * and adds the official `--patch` overlay support.
 *
 * Both forms share ONE execution path (runDshDump) and ONE composition
 * (composeDshDumpProfileLayers) — one composition, one rendered YAML output.
 */
export const DshDumpConfigCommand = effectCmd({
  command: "dump-config",
  describe: "dump composed dsh patch layers for a profile without booting (compat form of `dsh --dump-config`)",
  instance: false,
  // Documented "without booting" — the handler only reads closure + profile
  // files; AppRuntime construction would violate that contract.
  light: true,
  builder: (yargs) =>
    yargs
      .option("profile", {
        type: "string",
        default: "web",
        describe: "the profile name to inspect",
      })
      .option("default-only", {
        type: "boolean",
        default: false,
        describe: "dump bundle layers only (recovery diagnostic)",
      })
      .option("patch", {
        type: "string",
        nargs: 1,
        array: true,
        describe: "extra patch-list overlay applied after the profile layer (repeatable, argv order)",
      }),
  handler: Effect.fn("Cli.dshDumpConfig")(function* (args) {
    return yield* runDshDump({
      profileName: String(args.profile ?? "web"),
      defaultOnly: args["default-only"] === true,
      overlayPatches: (args.patch as string[] | undefined) ?? [],
    })
  }),
})

/** The shared dump execution for the root-flag form and the compat subcommand. */
export const runDshDump = (options: {
  profileName: string
  defaultOnly: boolean
  overlayPatches: string[]
}): Effect.Effect<void, CliError> =>
  Effect.fn("Cli.dshDumpRun")(function* () {
    const wopalHome = Global.Path.wopalHome
    const { runtime, anchorPath } = yield* Effect.try({
      try: () => {
        const anchor = resolveInstallAnchor(wopalHome, DEFAULT_DSH_RUNTIME_MANIFEST)
        return {
          runtime: createDshRuntimeApi(anchor.path),
          anchorPath: anchor.path,
        }
      },
      catch: () =>
        new CliError({
          message: "dsh runtime closure not found; run 'ellamaka serve' once to materialise it",
        }),
    })

    // The dump previews the fence the same boot composes. The runtime `serve`
    // resolves its server config through the three-tier merge (global, then
    // the space's public/private settings), so the dump reads those same
    // tiers directly: the light root-flag form has no booted AppRuntime, and
    // nested AppRuntime calls do not compose a config in this path.
    const globalServer = (yield* Effect.promise(() =>
      AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())),
    )).server
    const spaceServer = readSpaceServerBlock(process.cwd())
    const server = spaceServer ? (mergeDeep(globalServer ?? {}, spaceServer) as typeof globalServer) : globalServer

    const dumpOptions = {
      wopalHome,
      profileName: options.profileName,
      defaultOnly: options.defaultOnly,
      runtime,
      dshHome: join(wopalHome, "dsh"),
      installAnchor: anchorPath,
      overlayPatches: options.overlayPatches,
      // The dump reflects the fence value: the CORS trust decision (merged
      // server.cors) plus the server's own serving authorities, so a wildcard
      // bind advertises every local interface address on its port.
      trustedHosts: trustedDshAuthorities(
        { hostname: server?.hostname ?? "127.0.0.1", port: server?.port ?? 0 },
        server?.cors ?? [],
        isWildcardBind(server?.hostname ?? "") && (server?.port ?? 0) > 0 ? localDshInterfaceAddresses() : [],
      ),
    } as const

    const dumped = yield* Effect.tryPromise({
      try: () => dumpDshConfig(dumpOptions),
      catch: toCliErrorMessage,
    })
    process.stdout.write(dumped.endsWith("\n") ? dumped : dumped + "\n")
  })()

/**
 * Read the space tier's `server` block for the dump, mirroring the `serve`
 * path's walk-up space detection. The dump runs in the light CLI form with no
 * booted AppRuntime, so this reads the space's public and private settings
 * files directly and deep-merges them over the global block. Returns
 * `undefined` when the working directory is not inside a wopal space.
 */
function readSpaceServerBlock(directory: string): Config.Info["server"] | undefined {
  const root = detectWopalSpace(directory)?.root
  if (!root) return undefined
  const candidates = [
    join(root, ".wopal", "config", "settings.jsonc"),
    join(root, ".wopal", "config", "settings.json"),
    join(root, ".wopal", "config", "settings.local.jsonc"),
    join(root, ".wopal", "config", "settings.local.json"),
  ]
  let merged: Config.Info["server"] | undefined
  for (const file of candidates) {
    if (!existsSync(file)) continue
    let raw: unknown
    try {
      raw = ConfigParse.jsonc(readFileSync(file, "utf8"), file)
    } catch {
      continue
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue
    const ellamaka = (raw as Record<string, unknown>).ellamaka
    if (typeof ellamaka !== "object" || ellamaka === null || Array.isArray(ellamaka)) continue
    const server = (ellamaka as Record<string, unknown>).server
    if (typeof server !== "object" || server === null || Array.isArray(server)) continue
    merged = mergeDeep(merged ?? {}, server) as Config.Info["server"]
  }
  return merged
}

function toCliErrorMessage(err: unknown): CliError {
  const message = err instanceof Error ? err.message : String(err)
  // The closure's profile errors teach the official bare `dsh plugin` command,
  // which ellamaka does not ship. Redirect to the ellamaka command surface
  // (B1.5 goal: eliminate the bare-`dsh` incitement source).
  if (message.includes("dsh plugin --profile")) {
    return new CliError({
      message: `${message}\n(in ellamaka, use: \`ellamaka dsh plugin --profile <name> add <package>\`)`,
    })
  }
  return new CliError({ message })
}
