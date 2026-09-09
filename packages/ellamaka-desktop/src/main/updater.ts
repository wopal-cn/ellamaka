import { spawnSync } from "node:child_process"
import { app, dialog } from "electron"
import pkg from "electron-updater"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { getLogger } from "./logging"
import { authorizeUpdate, authorizeUpdateFromFeed } from "./updater-policy"
import { checkEngineMajorMinor, checkWopalCliVersion } from "./version-check"

export { authorizeUpdate } from "./updater-policy"
export type { UpdateAuthorizationInput, UpdateAuthorization } from "./updater-policy"

const { autoUpdater } = pkg
type UpdateCheckResult = { updateAvailable: boolean; version?: string; failed?: boolean }
let downloadedVersion: string | undefined
let pendingCheck: Promise<UpdateCheckResult> | undefined

// Resolve the installed wopal-cli version via `wopal --version`. Returns null
// when the binary is missing or the probe fails — callers treat null as
// "skip this check" (never block the update on an unreadable version).
function probeWopalCliVersion(): string | null {
  try {
    const res = spawnSync("wopal", ["--version"], { encoding: "utf8", timeout: 5000 })
    if (res.status === 0 && res.stdout?.trim()) return res.stdout.trim()
  } catch {}
  return null
}

// Resolve the installed ellamaka CLI version via `ellamaka --version`. Returns
// null when the binary is missing or the probe fails — callers treat null as
// "skip this check".
function probeEngineCliVersion(): string | null {
  try {
    const res = spawnSync("ellamaka", ["--version"], { encoding: "utf8", timeout: 5000 })
    if (res.status === 0 && res.stdout?.trim()) return res.stdout.trim()
  } catch {}
  return null
}

export function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = CHANNEL === "beta"
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
}

export async function checkUpdate(): Promise<UpdateCheckResult> {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  if (downloadedVersion) return { updateAvailable: true, version: downloadedVersion }
  if (pendingCheck) return pendingCheck

  pendingCheck = checkAndDownloadUpdate().finally(() => {
    pendingCheck = undefined
  })
  return pendingCheck
}

async function checkAndDownloadUpdate(): Promise<UpdateCheckResult> {
  const logger = getLogger()
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false }
    }
    logger.log("update available", { version })
    // Policy gate (docs/DISTRIBUTION.md §10): authorize BEFORE download.
    // electron-updater only handles platform feed/download/install; the
    // channel/downgrade/manifest-version authorization is decided here.
    //
    // W-07: fetch the feed manifest independently and use its
    // releaseIdentity.version as the authoritative targetManifestVersion.
    // Passing the updater-reported version directly would make the third
    // gate (manifest mismatch) self-proving.
    const targetChannel = version.includes("-beta.") ? "beta" : "stable"
    const feedManifestUrl =
      CHANNEL === "beta"
        ? "https://download.coursedao.com/ellamaka-desktop/beta/latest/manifest.json"
        : "https://download.coursedao.com/ellamaka-desktop/latest/manifest.json"
    const auth = await authorizeUpdateFromFeed({
      fetch: globalThis.fetch,
      feedManifestUrl,
      currentVersion: app.getVersion(),
      currentChannel: CHANNEL === "beta" ? "beta" : "stable",
      targetVersion: version,
      targetChannel,
    })
    if (!auth.authorized) {
      logger.log("update denied by policy gate", {
        reason: auth.reason,
        version,
        failed: auth.failed ?? false,
      })
      return { updateAvailable: false, failed: true }
    }
    logger.log("update authorized", { version, channel: targetChannel })
    // Runtime version gate (docs/DISTRIBUTION.md §6): after policy
    // authorization, before download. The installed wopal-cli must satisfy
    // the protocol floor and the installed ellamaka CLI must share the
    // Desktop's major.minor. A probe failure (binary missing / unreadable)
    // skips that check instead of blocking the update.
    const wopalCliVersion = probeWopalCliVersion()
    const engineCliVersion = probeEngineCliVersion()
    // Each probe failure skips its own check (logged, not blocking): a
    // binary missing from the Electron PATH must not block updates.
    if (wopalCliVersion !== null) {
      const wopal = checkWopalCliVersion(wopalCliVersion, import.meta.env.MIN_WOPAL_CLI_VERSION || "0.3.16")
      if (!wopal.ok) {
        logger.log("update denied by runtime version gate", {
          reason: wopal.reason,
          wopalCliVersion,
          engineCliVersion,
          version,
        })
        return { updateAvailable: false, failed: true }
      }
    } else {
      logger.log("wopal-cli version probe failed, skipping wopal-cli floor check", { version })
    }
    if (engineCliVersion !== null) {
      const engine = checkEngineMajorMinor(app.getVersion(), engineCliVersion)
      if (!engine.ok) {
        logger.log("update denied by runtime version gate", {
          reason: engine.reason,
          wopalCliVersion,
          engineCliVersion,
          version,
        })
        return { updateAvailable: false, failed: true }
      }
    } else {
      logger.log("ellamaka CLI version probe failed, skipping engine major.minor check", { version })
    }
    logger.log("update version gate passed", { wopalCliVersion, engineCliVersion })
    await autoUpdater.downloadUpdate()
    downloadedVersion = version
    logger.log("update download completed", { version })
    return { updateAvailable: true, version }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, failed: true }
  }
}

export async function installUpdate(killSidecar: () => Promise<void>) {
  const result = downloadedVersion ? { updateAvailable: true, version: downloadedVersion } : await checkUpdate()
  const logger = getLogger()
  if (!result.updateAvailable || !downloadedVersion) {
    logger.log("install update skipped", {
      reason: result.failed ? "update check failed" : "no update available",
    })
    return
  }
  logger.log("installing downloaded update", {
    version: result.version ?? null,
  })
  await killSidecar()
  autoUpdater.quitAndInstall()
}

export async function checkForUpdates(alertOnFail: boolean, killSidecar: () => Promise<void>) {
  if (!UPDATER_ENABLED) return
  const logger = getLogger()
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate(killSidecar)
  }
}
