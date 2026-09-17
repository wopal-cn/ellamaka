import semver from "semver"
import path from "path"
import { parseReleaseVersion } from "./identity"
import { resolveBuildChannel, type BuildChannel } from "./channel-resolve"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

// Build interface env (D-02): ELLAMAKA_VERSION / ELLAMAKA_RELEASE /
// ELLAMAKA_CHANNEL. The legacy OPENCODE_* names are no longer read.
const env = {
  ELLAMAKA_CHANNEL: process.env["ELLAMAKA_CHANNEL"],
  ELLAMAKA_VERSION: process.env["ELLAMAKA_VERSION"],
  ELLAMAKA_RELEASE: process.env["ELLAMAKA_RELEASE"],
}

const IS_RELEASE = !!env.ELLAMAKA_RELEASE

// D-03: release builds derive the channel from the version shape
// (`-beta.N` → beta; rc and plain semver → stable) via the identity layer's
// canonical parser; an explicit ELLAMAKA_CHANNEL that contradicts the
// derivation fails the build (fail-closed). Local builds take
// ELLAMAKA_CHANNEL against the closed vocabulary (out-of-vocabulary values
// throw) and default to "local" when unset.
const CHANNEL: BuildChannel = (() => {
  if (IS_RELEASE) {
    const derived = parseReleaseVersion(env.ELLAMAKA_VERSION ?? "").channel
    if (env.ELLAMAKA_CHANNEL && env.ELLAMAKA_CHANNEL !== derived) {
      throw new Error(
        `ELLAMAKA_CHANNEL=${env.ELLAMAKA_CHANNEL} contradicts version ${env.ELLAMAKA_VERSION} (derived channel: ${derived}); release channel is decided by the version shape`,
      )
    }
    return derived
  }
  return env.ELLAMAKA_CHANNEL ? resolveBuildChannel(env.ELLAMAKA_CHANNEL) : "local"
})()

const IS_PREVIEW = !IS_RELEASE

// The CLI product anchor is the repo's single version truth
// (docs/DISTRIBUTION.md §3.2). Upstream opencode derived a version from the
// npm registry here; after abandoning upstream version tracking, the anchor
// file is authoritative. Injected versions (release: ELLAMAKA_VERSION set
// by CI after the anchor match gate) take precedence.
const VERSION = await (async () => {
  if (env.ELLAMAKA_VERSION) return env.ELLAMAKA_VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const anchorPkg = await Bun.file(path.resolve(import.meta.dir, "../../ellamaka-cli/package.json"))
    .json()
    .catch(() => null)
  return (anchorPkg as any)?.version || "0.0.0-dev"
})()

const bot = ["actions-user", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return IS_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`opencode script`, JSON.stringify(Script, null, 2))

// Re-exported so build-env remains the single resolution entry point for
// Bun-side callers; pure-Node build contexts import channel-resolve directly.
export { resolveBuildChannel }
