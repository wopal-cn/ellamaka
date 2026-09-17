import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion, InstallationChannel } from "@wopal/ellamaka-core/installation/version"
import { GlobalBus } from "@/bus/global"
import { existsSync, readFileSync } from "fs"
import path from "path"
import * as Log from "@wopal/ellamaka-core/util/log"
import semver from "semver"

const log = Log.create({ service: "upgrade" })

/**
 * Whether the given build channel participates in update checks at all.
 *
 * Only the release channel ("stable") is published to the CDN feed; per
 * DESIGN-distribution.md §"Version Identity", development channels ("main"
 * from local build.sh builds and "local" from dev.sh source builds) are never
 * published and must not be compared against or prompted from the release
 * feed. Cross-channel comparisons are explicitly forbidden by the distribution
 * design.
 */
export function isUpdateChannel(channel: string): boolean {
  return channel === "stable"
}

/**
 * Whether `latest` is strictly newer than `current` per SemVer 2.0.
 *
 * Uses `semver.lt` instead of string equality so prerelease builds compare
 * correctly: a dev build (e.g. "2.0.2-main.20260813") that is numerically
 * ahead of the CDN stable (e.g. "2.0.1") is NOT considered an upgrade. A
 * non-SemVer current value (e.g. the "local" dev channel) cannot be compared
 * and is treated as needing an update. An invalid `latest` (malformed CDN
 * manifest) is treated as "no update" instead of throwing.
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  if (!semver.valid(current)) return true
  if (!semver.valid(latest)) return false
  return semver.lt(current, latest)
}

export function readJsoncConfig(filepath: string): Record<string, unknown> | null {
  try {
    let text = readFileSync(filepath, "utf-8")
    text = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function getWorkspaceAutoupdate(spaceRoot?: string): boolean | "notify" | undefined {
  const root = spaceRoot ?? process.env.WOPAL_SPACE_ROOT
  if (!root) return undefined
  const configDir = path.join(root, ".wopal", "config")
  for (const file of ["settings.local.jsonc", "settings.jsonc", "settings.json"]) {
    const filepath = path.join(configDir, file)
    if (!existsSync(filepath)) continue
    const raw = readJsoncConfig(filepath)
    if (raw?.ellamaka && typeof raw.ellamaka === "object") {
      const auto = Reflect.get(raw.ellamaka, "autoupdate")
      if (auto === false || auto === true || auto === "notify") return auto
    }
  }
  return undefined
}

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  const workspaceAutoupdate = getWorkspaceAutoupdate()
  const effectiveAutoupdate = workspaceAutoupdate !== undefined ? workspaceAutoupdate : config.autoupdate

  if (effectiveAutoupdate === false) {
    log.info("autoupdate disabled by config")
    return
  }
  if (Flag.ELLAMAKA_DISABLE_AUTOUPDATE) {
    log.info("autoupdate disabled by ELLAMAKA_DISABLE_AUTOUPDATE flag")
    return
  }

  const latest = await Installation.latest("ellamaka").catch((e) => {
    log.error(`fetch latest version from CDN failed: ${e}`)
    return undefined
  })
  if (!latest) return

  // Only treat a strictly newer stable version (SemVer 2.0) as an upgrade.
  // String equality would misclassify dev builds that are numerically ahead
  // of the CDN stable as "behind", prompting a spurious update notification.
  if (!isUpdateAvailable(InstallationVersion, latest)) {
    log.info(`already latest (${latest})`)
    return
  }

  // Only the release channel ("stable") participates in update checks.
  // Development channels ("main" from local build.sh builds, "local" from
  // dev.sh source builds) are never published to the CDN feed; prompting them
  // would compare a local dev build against the release feed (cross-channel
  // comparison, forbidden by DESIGN-distribution.md) and upgrading would only
  // replace the managed ~/.wopal/bin/ellamaka while the running process keeps
  // its dev binary.
  if (!isUpdateChannel(InstallationChannel)) {
    log.info(`skip update check for ${InstallationChannel} channel build (current ${InstallationVersion}, latest ${latest})`)
    return
  }

  if (Flag.ELLAMAKA_ALWAYS_NOTIFY_UPDATE) {
    log.info(`new version ${latest} (current ${InstallationVersion})`)
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (effectiveAutoupdate === "notify") {
    log.info(`new version ${latest} (current ${InstallationVersion}), notify only`)
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (kind !== "patch") {
    log.info(`new ${kind} version ${latest} (current ${InstallationVersion}), skip auto-upgrade`)
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  log.info(`upgrading from ${InstallationVersion} to ${latest}`)
  await Installation.upgrade("ellamaka", latest)
    .then(() => {
      log.info(`upgraded to ${latest}`)
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      })
    })
    .catch((e) => {
      log.error(`upgrade to ${latest} failed: ${e}`)
    })
}
