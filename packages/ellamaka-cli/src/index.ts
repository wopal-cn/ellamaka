#!/usr/bin/env bun

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { AccountV2 } from "@wopal/ellamaka-core/account"
import { AgentV2 } from "@wopal/ellamaka-core/agent"
import { Catalog } from "@wopal/ellamaka-core/catalog"
import { Config } from "@wopal/ellamaka-core/config"
import { EventV2 } from "@wopal/ellamaka-core/event"
import { Location } from "@wopal/ellamaka-core/location"
import { Npm } from "@wopal/ellamaka-core/npm"
import { PluginV2 } from "@wopal/ellamaka-core/plugin"
import { PluginBoot } from "@wopal/ellamaka-core/plugin/boot"
import { Policy } from "@wopal/ellamaka-core/policy"
import { AbsolutePath } from "@wopal/ellamaka-core/schema"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Command from "effect/unstable/cli/Command"
import { DebugCommand } from "./debug"

const cli = Command.make("opencode", {}, () => Effect.void).pipe(
  Command.withDescription("OpenCode command line interface"),
  Command.withSubcommands([DebugCommand]),
)

const locationLayer = Location.defaultLayer({
  directory: AbsolutePath.make(process.cwd()),
})

const policyLayer = Policy.defaultLayer.pipe(Layer.provideMerge(locationLayer))
const pluginLayer = PluginV2.defaultLayer
const eventLayer = EventV2.defaultLayer

const layer = PluginBoot.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      Catalog.layer.pipe(Layer.provideMerge(Layer.mergeAll(eventLayer, pluginLayer, policyLayer))),
      eventLayer,
      pluginLayer,
      AccountV2.defaultLayer,
      AgentV2.defaultLayer,
      Config.defaultLayer.pipe(Layer.provideMerge(policyLayer)),
      Npm.defaultLayer,
    ),
  ),
)

Command.run(cli, { version: "local" }).pipe(Effect.provide(layer), Effect.scoped, NodeRuntime.runMain)
