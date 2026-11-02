import { Effect } from "effect"
import { Server } from "../../server/server"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"
import { isWopalHomeLockedAtStartup } from "@wopal/ellamaka-core/wopal-home-env"
import { workbenchAuthUrl } from "./serve"
import { createDshMountController, setupCompleted } from "./dsh-mount-controller"
import { installDshMountController } from "@/workbench/dsh-mount-registry"
import { setDshStatus } from "@/workbench/dsh-status"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: `start ${BINARY_NAME} server and open web interface`,
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    if (!Flag.ELLAMAKA_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!  ELLAMAKA_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    // Same lifecycle as `serve`: an unfinished Setup (and every development
    // bootstrap) must not mount DSH from the launch Home candidate. Workbench
    // mounts on first use after the Host has locked its effective Home.
    const controller = createDshMountController({
      server,
      cors: opts.cors,
      mountEngine: (wopalHome) =>
        import("./dsh-mount").then(({ mountDshEngine }) =>
          mountDshEngine(server, { entry: "web", cors: opts.cors, wopalHome }),
        ),
    })
    const setupReady = isWopalHomeLockedAtStartup() && setupCompleted()
    installDshMountController(controller, setupReady)
    if (setupReady) {
      yield* Effect.promise(() => controller.ensure())
    } else {
      setDshStatus("web", "disabled")
      setDshStatus("tools", "disabled")
    }

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      const localhostEntry = workbenchAuthUrl(localhostUrl, Flag.ELLAMAKA_SERVER_PASSWORD)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostEntry)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            workbenchAuthUrl(`http://${ip}:${server.port}`, Flag.ELLAMAKA_SERVER_PASSWORD),
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          workbenchAuthUrl(`http://${opts.mdnsDomain}:${server.port}`, Flag.ELLAMAKA_SERVER_PASSWORD),
        )
      }

      // Open localhost in browser
      open(localhostEntry).catch(() => {})
    } else {
      const displayUrl = workbenchAuthUrl(`http://${server.hostname}:${server.port}`, Flag.ELLAMAKA_SERVER_PASSWORD)
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
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
