import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"
import { mountDshEngine } from "./dsh-mount"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: `starts a headless ${BINARY_NAME} server`,
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`${BINARY_NAME} server listening on http://${server.hostname}:${server.port}`)

    // Optional dsh engine (single-process, dual-container, DESIGN-dsh-poc
    // §2.1/§2.2). The unified Runtime Manager (in dsh-mount.ts, shared with the
    // `web` command) gates on `ELLAMAKA_DSH` itself — `=0` → disabled with zero
    // file access — and `disabled`/`degraded` never block the server. The
    // dynamic import keeps the dsh closure out of the desktop sidecar bundle —
    // only ELLAMAKA_DSH-enabled CLI runs load it.
    {
      const { mountDshEngine: engine } = yield* Effect.promise(() => import("./dsh-mount"))
      const handle = yield* Effect.promise(() => engine(server))
      yield* Effect.never.pipe(
        Effect.ensuring(Effect.promise(() => handle?.dispose() ?? Promise.resolve())),
      )
    }
  }),
})
