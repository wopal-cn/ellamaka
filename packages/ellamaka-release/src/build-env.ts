import { $ } from "bun"
import semver from "semver"
import path from "path"

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

const env = {
  OPENCODE_CHANNEL: process.env["OPENCODE_CHANNEL"],
  OPENCODE_BUMP: process.env["OPENCODE_BUMP"],
  OPENCODE_VERSION: process.env["OPENCODE_VERSION"],
  OPENCODE_RELEASE: process.env["OPENCODE_RELEASE"],
}
const KNOWN_CHANNELS = ["main", "beta", "prod", "latest", "local"] as const

const CHANNEL = await (async () => {
  if (env.OPENCODE_CHANNEL) return env.OPENCODE_CHANNEL
  if (env.OPENCODE_BUMP) return "latest"
  if (env.OPENCODE_VERSION && !env.OPENCODE_VERSION.startsWith("0.0.0-")) return "latest"
  // Historical fallback returned the current git branch name unconditionally.
  // That is dangerous for sidecar builds (build-node.ts) in feature worktrees:
  // the branch name gets baked into dist/node/node.js as OPENCODE_CHANNEL,
  // producing per-branch db files (e.g. ellamaka-<branch>.db) and fragmenting
  // session data. Only known release channels are accepted from git; any other
  // branch falls back to "local", matching dev.sh's explicit
  // OPENCODE_CHANNEL=local.
  const branch = await $`git branch --show-current`.text().then((x) => x.trim())
  return (KNOWN_CHANNELS as readonly string[]).includes(branch) ? branch : "local"
})()
const IS_PREVIEW = CHANNEL !== "latest"

// The CLI product anchor is the repo's single version truth
// (docs/DISTRIBUTION.md §3.2). Upstream opencode derived a version from the
// npm registry here; after abandoning upstream version tracking, the anchor
// file is authoritative. Injected versions (release: OPENCODE_VERSION set
// by CI after the anchor match gate) take precedence.
const VERSION = await (async () => {
  if (env.OPENCODE_VERSION) return env.OPENCODE_VERSION
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
    return !!env.OPENCODE_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`opencode script`, JSON.stringify(Script, null, 2))
