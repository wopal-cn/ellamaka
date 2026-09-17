import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"
import { mountDshEngine } from "./dsh-mount"

/**
 * The ready-to-open Workbench URL. With a server password configured, the
 * SPA cannot show the native Basic dialog on fetch 401s, so the user needs
 * the `?auth_token=` entry (Base64 of `username:password`, decoded by the
 * Workbench's `authFromToken`); without a password the bare URL is correct.
 */
export function workbenchAuthUrl(origin: string, password: string | undefined, username?: string): string {
  const base = `${origin.replace(/\/+$/, "")}/workbench`
  if (!password) return base
  const token = btoa(`${username ?? Flag.ELLAMAKA_SERVER_USERNAME ?? "ellamaka"}:${password}`)
  return `${base}?auth_token=${token}`
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
    console.log(`${BINARY_NAME} server listening on ${origin}`)
    console.log(`workbench: ${workbenchAuthUrl(origin, Flag.ELLAMAKA_SERVER_PASSWORD)}`)

    // Onboarding HTTP surface (Plan #230): a zero-intrusion mount at
    // /api/onboarding on top of Server.listen. The Onboarding package owns its
    // authentication (the mount declares `auth: "self"`); the server password
    // is forwarded so a protected server asks for the same credential here too.
    // The dynamic import keeps the onboarding closure out of the desktop
    // sidecar bundle — only CLI hosts load it. No `onComplete` hook is wired:
    // the listener exposes no Effect-side SpaceRegistry, and the Workbench
    // already refetches spaces when it navigates after completion.
    const disposeOnboarding = yield* Effect.promise(async () => {
      const { mountOnboarding } = await import("@wopal/ellamaka-onboarding/mount")
      return mountOnboarding(server, { serverPassword: Flag.ELLAMAKA_SERVER_PASSWORD })
    })
    console.log(`onboarding: /api/onboarding`)

    // Optional dsh engine (single-process, dual-container, DESIGN-dsh-base.md
    // §2.1/§2.2). The unified Runtime Manager (in dsh-mount.ts, shared with the
    // `web` command) gates on `ELLAMAKA_DSH` itself — `=0` → disabled with zero
    // file access — and `disabled`/`degraded` never block the server. The
    // dynamic import keeps the dsh closure out of the desktop sidecar bundle —
    // only ELLAMAKA_DSH-enabled CLI runs load it.
    {
      const { mountDshEngine: engine } = yield* Effect.promise(() => import("./dsh-mount"))
      const handle = yield* Effect.promise(() => engine(server, { cors: opts.cors }))
      yield* Effect.never.pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            disposeOnboarding()
            await handle?.dispose()
          }),
        ),
      )
    }
  }),
})
