import { Effect } from "effect"
import { runPackageWorker } from "@wopal/ellamaka-cordis/plugins/package-worker"
import { CliError, effectCmd } from "../effect-cmd"

/** Internal executable adapter for profileContext.packageManager. */
export const DshPackageWorkerCommand = effectCmd({
  command: "package-worker [args...]",
  describe: false,
  instance: false,
  light: true,
  builder: (yargs) =>
    yargs
      .option("home", { type: "string", demandOption: true })
      .option("profile", { type: "string", demandOption: true })
      .option("install-anchor", { type: "string", demandOption: true })
      .positional("args", { type: "string", array: true, default: [] as string[] }),
  handler: Effect.fn("Cli.dshPackageWorker")(function* (args) {
    const raw = [...args.args, ...(args["--"] ?? []).map(String)]
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        const controller = new AbortController()
        const cancel = () => controller.abort(new Error("package installation cancelled"))
        process.once("SIGTERM", cancel)
        process.once("SIGINT", cancel)
        try {
          return await runPackageWorker(
            {
              installAnchor: args.installAnchor,
              home: args.home,
              profile: args.profile,
              cwd: process.cwd(),
              signal: AbortSignal.any([signal, controller.signal]),
            },
            raw,
          )
        } finally {
          process.off("SIGTERM", cancel)
          process.off("SIGINT", cancel)
        }
      },
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    if (result !== undefined) process.stdout.write(result)
  }),
})
