/**
 * Minimal dependency resolver for user-plugin installation
 * (DESIGN-dsh-poc §9.4, spike 1 in `.wopal-space/.tmp/dsh-plugin-spike/`).
 *
 * A small BFS resolver over abridged registry packuments replaces Arborist
 * for third-party plugin trees (Arborist busy-loops inside a compiled binary;
 * the BFS resolver was spike-verified at ~1s for a typical plugin, spike
 * report §Spike 1). Semver matching is self-contained: exact, caret, tilde,
 * dist-tag, and prerelease exclusion — zero new dependencies are published
 * with this package (Plan Task 2 decision).
 *
 * The fetch boundary is injectable: production uses the global fetch against
 * `registry.npmjs.org` (abridged accept header); tests inject recorded
 * packuments so the suite is fully offline.
 */

/** The version metadata the resolver consumes from a packument. */
export interface PackumentVersion {
  name: string
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dist?: { tarball?: string }
}

/** An abridged packument: name, dist-tags, and the consumed version slices. */
export interface Packument {
  name: string
  "dist-tags"?: Record<string, string>
  versions?: Record<string, PackumentVersion>
}

/** A fetch-compatible signature (mirrors runtime/registry.ts FetchLike). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<unknown>

/** The default registry the resolver queries (production). */
export const DEFAULT_RESOLVER_REGISTRY = "https://registry.npmjs.org/"

/**
 * A registry spec the resolver refuses (DESIGN §9 Out of Scope: git/tarball/
 * file transports). Raised before any network activity.
 */
export class UnsupportedSpecError extends Error {
  constructor(spec: string) {
    super(`dsh plugin resolver: unsupported spec "${spec}" (git/file/tarball transports are not supported)`)
    this.name = "UnsupportedSpecError"
  }
}

/** No packument version satisfies the requested range. */
export class NoVersionError extends Error {
  constructor(
    name: string,
    range: string,
    chain: string[],
  ) {
    const via = chain.length > 0 ? ` (required by ${chain.join(" -> ")})` : ""
    super(`dsh plugin resolver: no version of ${name} satisfies "${range}"${via}`)
    this.name = "NoVersionError"
  }
}

/** The npm registry URL for a package name (scoped names path-escaped). */
export function packumentUrl(registry: string, name: string): string {
  const base = registry.endsWith("/") ? registry : `${registry}/`
  return new URL(name.replace("/", "%2f"), base).href
}

/** Fetch one abridged packument (memoised per resolver run). */
function createPackumentFetcher(fetchFn: FetchLike, registry: string) {
  const cache = new Map<string, Promise<Packument>>()
  return (name: string): Promise<Packument> => {
    let pending = cache.get(name)
    if (!pending) {
      const url = packumentUrl(registry, name)
      pending = (async () => {
        let response: unknown
        try {
          response = await fetchFn(url, {
            headers: { accept: "application/vnd.npm.install-v1+json" },
          })
        } catch (error) {
          throw new Error(`dsh plugin resolver: failed to fetch packument for ${name} from ${url}: ${(error as Error).message}`, { cause: error })
        }
        const res = response as { ok?: boolean; status?: number; json?: () => Promise<unknown> }
        if (res.ok === false || (typeof res.status === "number" && res.status >= 400)) {
          throw new Error(`dsh plugin resolver: registry ${res.status} for ${name} at ${url}`)
        }
        if (typeof res.json !== "function") {
          throw new Error(`dsh plugin resolver: registry response for ${name} at ${url} is not a JSON document`)
        }
        return (await res.json()) as Packument
      })()
      cache.set(name, pending)
    }
    return pending
  }
}

/**
 * Parse a semver string into comparable parts. Returns null for anything
 * that is not a plain `x.y.z` (with optional prerelease) version.
 */
function parseVersion(version: string): { major: number; minor: number; patch: number; prerelease: string[] } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+(?:\.[0-9A-Za-z.-]+)*))?$/.exec(version.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

/**
 * Whether `candidate` satisfies `range`. Supported grammar (Plan Task 2):
 * exact versions, caret (`^`), tilde (`~`), `x`-ranges (`5.x`, `5.3.x`),
 * `latest`/`*`, and dist-tags. npm semantics: a bare name and an explicit
 * `latest` BOTH pin dist-tags.latest (falling back to the highest stable
 * when the tag is absent); `*` means any stable version. A prerelease is
 * only selected by naming it — an exact version or a dist-tag pointing at
 * one (e.g. `pkg@nightly`). Known narrow npm difference: npm resolves a
 * bare name to the highest stable too, while this stays pinned to the tag
 * even when a higher stable exists (visible only when latest ≠ highest).
 */
export function satisfiesRange(candidateVersion: string, range: string, tags?: Record<string, string>): boolean {
  const spec = range.trim()

  if (spec === "" || spec === "latest") {
    const latest = tags?.latest
    if (latest !== undefined) return candidateVersion === latest
    const candidate = parseVersion(candidateVersion)
    return !!candidate && candidate.prerelease.length === 0
  }

  if (spec === "*") {
    const candidate = parseVersion(candidateVersion)
    return !!candidate && candidate.prerelease.length === 0
  }

  // Dist-tag reference (`next`, `canary`, ...): resolve via dist-tags.
  if (tags && spec in tags) return candidateVersion === tags[spec]

  // Exact version (prerelease included) always matches itself.
  const candidate = parseVersion(candidateVersion)
  if (!candidate) return false
  const exact = parseVersion(spec)
  if (exact) {
    return (
      candidate.major === exact.major &&
      candidate.minor === exact.minor &&
      candidate.patch === exact.patch &&
      candidate.prerelease.join(".") === exact.prerelease.join(".")
    )
  }

  // Range forms below never select prereleases.
  if (candidate.prerelease.length > 0) return false

  const caret = spec.startsWith("^")
  const tilde = spec.startsWith("~")
  const cleaned = caret || tilde ? spec.slice(1).trim() : spec
  const parts = cleaned.split(".")
  if (parts.length === 0 || parts.length > 3) return false
  const nums: (number | "x")[] = []
  for (const part of parts) {
    if (part === "x" || part === "X" || part === "*") nums.push("x")
    else {
      const n = Number(part)
      if (!Number.isInteger(n) || n < 0) return false
      nums.push(n)
    }
  }
  const [major, minor = "x", patch = "x"] = nums
  if (major === "x") return true
  if (candidate.major !== major) return false
  if (tilde) {
    const minMinor = minor === "x" ? 0 : minor
    const minPatch = patch === "x" ? 0 : patch
    if (candidate.minor !== minMinor) return false
    if (candidate.patch < minPatch) return false
    return true
  }
  // Caret: "up to the next leftmost non-zero digit" (npm semver semantics).
  if (caret) {
    const minMinor = minor === "x" ? 0 : minor
    const minPatch = patch === "x" ? 0 : patch
    if (candidate.minor < minMinor) return false
    // ^0.0.x: only that exact patch (and its siblings via x) — the leftmost
    // non-zero may be the PATCH, so the upper bound is the next patch.
    if (major === 0 && minMinor === 0 && patch !== "x") {
      return candidate.minor === 0 && candidate.patch >= minPatch
    }
    // ^0.y.z: the leftmost non-zero is the MINOR, so the upper bound is 0.(y+1).0.
    if (major === 0 && minor !== "x") {
      return candidate.minor === minMinor && candidate.patch >= minPatch
    }
    // ^major.y.z: the upper bound is (major+1).0.0.
    return (
      candidate.minor > minMinor ||
      (candidate.minor === minMinor && candidate.patch >= minPatch)
    )
  }
  // Plain x-range: `5` == `5.x.x`, `5.3` == `5.3.x`, `5.3.2` exact (handled above).
  if (minor !== "x" && candidate.minor !== minor) return false
  if (patch !== "x" && candidate.patch !== patch) return false
  return true
}

/**
 * Pick the highest version of a packument satisfying `range` (npm-style:
 * highest wins; prereleases only via exact match). Throws {@link NoVersionError}
 * naming the requirement chain when nothing satisfies.
 */
export function pickVersion(packument: Packument, range: string, chain: string[]): PackumentVersion {
  const versions = packument.versions ?? {}
  const matching = Object.values(versions).filter((v) => satisfiesRange(v.version, range, packument["dist-tags"]))
  if (matching.length === 0) {
    throw new NoVersionError(packument.name, range, chain)
  }
  matching.sort((a, b) => compareVersions(b.version, a.version))
  return matching[0]
}

/** npm-style descending semver comparator (prerelease < release). */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return a.localeCompare(b, "en", { numeric: true })
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  // release > prerelease; then lexicographic on the prerelease identifiers.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  return pa.prerelease.join(".").localeCompare(pb.prerelease.join("."), "en", { numeric: true })
}

/** One resolved node: a `name@version` and its resolved dependency ids. */
export interface ResolvedPackage {
  name: string
  version: string
  /** Resolved transitive dependency ids (`name@version`) of this package. */
  dependencies: string[]
  /** Registry tarball URL for the download step (installer). */
  tarball: string
}

/** The resolved dependency tree of one root spec. */
export interface ResolvedTree {
  root: { name: string; version: string }
  /** Every package in the tree keyed `name@version`, hoisted (one per id). */
  packages: Map<string, ResolvedPackage>
}

/** Root spec accepted by {@link resolveTree}. */
export type ResolveSpec =
  | { kind: "registry"; name: string; version?: string }
  | { kind: "dir"; path: string }

/** Options for {@link resolveTree}. */
export interface ResolveOptions {
  /** Fetch implementation; production defaults to the global fetch. */
  fetch?: FetchLike
  /** Registry base URL; defaults to {@link DEFAULT_RESOLVER_REGISTRY}. */
  registry?: string
}

/**
 * Reject the transports the supply chain explicitly does not support
 * (DESIGN §9 Out of Scope). Called on the raw version spec before any fetch.
 */
function assertSupportedSpec(spec: string): void {
  if (/^(?:github|git\+|git|file|link|workspace|tarball|https?):/i.test(spec)) {
    throw new UnsupportedSpecError(spec)
  }
}

/**
 * Resolve the transitive dependency tree of one root spec (BFS + hoist).
 *
 * `resolveTree({kind:"dir", ...})` short-circuits: local directories carry no
 * registry manifest, the installer handles them directly.
 */
export async function resolveTree(spec: ResolveSpec, options: ResolveOptions = {}): Promise<ResolvedTree> {
  if (spec.kind === "dir") {
    // Local installs resolve nothing: the directory IS the package.
    return { root: { name: "", version: "" }, packages: new Map() }
  }
  if (spec.version !== undefined) assertSupportedSpec(spec.version)

  const fetchFn = options.fetch ?? ((url, init) => fetch(url, init))
  const registry = options.registry ?? DEFAULT_RESOLVER_REGISTRY
  const fetchPackument = createPackumentFetcher(fetchFn, registry)

  const packages = new Map<string, ResolvedPackage>()
  /** BFS queue: name + range + the chain that led here (diagnostics). */
  const queue: Array<{ name: string; range: string; chain: string[] }> = []
  /** Ranges already enqueued per name (dedupe repeat work). */
  const seen = new Set<string>()

  const enqueueDeps = (pkg: PackumentVersion, chain: string[]) => {
    const sections = [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies]
    for (const section of sections) {
      for (const [depName, depRange] of Object.entries(section ?? {})) {
        // npm v7+ auto-installs peers; `*` peers stay optional (spike report).
        if (section === pkg.peerDependencies && depRange.trim() === "*") continue
        const key = `${depName}@${depRange}`
        if (seen.has(key)) continue
        seen.add(key)
        queue.push({ name: depName, range: depRange, chain: [...chain, `${pkg.name}@${pkg.version}`] })
      }
    }
  }

  // Root.
  const rootRange = spec.version ?? "latest"
  const rootDoc = await fetchPackument(spec.name)
  const rootPkg = pickVersion(rootDoc, rootRange, [])
  const rootId = `${rootPkg.name}@${rootPkg.version}`
  packages.set(rootId, {
    name: rootPkg.name,
    version: rootPkg.version,
    dependencies: [],
    tarball: rootPkg.dist?.tarball ?? "",
  })
  enqueueDeps(rootPkg, [])

  // BFS: resolve every (name, range) demand, hoist one copy per name@version.
  while (queue.length > 0) {
    const demand = queue.shift()
    if (!demand) break
    const { name, range, chain } = demand
    const doc = await fetchPackument(name)
    const pkg = pickVersion(doc, range, chain)
    const id = `${pkg.name}@${pkg.version}`
    let node = packages.get(id)
    if (!node) {
      node = { name: pkg.name, version: pkg.version, dependencies: [], tarball: pkg.dist?.tarball ?? "" }
      packages.set(id, node)
      enqueueDeps(pkg, chain)
    }
    const parentId = `${chain[chain.length - 1] ?? ""}`
    const parent = packages.get(parentId)
    if (parent && !parent.dependencies.includes(id)) parent.dependencies.push(id)
  }

  return { root: { name: rootPkg.name, version: rootPkg.version }, packages }
}
