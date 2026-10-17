import { Effect } from "effect"
import { runWebChildIfRequested } from "@wopal/ellamaka-cordis/runtime/web-child"
import { CliError, effectCmd } from "../effect-cmd"

/**
 * Internal child-process role for the `dsh:web` cold reload (DESIGN.md
 * 隔离边界): boots the web profile in THIS process on a real loopback socket
 * and reports readiness as one JSON line on stdout. Spawned by the serve/web
 * assembly (`dsh-mount.ts` → `spawnWebChildContainer`); never user-facing.
 */
export const DshWebChildCommand = effectCmd({
  command: "web-child",
  describe: false,
  instance: false,
  light: true,
  builder: (yargs) =>
    yargs
      .option("home", { type: "string", demandOption: true })
      .option("port", { type: "number", demandOption: true })
      .option("install-anchor", { type: "string" })
      .option("log-dir", { type: "string" })
      .option("trusted-host", { type: "string", array: true, default: [] as string[] }),
  handler: Effect.fn("Cli.dshWebChild")(function* (args) {
    const entered = yield* Effect.promise(() =>
      runWebChildIfRequested([
        process.argv[0] ?? "",
        process.argv[1] ?? "",
        "--ellamaka-dsh-web-child",
        "--home",
        args.home,
        "--port",
        String(args.port),
        ...(args["install-anchor"] ? ["--install-anchor", args["install-anchor"]] : []),
        ...(args["log-dir"] ? ["--log-dir", args["log-dir"]] : []),
        ...args["trusted-host"].flatMap((host: string) => ["--trusted-host", host]),
      ]),
    )
    if (!entered) {
      return yield* new CliError({ message: "dsh web-child invoked without the child marker argv" })
    }
    // runWebChildIfRequested resolves only after a graceful shutdown; the
    // process then exits through the normal zero-code path.
    return undefined
  }),
})
