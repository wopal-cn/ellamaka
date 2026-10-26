import { Config } from "@/config/config"
import { readDshWebEnabled } from "@/config/wopal-product-settings"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Global } from "@wopal/ellamaka-core/global"
import { updateDshWebEnabled } from "@wopal/wopalspace"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const configGet = Effect.fn("ConfigHttpApi.configGet")(function* () {
      const ellamaka = yield* configSvc.get()
      const pluginConfig = yield* configSvc.getPluginConfig()
      const dshWebEnabled = yield* Effect.promise(() => readDshWebEnabled(Global.Path.wopalHome))
      return { effective: { ellamaka, wopal: { dsh: { web: { enabled: dshWebEnabled } }, pluginConfig } } }
    })

    const configUpdate = Effect.fn("ConfigHttpApi.configUpdate")(function* (ctx) {
      if (ctx.payload.updates.length !== 1) return yield* new HttpApiError.BadRequest({})
      const [update] = ctx.payload.updates
      return yield* Effect.tryPromise({
        try: () => updateDshWebEnabled({ wopalHome: Global.Path.wopalHome, enabled: update.value }),
        catch: () => new HttpApiError.BadRequest({}),
      })
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers
      .handle("get", get)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("update", update)
      .handle("providers", providers)
  }),
)
