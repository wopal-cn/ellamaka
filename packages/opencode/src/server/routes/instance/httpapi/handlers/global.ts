import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { Installation } from "@/installation"
import { CliContract } from "@/wopal/cli-contract"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@wopal/ellamaka-core/installation/version"
import { NodeHttpServerRequest } from "@effect/platform-node"
import { getDshStatus } from "@/workbench/dsh-status"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    let subscribed = false
    let released = false
    let handler: ((event: GlobalBusEvent) => void) | undefined
    const response = NodeHttpServerRequest.toServerResponse(request) as unknown
    const incoming = NodeHttpServerRequest.toIncomingMessage(request) as unknown
    const closeSources = [response, socketOf(incoming)].filter(isClosableResponse)

    // HttpServerResponse.stream is consumed outside the request fiber by the
    // Node adapter. Interrupting that fiber on client disconnect therefore does
    // not reliably run Stream.callback's finalizer. Bind both the real
    // response and its transport socket close events to the SAME idempotent
    // cleanup path as the stream finalizer.
    const release = () => {
      if (released) return
      released = true
      for (const source of closeSources) source.off("close", release)
      if (subscribed && handler) GlobalBus.off("event", handler)
      subscribed = false
    }
    for (const source of closeSources) source.once("close", release)

    const events = Stream.callback<GlobalBusEvent>((queue) => {
      handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => {
          if (released || !handler) return
          GlobalBus.on("event", handler)
          subscribed = true
        }),
        () => Effect.sync(release),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: Bus.createID(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: Bus.createID(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(
          Effect.sync(() => {
            release()
          }),
        ),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

type ClosableResponse = {
  once(event: "close", listener: () => void): unknown
  off(event: "close", listener: () => void): unknown
}

function isClosableResponse(value: unknown): value is ClosableResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "once" in value &&
    typeof value.once === "function" &&
    "off" in value &&
    typeof value.off === "function"
  )
}

function socketOf(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("socket" in value)) return undefined
  return value.socket
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const cliContract = yield* CliContract.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return {
        healthy: true as const,
        version: InstallationVersion,
        cli: yield* cliContract.inspect(),
        dsh: getDshStatus(),
      }
    })

    const cliRepair = Effect.fn("GlobalHttpApi.cliRepair")(function* () {
      return yield* cliContract.repair()
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handle("cliRepair", cliRepair)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
