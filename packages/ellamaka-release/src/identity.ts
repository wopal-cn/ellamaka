import fs from "fs"

const PRODUCTS = ["ellamaka-cli", "ellamaka-desktop"] as const
const RELEASE_CHANNELS = ["stable", "beta"] as const
const DEV_CHANNELS = ["local", "main"] as const
const COMMIT_RE = /^[0-9a-f]{40}$/
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SEMVER_BETA_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/
const SEMVER_RC_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/
const LEGACY_STABLE_ITERATION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(\d+)$/
const LEGACY_RC_ITERATION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(\d+)\.rc(\d+)$/
const NAMESPACED_TAG_RE = /^(ellamaka-cli|ellamaka-desktop)-v(.+)$/
const FEED_TO_CHANNEL = { prod: "stable", beta: "beta" } as const

export type Product = (typeof PRODUCTS)[number]
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number]
export type DevChannel = (typeof DEV_CHANNELS)[number]
export type Prerelease = { kind: "beta" | "rc"; n: number }

export type ParsedVersion = {
  major: number
  minor: number
  patch: number
  prerelease: Prerelease | null
  channel: ReleaseChannel
}

export type Upstream = {
  name: "opencode"
  version: string
  gitCommit: string
}

export type UpstreamLock = {
  schemaVersion: 1
  sources: { opencode: { version: string; gitCommit: string } }
}

export type ReleaseBuild = {
  sourceTag: string
  gitCommit: string
  builtAt: string
  workflowRunId: string
}

export type DevBuild = {
  gitCommit?: string
  builtAt?: string
}

export type ReleaseIdentity =
  | {
      schemaVersion: 2
      kind: "release"
      product: Product
      version: string
      channel: ReleaseChannel
      upstream: Upstream
      build: ReleaseBuild
    }
  | {
      schemaVersion: 2
      kind: "development"
      product: Product
      version: string
      channel: DevChannel
      build: DevBuild
    }

export type LegacyVersion =
  | {
      kind: "legacy"
      legacyShape: "stable-iteration"
      major: number
      minor: number
      patch: number
      iteration: number
      convertibleToRelease: false
    }
  | {
      kind: "legacy"
      legacyShape: "rc-iteration"
      major: number
      minor: number
      patch: number
      iteration: number
      rcN: number
      convertibleToRelease: false
    }

export class ReleaseIdentityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "ReleaseIdentityError"
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new ReleaseIdentityError(code, message)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("EINVAL", "identity must be an object")
  }
  return value as Record<string, unknown>
}

function isProduct(value: unknown): value is Product {
  return typeof value === "string" && (PRODUCTS as readonly string[]).includes(value)
}

function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === "string" && (RELEASE_CHANNELS as readonly string[]).includes(value)
}

function isDevChannel(value: unknown): value is DevChannel {
  return typeof value === "string" && (DEV_CHANNELS as readonly string[]).includes(value)
}

function assertNoExtra(object: Record<string, unknown>, allowed: Set<string>, where: string) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail("ESCHEMA", `unexpected field ${where}.${key}`)
  }
}

export function parseReleaseVersion(version: string): ParsedVersion {
  if (typeof version !== "string") fail("EINVAL", "version must be a string")
  if (version.includes("+")) {
    fail("EBUILD", `version ${version} contains +build metadata, which is forbidden`)
  }

  let match = version.match(SEMVER_BETA_RE)
  if (match) {
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: { kind: "beta", n: Number(match[4]) },
      channel: "beta",
    }
  }

  match = version.match(SEMVER_RC_RE)
  if (match) {
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: { kind: "rc", n: Number(match[4]) },
      channel: "stable",
    }
  }

  match = version.match(SEMVER_RE)
  if (match) {
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      prerelease: null,
      channel: "stable",
    }
  }

  if (LEGACY_STABLE_ITERATION_RE.test(version) || LEGACY_RC_ITERATION_RE.test(version)) {
    fail("ELEGACY", `version ${version} is a legacy X.Y.Z-N shape; use standard SemVer for new releases`)
  }
  fail("EINVAL", `version ${version} is not a valid Ellamaka SemVer subset`)
}

export function normalizeFeedChannel(feed: string): string {
  return FEED_TO_CHANNEL[feed as keyof typeof FEED_TO_CHANNEL] ?? feed
}

export function assertChannelVersionConsistent(channel: string, version: string) {
  if (!isReleaseChannel(channel)) {
    fail("ECHANNEL", `unknown release channel ${channel}; release channels are ${RELEASE_CHANNELS.join(", ")}`)
  }
  const parsed = parseReleaseVersion(version)
  if (channel === "stable" && parsed.channel !== "stable") {
    fail("ECHANNEL", `stable channel cannot carry prerelease version ${version}`)
  }
  if (channel === "beta" && parsed.channel !== "beta") {
    fail("ECHANNEL", `beta channel requires -beta.N version, got ${version}`)
  }
}

export function buildNamespacedTag(product: Product, version: string): string {
  if (!isProduct(product)) fail("EPRODUCT", `unknown product ${product}`)
  parseReleaseVersion(version)
  return `${product}-v${version}`
}

export function parseNamespacedTag(tag: string): { product: Product; version: string } {
  const match = tag.match(NAMESPACED_TAG_RE)
  if (!match) {
    fail("ENAMESPACED", `tag ${tag} is not a namespaced product tag (ellamaka-{cli,desktop}-vX.Y.Z)`)
  }
  return { product: match[1] as Product, version: match[2]! }
}

export function loadUpstreamLock(path: string): unknown {
  return JSON.parse(fs.readFileSync(path, "utf8"))
}

export function validateUpstreamLock(lock: unknown): UpstreamLock {
  const raw = asRecord(lock)
  if (raw.schemaVersion !== 1) fail("ESCHEMA", "upstream lock schemaVersion must be 1")
  const sources = raw.sources
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    fail("ESCHEMA", "upstream lock missing sources.opencode")
  }
  const source = (sources as Record<string, unknown>).opencode
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("ESCHEMA", "upstream lock missing sources.opencode")
  }
  const opencode = source as Record<string, unknown>
  if (typeof opencode.version !== "string" || !SEMVER_RE.test(opencode.version)) {
    fail("EVERSION", `upstream version ${String(opencode.version)} is not stable SemVer`)
  }
  if (typeof opencode.gitCommit !== "string" || !COMMIT_RE.test(opencode.gitCommit)) {
    fail("ECOMMIT", `upstream gitCommit ${String(opencode.gitCommit)} is not a 40-char SHA`)
  }
  return lock as UpstreamLock
}

export function buildReleaseIdentity(input: {
  product: Product
  version: string
  channel: ReleaseChannel
  upstreamLock: unknown
  gitCommit: string
  builtAt: string
  workflowRunId: string | number
}): Extract<ReleaseIdentity, { kind: "release" }> {
  if (!isProduct(input.product)) fail("EPRODUCT", `unknown product ${input.product}`)
  const validated = validateUpstreamLock(input.upstreamLock)
  assertChannelVersionConsistent(input.channel, input.version)

  if (!COMMIT_RE.test(input.gitCommit)) {
    fail("ECOMMIT", `build.gitCommit ${input.gitCommit} is not a 40-char SHA`)
  }
  if (!ISO8601_RE.test(input.builtAt)) {
    fail("ETIME", `build.builtAt ${input.builtAt} is not ISO-8601 UTC`)
  }
  if (!input.workflowRunId) fail("ERUN", "build.workflowRunId is required for release identity")

  const source = validated.sources.opencode
  return {
    schemaVersion: 2,
    kind: "release",
    product: input.product,
    version: input.version,
    channel: input.channel,
    upstream: {
      name: "opencode",
      version: source.version,
      gitCommit: source.gitCommit,
    },
    build: {
      sourceTag: buildNamespacedTag(input.product, input.version),
      gitCommit: input.gitCommit,
      builtAt: input.builtAt,
      workflowRunId: String(input.workflowRunId),
    },
  }
}

export function parseReleaseIdentity(input: unknown): ReleaseIdentity {
  const raw = asRecord(input)
  if (raw.schemaVersion !== 2) fail("ESCHEMA", "schemaVersion must be 2")
  if (!isProduct(raw.product)) fail("EPRODUCT", `unknown product ${String(raw.product)}`)
  if (typeof raw.version !== "string") fail("EINVAL", "version must be a string")
  if (raw.version.includes("+")) {
    fail("EBUILD", `version ${raw.version} contains +build metadata, which is forbidden`)
  }

  if (raw.kind === "release") return parseReleaseKind(raw, raw.product, raw.version)
  if (raw.kind === "development") return parseDevelopmentKind(raw, raw.product, raw.version)
  fail("EKIND", `unknown kind ${String(raw.kind)}; expected release|development`)
}

function parseReleaseKind(
  input: Record<string, unknown>,
  product: Product,
  version: string,
): Extract<ReleaseIdentity, { kind: "release" }> {
  if (!isReleaseChannel(input.channel)) {
    fail("ECHANNEL", `release identity channel ${String(input.channel)} is not a release channel`)
  }
  assertChannelVersionConsistent(input.channel, version)

  const build = input.build && typeof input.build === "object" && !Array.isArray(input.build) ? input.build : {}
  const rawBuild = build as Record<string, unknown>
  assertNoExtra(rawBuild, new Set(["sourceTag", "gitCommit", "builtAt", "workflowRunId"]), "build")
  if (typeof rawBuild.sourceTag !== "string" || !rawBuild.sourceTag) {
    fail("ESOURCETAG", "release identity build.sourceTag is required")
  }
  if (typeof rawBuild.gitCommit !== "string" || !COMMIT_RE.test(rawBuild.gitCommit)) {
    fail("ECOMMIT", `release identity build.gitCommit ${String(rawBuild.gitCommit)} is not a 40-char SHA`)
  }
  if (typeof rawBuild.builtAt !== "string" || !ISO8601_RE.test(rawBuild.builtAt)) {
    fail("ETIME", "release identity build.builtAt is not ISO-8601 UTC")
  }
  if (rawBuild.workflowRunId === undefined || rawBuild.workflowRunId === null || rawBuild.workflowRunId === "") {
    fail("ERUN", "release identity build.workflowRunId is required")
  }

  const upstream = input.upstream && typeof input.upstream === "object" && !Array.isArray(input.upstream) ? input.upstream : {}
  const rawUpstream = upstream as Record<string, unknown>
  if (rawUpstream.name !== "opencode") fail("EUPSTREAM", "upstream.name must be opencode")
  if (typeof rawUpstream.version !== "string" || !SEMVER_RE.test(rawUpstream.version)) {
    fail("EVERSION", `upstream.version ${String(rawUpstream.version)} is not stable SemVer`)
  }
  if (typeof rawUpstream.gitCommit !== "string" || !COMMIT_RE.test(rawUpstream.gitCommit)) {
    fail("ECOMMIT", `upstream.gitCommit ${String(rawUpstream.gitCommit)} is not a 40-char SHA`)
  }

  return {
    schemaVersion: 2,
    kind: "release",
    product,
    version,
    channel: input.channel,
    upstream: { name: "opencode", version: rawUpstream.version, gitCommit: rawUpstream.gitCommit },
    build: {
      sourceTag: rawBuild.sourceTag,
      gitCommit: rawBuild.gitCommit,
      builtAt: rawBuild.builtAt,
      workflowRunId: String(rawBuild.workflowRunId),
    },
  }
}

function parseDevelopmentKind(
  input: Record<string, unknown>,
  product: Product,
  version: string,
): Extract<ReleaseIdentity, { kind: "development" }> {
  if (!isDevChannel(input.channel)) {
    fail("ECHANNEL", `development identity channel ${String(input.channel)} is not a dev channel (local|main)`)
  }

  const build = input.build && typeof input.build === "object" && !Array.isArray(input.build) ? input.build : {}
  const rawBuild = build as Record<string, unknown>
  assertNoExtra(rawBuild, new Set(["gitCommit", "builtAt"]), "build")
  if (rawBuild.sourceTag !== undefined) {
    fail("ESOURCETAG", "development identity must not carry build.sourceTag")
  }
  if (rawBuild.workflowRunId !== undefined) {
    fail("ERUN", "development identity must not carry build.workflowRunId")
  }
  if (rawBuild.gitCommit !== undefined && (typeof rawBuild.gitCommit !== "string" || !COMMIT_RE.test(rawBuild.gitCommit))) {
    fail("ECOMMIT", `development identity build.gitCommit ${String(rawBuild.gitCommit)} is not a 40-char SHA`)
  }
  if (rawBuild.builtAt !== undefined && (typeof rawBuild.builtAt !== "string" || !ISO8601_RE.test(rawBuild.builtAt))) {
    fail("ETIME", "development identity build.builtAt is not ISO-8601 UTC")
  }

  return {
    schemaVersion: 2,
    kind: "development",
    product,
    version,
    channel: input.channel,
    build: {
      ...(typeof rawBuild.gitCommit === "string" ? { gitCommit: rawBuild.gitCommit } : {}),
      ...(typeof rawBuild.builtAt === "string" ? { builtAt: rawBuild.builtAt } : {}),
    },
  }
}

export function parseLegacyVersion(version: string): LegacyVersion {
  let match = version.match(LEGACY_RC_ITERATION_RE)
  if (match) {
    return {
      kind: "legacy",
      legacyShape: "rc-iteration",
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      iteration: Number(match[4]),
      rcN: Number(match[5]),
      convertibleToRelease: false,
    }
  }
  match = version.match(LEGACY_STABLE_ITERATION_RE)
  if (match) {
    return {
      kind: "legacy",
      legacyShape: "stable-iteration",
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      iteration: Number(match[4]),
      convertibleToRelease: false,
    }
  }
  if (SEMVER_RE.test(version) || SEMVER_BETA_RE.test(version) || SEMVER_RC_RE.test(version)) {
    fail("ELEGACY", `version ${version} is not a legacy shape`)
  }
  fail("EINVAL", `version ${version} is not a recognized legacy shape`)
}

export function computeMigrationFloor(inventory: unknown, product: Product): string {
  const entries = (inventory as { products?: Record<string, { tags?: { name: string }[]; manifests?: { version: string }[] }> })?.products?.[product]
  if (!entries) return "1.0.0"

  let highest: LegacyVersion | undefined
  for (const tag of entries.tags ?? []) {
    try {
      const legacy = parseLegacyVersion(tag.name.replace(/^v/, ""))
      if (!highest || compareLegacyToFloor(highest, legacy) < 0) highest = legacy
    } catch {
      // Unparsable records are preserved in inventory but do not set the floor.
    }
  }
  for (const manifest of entries.manifests ?? []) {
    try {
      const legacy = parseLegacyVersion(manifest.version)
      if (!highest || compareLegacyToFloor(highest, legacy) < 0) highest = legacy
    } catch {
      // Unparsable records are preserved in inventory but do not set the floor.
    }
  }

  if (!highest) return "1.0.0"
  return `${highest.major}.${highest.minor}.${highest.patch}`
}

function compareLegacyToFloor(a: LegacyVersion, b: LegacyVersion): number {
  const left = [a.major, a.minor, a.patch, a.iteration, "rcN" in a ? a.rcN : 0]
  const right = [b.major, b.minor, b.patch, b.iteration, "rcN" in b ? b.rcN : 0]
  for (let index = 0; index < left.length; index++) {
    const l = left[index]!
    const r = right[index]!
    if (l !== r) return l - r
  }
  return 0
}

export function assertVersionAboveMigrationFloor(product: Product, version: string, inventory: unknown) {
  const floor = computeMigrationFloor(inventory, product)
  if (compareSemVer(version, floor) < 0) {
    fail("EMIGRATION", `version ${version} is below migration floor ${floor} for ${product}`)
  }
}

export function compareSemVer(a: string, b: string): number {
  const left = parseReleaseVersion(a)
  const right = parseReleaseVersion(b)
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.channel !== right.channel) return left.channel === "stable" ? 1 : -1
  if (left.prerelease && right.prerelease) {
    if (left.prerelease.kind !== right.prerelease.kind) {
      return left.prerelease.kind === "rc" ? 1 : -1
    }
    return left.prerelease.n - right.prerelease.n
  }
  if (left.prerelease) return -1
  if (right.prerelease) return 1
  return 0
}

export const RELEASE_IDENTITY_PRODUCTS = PRODUCTS
export const RELEASE_CHANNELS_LIST = RELEASE_CHANNELS
export const DEV_CHANNELS_LIST = DEV_CHANNELS

declare global {
  const OPENCODE_RELEASE_IDENTITY: string | undefined
}
