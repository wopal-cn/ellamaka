import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { app } from "electron"

type PackageMetadata = {
  ellamakaBuild?: unknown
}

export type ReleaseInfo = {
  version: string
  build?: string
  displayVersion: string
}

/** Legacy release-info surface retained for human-facing display. */
export function createReleaseInfo(version: string, build?: string): ReleaseInfo {
  const normalizedBuild = build?.trim() || undefined
  return {
    version,
    build: normalizedBuild,
    displayVersion: normalizedBuild ? `${version} (${normalizedBuild.slice(0, 12)})` : version,
  }
}

type DesktopFeedChannel = "main" | "beta" | "stable"

type EmbeddedIdentity = {
  schemaVersion: 2
  kind: "release" | "development"
  product: string
  version: string
  channel: string
  upstream?: unknown
  build?: unknown
}

const IDENTITY_FILE = "release-identity.json"

/**
 * Read the embedded release-identity.json from a resources directory.
 * Returns null if the file is missing or corrupt (fail-closed; callers
 * must treat absence as "unconfirmed identity").
 */
export function readEmbeddedReleaseIdentity(resourcesDir: string): EmbeddedIdentity | null {
  const p = join(resourcesDir, IDENTITY_FILE)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"))
    if (!raw || typeof raw !== "object") return null
    if (raw.schemaVersion !== 2) return null
    if (raw.kind !== "release" && raw.kind !== "development") return null
    return raw as EmbeddedIdentity
  } catch {
    return null
  }
}

type AppMetadata = {
  version: string
  channel: DesktopFeedChannel
}

const FEED_TO_IDENTITY_CHANNEL: Record<DesktopFeedChannel, string> = {
  stable: "stable",
  beta: "beta",
  main: "local",
}

/**
 * Validate that an embedded identity is consistent with the current app
 * package metadata (version + feed channel). Development identities are
 * allowed to carry a dev version that differs from app.getVersion(); only
 * product must match. Release identities must match product, version and
 * channel.
 */
export function validateEmbeddedIdentity(identity: EmbeddedIdentity, meta: AppMetadata): void {
  if (identity.product !== "ellamaka-desktop") {
    throw new Error(`embedded identity product ${identity.product} is not ellamaka-desktop`)
  }
  if (identity.kind === "development") {
    // Dev identity channel must map from the feed channel.
    const expectedChannel = FEED_TO_IDENTITY_CHANNEL[meta.channel]
    if (identity.channel !== expectedChannel && identity.channel !== "local") {
      throw new Error(`development identity channel ${identity.channel} mismatches feed ${meta.channel}`)
    }
    return
  }
  // Release identity: strict version + channel match.
  if (identity.version !== meta.version) {
    throw new Error(`embedded identity version ${identity.version} mismatches app version ${meta.version}`)
  }
  const expectedChannel = FEED_TO_IDENTITY_CHANNEL[meta.channel]
  if (identity.channel !== expectedChannel) {
    throw new Error(
      `embedded identity channel ${identity.channel} mismatches feed ${meta.channel} (expected ${expectedChannel})`,
    )
  }
}
export function getReleaseInfo(): ReleaseInfo {
  let version = app.getVersion()
  let build: string | undefined

  try {
    const resourcesPath = process.resourcesPath || join(app.getAppPath(), "resources")
    const embedded = readEmbeddedReleaseIdentity(resourcesPath)
    if (embedded?.version) {
      version = embedded.version
    }
    if (typeof embedded?.build === "string") {
      build = embedded.build
    } else if (embedded?.build && typeof (embedded.build as any).gitCommit === "string") {
      build = (embedded.build as any).gitCommit
    }
  } catch {}

  if (process.env.OPENCODE_VERSION?.trim()) {
    version = process.env.OPENCODE_VERSION.trim()
  }
  if (!build && process.env.OPENCODE_BUILD_ID?.trim()) {
    build = process.env.OPENCODE_BUILD_ID.trim()
  }

  if (!build) {
    try {
      const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as PackageMetadata
      if (typeof metadata.ellamakaBuild === "string") build = metadata.ellamakaBuild
    } catch {}
  }

  if (!build) {
    try {
      const res = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
        cwd: app.getAppPath(),
        encoding: "utf8",
        timeout: 1500,
      })
      if (res.status === 0 && res.stdout?.trim()) {
        build = res.stdout.trim()
      }
    } catch {}
  }

  return createReleaseInfo(version, build)
}
