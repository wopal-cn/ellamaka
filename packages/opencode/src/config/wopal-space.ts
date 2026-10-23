import path from "path"
import { mergeDeep } from "remeda"
import * as Log from "@wopal/ellamaka-core/util/log"
import { Global } from "@wopal/ellamaka-core/global"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { collectPluginDependencies, type InstallDependency } from "@wopal/ellamaka-core/plugin-dependencies"
import { ConfigParse } from "./parse"
import { ConfigCommand } from "./command"
import { ConfigAgent } from "./agent"
import { ConfigPlugin } from "./plugin"
import { loadWopalSpaceSettingsFiles } from "./wopal-space-settings"
import { mergePluginConfig, settingsFileSource } from "./wopal-plugin-config"
import type { PluginConfigSources, PluginConfigTable } from "./wopal-plugin-config"
import { Effect } from "effect"
import type { Info } from "./config"
import type { ConsoleState } from "./console-state"

const log = Log.create({ service: "config" })

export type { InstallDependency }

export async function localPluginInstallDeps(dir: string): Promise<InstallDependency[]> {
  return (await collectPluginDependencies(dir)).deps
}

export interface WopalSpaceDeps {
  readConfigFile: (filepath: string) => Effect.Effect<string | undefined, never, never>
  loadConfig: (
    text: string,
    options: { path: string } | { dir: string; source: string },
  ) => Effect.Effect<Info, never, never>
  getGlobal: () => Effect.Effect<Info, never, never>
  merge: (source: string, next: Info, kind?: ConfigPlugin.Scope) => Effect.Effect<void, never, never>
  mergePluginOrigins: (
    source: string,
    list: ConfigPlugin.Spec[] | undefined,
    kind?: ConfigPlugin.Scope,
  ) => Effect.Effect<void, never, never>
  applyPostMerge: () => void
  initContainers: () => void
  getResult: () => Info
}

export interface WopalSpaceResult {
  config: Info
  directories: string[]
  consoleState: ConsoleState
  pluginConfig: PluginConfigTable
  pluginConfigSources: PluginConfigSources
}

export function tryLoadWopalSpaceConfig(
  deps: WopalSpaceDeps,
  ctx: {
    directory: string
  },
) {
  return Effect.gen(function* () {
    if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      return undefined
    }

    const settings = yield* loadWopalSpaceSettingsFiles(deps, { directory: ctx.directory })
    if (!settings) {
      return undefined
    }

    const directories = settings.directories
    const localWopalDirs = settings.localWopalDirs

    // Independent `wopal.pluginConfig` channel: the `wopal` section is not part
    // of the engine Config schema, so it never travels through the whitelist
    // merge below. The global layer is read here on top of the already-loaded
    // space settings texts (no second file read for space layers).
    const globalSettingsPath = path.join(Global.Path.config, "settings.jsonc")
    const globalSettings = yield* deps.readConfigFile(globalSettingsPath)
    const { pluginConfig, sources: pluginConfigSources } = mergePluginConfig([
      { source: "global", path: globalSettingsPath, text: globalSettings },
      ...settings.files.map((file) => ({
        source: settingsFileSource(file.path),
        path: file.path,
        text: file.text,
      })),
    ])

    const global = yield* deps.getGlobal()
    yield* deps.merge(Global.Path.config, global, "global")

    for (const dir of localWopalDirs) {
      let loaded = false
      for (const file of settings.files) {
        if (file.dir !== dir) continue
        const raw = ConfigParse.jsonc(file.text, file.path) as Record<string, unknown>
        if (raw?.ellamaka && typeof raw.ellamaka === "object") {
          yield* deps.merge(
            file.path,
            yield* deps
              .loadConfig(JSON.stringify(raw.ellamaka), {
                dir: path.dirname(file.path),
                source: file.path,
              })
              .pipe(
                Effect.catchDefect((err: unknown) => {
                  log.warn("failed to parse ellamaka config, skipping", {
                    path: file.path,
                    error: err instanceof Error ? err.message : String(err),
                  })
                  return Effect.succeed({} as Info)
                }),
              ),
          )
          loaded = true
        }
      }
      if (!loaded) {
        log.warn("wopal space detected but no settings.jsonc or settings.local.jsonc with ellamaka field found", {
          dir,
        })
      }
    }

    deps.initContainers()

    for (const dir of directories) {
      if (dir === Global.Path.config) continue
      yield* deps.merge(dir, {
        command: yield* Effect.promise(() => ConfigCommand.load(dir)),
        agent: mergeDeep(
          mergeDeep({}, yield* Effect.promise(() => ConfigAgent.load(dir))),
          yield* Effect.promise(() => ConfigAgent.loadMode(dir)),
        ),
      } as Info)
      if (!Flag.OPENCODE_PURE) {
        const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
        yield* deps.mergePluginOrigins(dir, list)
      }
    }

    if (process.env.OPENCODE_CONFIG_CONTENT) {
      const source = "OPENCODE_CONFIG_CONTENT"
      const next = yield* deps.loadConfig(process.env.OPENCODE_CONFIG_CONTENT, {
        dir: ctx.directory,
        source,
      })
      yield* deps.merge(source, next, "local")
      log.debug("loaded custom config from OPENCODE_CONFIG_CONTENT")
    }

    deps.applyPostMerge()

    const result = deps.getResult()

    return {
      config: result,
      directories,
      consoleState: {
        consoleManagedProviders: [],
        activeOrgName: undefined,
        switchableOrgCount: 0,
      },
      pluginConfig,
      pluginConfigSources,
    } satisfies WopalSpaceResult
  })
}

export * as ConfigWopalSpace from "./wopal-space"
