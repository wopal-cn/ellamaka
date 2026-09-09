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
 * Decide whether auto-upgrade should be skipped for the given build channel.
 *
 * Only the stable release channel ("latest") participates in CDN auto-upgrade.
 * Dev builds ("main"), local debug runs ("local"), and any other preview
 * channel are not published to the CDN stable manifest; auto-upgrading them
 * would silently replace a dev/local binary with the stable one, losing the
 * developer's build.
 */
export function shouldSkipAutoUpgrade(channel: string, currentVersion: string): boolean {
  return channel !== "latest"
}

/**
 * Whether the update-available notification should be shown for this build.
 *
 * A source checkout ("local" channel) never notifies: there is no binary to
 * upgrade — the install transaction would only replace `~/.wopal/bin/ellamaka`
 * while the running process keeps executing from the source tree, so the
 * dialog would be a dead end. Preview builds ("main"/"beta"/"prod") notify so
 * testers see newer releases; stable notifies per SemVer comparison.
 */
export function shouldNotifyUpdate(channel: string, currentVersion: string, latest: string): boolean {
  if (channel === "local") return false
  return isUpdateAvailable(currentVersion, latest)
}

/**
 * Whether `latest` is strictly newer than `current` per SemVer 2.0.
 *
 * Uses `semver.lt` instead of string equality so prerelease builds compare
 * correctly: a dev build (e.g. "2.0.2-main.20260813") that is numerically
 * ahead of the CDN stable (e.g. "2.0.1") is NOT considered an upgrade. A
 * non-SemVer current value (e.g. the "local" dev channel) cannot be compared
 * and is treated as needing an update.
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  if (!semver.valid(current)) return true
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
      const auto = (raw.ellamaka as Record<string, unknown>).autoupdate
      if (auto === false || auto === "notify") return auto as boolean | "notify"
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
  if (Flag.OPENCODE_DISABLE_AUTOUPDATE) {
    log.info("autoupdate disabled by OPENCODE_DISABLE_AUTOUPDATE flag")
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

  // A source checkout ("local" channel) has no binary to upgrade — the
  // install transaction would only replace ~/.wopal/bin/ellamaka while the
  // running process keeps executing from the source tree. Stay silent.
  if (InstallationChannel === "local") {
    log.info(`local source build (current ${InstallationVersion}), skip update check`)
    return
  }

  // Non-stable channels (preview builds) are not published to the CDN stable
  // manifest. Auto-upgrading them would replace the binary. Notify only.
  if (shouldSkipAutoUpgrade(InstallationChannel, InstallationVersion)) {
    log.info(`skip auto-upgrade for ${InstallationChannel} channel build (current ${InstallationVersion}, latest ${latest})`)
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
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
