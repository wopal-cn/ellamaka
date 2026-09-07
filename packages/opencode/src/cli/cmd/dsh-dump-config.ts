import { Effect } from "effect"
import { join } from "node:path"
import { Global } from "@wopal/ellamaka-core/global"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  resolveInstallAnchor,
} from "@wopal/ellamaka-cordis/runtime"
import { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
import { dumpDshConfig } from "@wopal/ellamaka-cordis/diagnostics/dump-config"
import { CliError, effectCmd } from "../effect-cmd"

/**
 * `ellamaka dsh dump-config` — the ellamaka COMPATIBILITY extension form
 * (Plan 223 D-03). The official shape is the root flags:
 * `dsh --dump-config --profile web --patch a.yml` (wired on the `dsh` parent
 * in src/index.ts); this subcommand keeps the pre-223 ellamaka usage working
 * and adds the official `--patch` overlay support.
 *
 * Both forms share ONE execution path (runDshDump) and ONE composition
 * (composeDshDumpProfileLayers) — the layer list can never drift between
 * shapes or output formats.
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

    const dumpOptions = {
      wopalHome,
      profileName: options.profileName,
      defaultOnly: options.defaultOnly,
      runtime,
      dshHome: join(wopalHome, "dsh"),
      installAnchor: anchorPath,
      overlayPatches: options.overlayPatches,
    } as const

    const dumped = yield* Effect.tryPromise({
      try: () => dumpDshConfig(dumpOptions),
      catch: toCliErrorMessage,
    })
    process.stdout.write(dumped.endsWith("\n") ? dumped : dumped + "\n")
  })()

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
