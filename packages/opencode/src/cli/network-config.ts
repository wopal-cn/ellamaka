export * as CliNetworkConfig from "./network-config"

import { mergeDeep } from "remeda"
import { Effect } from "effect"
import * as Log from "@wopal/ellamaka-core/util/log"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Global } from "@wopal/ellamaka-core/global"
import { ConfigParse } from "@/config/parse"
import { loadWopalSpaceSettingsFiles } from "@/config/wopal-space-settings"
import type { Config } from "@/config/config"

const log = Log.create({ service: "cli.network" })

/**
 * The `server` block of the effective ellamaka configuration, resolved through
 * the same three-tier merge every other config field follows (DESIGN §4):
 * global `~/.wopal/config/settings.jsonc`, then the space's public
 * `.wopal/config/settings.jsonc`, then its private `settings.local.jsonc`
 * overlaying both. The merge is `remeda`'s `mergeDeep` — the exact function the
 * instance-level config merge uses — so precedence here can never drift from
 * the rest of the config. Arrays replace wholesale (including `cors`).
 *
 * The command line resolves its network options before any instance exists, so
 * it cannot read through `Config.Service.get()` (that is instance-scoped). The
 * space tiers are read by walking up from the working directory to the space
 * root, exactly like the instance-level loader — a space is detected by its
 * `.wopal` marker, not by any environment gate, so a plain `ellamaka serve`
 * inside a space picks up that space's settings.
 */
export function resolveServerConfig(directory: string, global: Config.Info["server"]) {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const loaded = yield* loadWopalSpaceSettingsFiles(
      { readConfigFile: (filepath) => fs.readFileStringSafe(filepath).pipe(Effect.orDie) },
      { directory },
    )
    if (!loaded) return global

    let result = global
    for (const file of loaded.files) {
      const server = readServerBlock(file.text, file.path)
      if (!server) continue
      result = mergeDeep(result ?? {}, server) as Config.Info["server"]
      log.info("loaded server config", { path: file.path })
    }
    return result
  })
}

/**
 * Read the `server` block out of one raw settings file. The file may place the
 * ellamaka fields behind an `ellamaka` key (the space convention); a bare file
 * is read as-is. Malformed JSON is skipped, never fatal — a broken optional
 * settings file must not stop the CLI from starting with defaults.
 */
function readServerBlock(text: string, filepath: string): Record<string, unknown> | undefined {
  let raw: unknown
  try {
    raw = ConfigParse.jsonc(text, filepath)
  } catch (error) {
    log.warn("failed to parse server config, skipping", {
      path: filepath,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const ellamaka = isRecord(raw.ellamaka) ? raw.ellamaka : undefined
  if (ellamaka && isRecord(ellamaka.server)) return ellamaka.server
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
