import { Effect } from "effect"
import { join } from "node:path"
import { Global } from "@wopal/ellamaka-core/global"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  initializeDshRuntime,
} from "@wopal/ellamaka-cordis/runtime"
import { CliError, effectCmd, fail } from "../effect-cmd"

/**
 * `ellamaka dsh init` — materialise the build-time dsh closure into a wopal
 * home ahead of any serve/web boot.
 *
 * The unified Runtime Manager normally materialises the closure lazily on the
 * first `serve`/`web`/TUI launch. `dsh init` runs that same materialisation
 * NOW (and only that: no engine mount), so an isolated home — one that has
 * never booted the engine — has a ready closure before anything is spawned
 * against it. This is the A3 prerequisite that lets an isolated home satisfy
 * the dsh peer checks when `dsh plugin` commands run against it.
 *
 * The target home defaults to `Global.Path.wopalHome` (i.e. `$WOPAL_HOME`, or
 * `~/.wopal` when unset); `--home` overrides it explicitly. The command is
 * engine-free: it never constructs the AppRuntime, so it boots nothing beyond
 * the materialiser.
 */
export const DshInitCommand = effectCmd({
  command: "init",
  describe: "materialise the dsh closure for a wopal home ahead of boot (isolated-home prerequisite)",
  instance: false,
  light: true,
  builder: (yargs) =>
    yargs.option("home", {
      type: "string",
      describe: "the wopal home to materialise into (default: $WOPAL_HOME or ~/.wopal)",
    }),
  handler: Effect.fn("Cli.dshInit")(function* (args) {
    const wopalHome = (args.home as string | undefined) ?? Global.Path.wopalHome
    const status = yield* Effect.tryPromise({
      try: () => runDshInit({ wopalHome }),
      catch: (error) =>
        new CliError({
          message: error instanceof Error ? error.message : String(error),
        }),
    })
    if (status === "ready") {
      process.stdout.write(
        `dsh closure ready for ${wopalHome} (${DEFAULT_DSH_RUNTIME_MANIFEST.fingerprint})\n`,
      )
      return
    }
    if (status === "disabled") {
      process.stdout.write(
        "dsh is disabled (ELLAMAKA_DSH=0); nothing materialised\n",
      )
      return
    }
    return yield* fail(
      `dsh closure materialisation failed for ${wopalHome}; see the dsh-plugins log for the structured diagnosis`,
    )
  }),
})

/**
 * Materialise the dsh closure into `wopalHome` and report the terminal status.
 * This is the same call `serve`/`web` make on boot, isolated here so it can be
 * invoked early and tested against a temp home without booting the engine.
 *
 * The log file lives under the target home itself, so an isolated home carries
 * its own diagnosis trail. `env` defaults to `process.env` and is injectable
 * for tests (the manager gates on `ELLAMAKA_DSH` from it).
 */
export function runDshInit(options: {
  wopalHome: string
  logFile?: string
  env?: Record<string, string | undefined>
}) {
  return initializeDshRuntime({
    wopalHome: options.wopalHome,
    logFile: options.logFile ?? join(options.wopalHome, "logs", "dsh-plugins.log"),
    entry: "init",
    manifest: DEFAULT_DSH_RUNTIME_MANIFEST,
    env: options.env,
  })
}
