import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"
import { isWopalHomeLockedAtStartup } from "@wopal/ellamaka-core/wopal-home-env"
import { createDshMountController, setupCompleted } from "./dsh-mount-controller"
import { installDshMountController } from "@/workbench/dsh-mount-registry"
import { setDshStatus } from "@/workbench/dsh-status"

/**
 * A ready-to-open Ellamaka app URL. With a server password configured, the
 * SPA cannot show the native Basic dialog on fetch 401s, so the user needs
 * the `?auth_token=` entry (Base64 of `username:password`, decoded by the
 * app's `authFromToken`); without a password the bare URL is correct.
 */
export function applicationAuthUrl(
  origin: string,
  surface: "onboarding" | "workbench",
  password: string | undefined,
  username?: string,
): string {
  const base = `${origin.replace(/\/+$/, "")}/${surface}`
  if (!password) return base
  const token = btoa(`${username ?? Flag.ELLAMAKA_SERVER_USERNAME ?? "ellamaka"}:${password}`)
  return `${base}?auth_token=${token}`
}

export function workbenchAuthUrl(origin: string, password: string | undefined, username?: string): string {
  return applicationAuthUrl(origin, "workbench", password, username)
}

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: `starts a headless ${BINARY_NAME} server`,
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.ELLAMAKA_SERVER_PASSWORD) {
      console.log("Warning: ELLAMAKA_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    const origin = `http://${server.hostname}:${server.port}`
    const setupReady = isWopalHomeLockedAtStartup() && setupCompleted()
    const entry = setupReady ? "workbench" : "onboarding"
    console.log(`${BINARY_NAME} server listening on ${origin}`)
    console.log(`${entry}: ${applicationAuthUrl(origin, entry, Flag.ELLAMAKA_SERVER_PASSWORD)}`)

    // DSH is mounted on demand, not at listen time (DESIGN-onboarding.md
    // `## Core Preparation Timing`). While application Setup is unfinished
    // there is no Workbench to consume DSH, and Onboarding owns the visible
    // preparation step — mounting here would burn the closure download behind
    // a page nobody can see and seed profiles from an uninstalled Ontology.
    //
    // Every consumer of DSH calls `ensure()` first (health-gated Workbench
    // entry), which is the same "prepare on use" fallback the design requires.
    const controller = createDshMountController({ server, cors: opts.cors })
    installDshMountController(controller, setupReady)

    if (setupReady) {
      yield* Effect.promise(() => controller.ensure())
    } else {
      setDshStatus("web", "disabled")
      setDshStatus("tools", "disabled")
      console.log("setup: not completed; DSH will mount when Workbench is first used")
    }

    yield* Effect.never.pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          await controller.dispose()
        }),
      ),
    )
  }),
})
