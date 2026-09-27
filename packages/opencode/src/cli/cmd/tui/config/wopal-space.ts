export * as TuiConfigWopalSpace from "./wopal-space"

import path from "path"
import { Effect } from "effect"
import * as Log from "@wopal/ellamaka-core/util/log"
import { Global } from "@wopal/ellamaka-core/global"
import { ConfigParse } from "@/config/parse"
import { ConfigWopalPluginConfig } from "@/config/wopal-plugin-config"
import type { PluginConfigTable } from "@/config/wopal-plugin-config"
import { loadWopalSpaceSettingsFiles } from "@/config/wopal-space-settings"
import type { Info } from "./tui"

const log = Log.create({ service: "tui.config" })

export interface WopalSpaceDeps {
  readConfigFile: (filepath: string) => Effect.Effect<string | undefined, never, never>
  loadConfig: (text: string, configFilepath: string) => Effect.Effect<Info>
  merge: (source: string, next: Info) => Effect.Effect<void>
}

export interface WopalSpaceResult {
  dirs: string[]
  pluginConfig: PluginConfigTable
}

export function tryLoadWopalSpaceTuiConfig(deps: WopalSpaceDeps, ctx: { directory: string }) {
  return Effect.gen(function* () {
    const loaded = yield* loadWopalSpaceSettingsFiles(deps, ctx)
    if (!loaded) {
      return undefined
    }

    // Same three-layer `wopal.pluginConfig` merge as the engine config chain:
    // the global settings file plus the already-loaded space layer texts.
    const globalSettingsPath = path.join(Global.Path.config, "settings.jsonc")
    const globalSettings = yield* deps.readConfigFile(globalSettingsPath)
    const { pluginConfig } = ConfigWopalPluginConfig.mergePluginConfig([
      { source: "global", path: globalSettingsPath, text: globalSettings },
      ...loaded.files.map((file) => ({
        source: ConfigWopalPluginConfig.settingsFileSource(file.path),
        path: file.path,
        text: file.text,
      })),
    ])

    for (const file of loaded.files) {
      const raw = ConfigParse.jsonc(file.text, file.path) as Record<string, unknown>
      if (!raw.tui || typeof raw.tui !== "object") continue
      yield* deps.merge(
        file.path,
        yield* deps.loadConfig(JSON.stringify(raw.tui), file.path).pipe(
          Effect.catchDefect((err: unknown) => {
            log.warn("failed to parse tui config, skipping", {
              path: file.path,
              error: err instanceof Error ? err.message : String(err),
            })
            return Effect.succeed({} as Info)
          }),
        ),
      )
      log.info("loaded tui config", { path: file.path })
    }

    return {
      dirs: loaded.localWopalDirs,
      pluginConfig,
    } satisfies WopalSpaceResult
  })
}
