import { Installation } from "@/installation"
import { Server } from "@/server/server"
import * as Log from "@wopal/ellamaka-core/util/log"
import type { Level } from "@wopal/ellamaka-core/util/log"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { ensureProcessMetadata } from "@wopal/ellamaka-core/util/opencode-process"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { mountDshIfEnabled } from "@/cli/cmd/tui/dsh-mount"

ensureProcessMetadata("worker")

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  devFile: "ellamaka-dev-tui.log",
  role: "tui",
  level: (process.env.OPENCODE_LOG_LEVEL as Level) ?? (Installation.isLocal() ? "DEBUG" : "INFO"),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

// Optional dsh tool container (single-process, no webserver). The unified
// Runtime Manager gates on `ELLAMAKA_DSH` internally (`=0` → disabled with
// zero file access) and mounts the ellamaka-tools profile onto a process-level
// cordis hub, exposing the container so the dsh-adapter plugin can project
// container tools into ellamaka's ToolRegistry. `disabled`/`degraded` never
// block the TUI: nothing dsh-related is mounted and the worker runs untouched.
let dshHost: { dispose(): Promise<void> } | undefined

void mountDshIfEnabled()
  .then((host) => {
    dshHost = host
    if (host) Log.Default.info("dsh tool container mounted", {})
  })
  .catch((error) => {
    Log.Default.error("failed to mount dsh tool container", {
      error: error instanceof Error ? error.message : String(error),
    })
  })

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    Log.Default.info("worker shutting down")

    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    if (dshHost) await dshHost.dispose()
  },
}

Rpc.listen(rpc)
