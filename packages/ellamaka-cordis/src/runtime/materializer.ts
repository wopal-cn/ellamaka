import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DshRuntimeManifestV1 } from "./manifest.js"
import { canonicalSerialize } from "./manifest.js"
import type { DshRuntimeLockV1 } from "./lockfile.js"
import { validateEmbeddedLock } from "./lockfile.js"
import { DEFAULT_DSH_RUNTIME_LOCK } from "./embed-lock.js"
import { closureNameForFingerprint, resolveDshLayout, type DshLayout } from "./status.js"
import { pickFastestRegistry, type FetchLike } from "./registry.js"
import type { LogBridge } from "./log.js"

/**
 * Closure materialiser (DESIGN §3.4.5 stages 5-7).
 *
 * The materialiser replays the EMBEDDED lock: the complete transitive
 * dependency tree is resolved at BUILD time (source environment, Arborist) and
 * embedded into the binary; at runtime each locked package is downloaded with
 * `pacote` and extracted into `staging/`. The SEA single-file binary never
 * resolves the dependency tree itself (Arborist's tree solver hangs inside a
 * compiled binary).
 *
 * Pure-injection seams:
 * - `deps.extract` is the download/extract boundary. Production resolves
 *   `pacote.extract`; tests inject a fake that synthesises the closure files.
 * - `deps.fetch` (when provided) drives registry selection; production uses
 *   the global `fetch`. Tests inject a stub so the fastest-registry probe
 *   never hits the network.
 * - `options.lock` overrides the embedded lock (tests inject a synthetic
 *   tree); production defaults to `DEFAULT_DSH_RUNTIME_LOCK`.
 *
 * Staging lifecycle (DESIGN §3.4.7, append-only):
 * - cleared at the start (the caller holds the materialise lock);
 * - on success: the verified staging dir is atomically `rename`d into
 *   `closures/<fingerprint>/` and staging is drained;
 * - on failure: the staging scene is kept for diagnosis; the next materialise
 *   overwrites it. A failed staging never overwrites an activated closure.
 */

/** Extract one package spec into a destination dir (pacote in production). */
export type ExtractLike = (spec: string, dest: string, opts?: { registry?: string }) => Promise<unknown>

export interface MaterializeDeps {
  extract?: ExtractLike
  /** Fetch for registry selection; production defaults to global fetch. */
  fetch?: FetchLike
  /**
   * Explicit registry override for this materialisation (tests use a local
   * `file:` tarball source). When set, it wins over the dynamic fastest-registry
   * probe.
   */
  registry?: string
}

export interface MaterializeResult {
  /** Absolute path to `@deepseek-ai/dsh/package.json` in the activated closure. */
  readonly anchor: string
  /** Absolute path to the activated closure directory. */
  readonly closureDir: string
}

export interface MaterializeOptions {
  readonly home: string
  readonly manifest: DshRuntimeManifestV1
  /** The embedded lock to replay; production defaults to the build-time lock. */
  readonly lock?: DshRuntimeLockV1
  readonly deps?: MaterializeDeps
  readonly log?: LogBridge
}

/** Production extractor: `pacote.extract` from this package's own dependency. */
async function createRealExtract(): Promise<ExtractLike> {
  const { default: pacote } = await import("pacote")
  return (spec, dest, opts) =>
    pacote.extract(spec, dest, { registry: opts?.registry, ignoreScripts: true })
}

/** The global fetch (bun & node 18+). */
const globalFetch: FetchLike = (url, init) => fetch(url, init)

/**
 * One registry probe per process: the first materialisation measures all
 * candidates and reuses the winner for the rest of the process (subsequent
 * closures are usually already cached, so re-probing would be pure overhead).
 */
let cachedRegistry: string | undefined

/**
 * Resolve the registry for this materialisation. An explicit `deps.registry`
 * (tests) wins; otherwise probe the candidates with the injected fetch (or the
 * global fetch) and cache the winner per process.
 */
async function resolveRegistry(deps: MaterializeDeps | undefined): Promise<string> {
  if (deps?.registry) return deps.registry
  if (cachedRegistry) return cachedRegistry
  const fetchFn = deps?.fetch ?? globalFetch
  const winner = await pickFastestRegistry(fetchFn)
  cachedRegistry = winner.url
  return winner.url
}

/**
 * Derive the package name from a lock path (`node_modules/<name>` possibly
 * nested under a parent package).
 */
function packageNameFromLockPath(path: string): string {
  const marker = path.lastIndexOf("node_modules/")
  return path.slice(marker + "node_modules/".length)
}

/** The staging package.json: the manifest's exact DSH direct dependencies. */
function closurePackageJson(manifest: DshRuntimeManifestV1): string {
  return JSON.stringify(
    {
      name: "ellamaka-dsh-closure",
      private: true,
      type: "module",
      dependencies: manifest.dependencies,
    },
    null,
    2,
  )
}

/**
 * The on-disk npm lockfile v3 document written into the staging/closure dir:
 * the embedded lock's packages table rendered in standard npm v3 shape. The
 * closure's lock is a copy of the build-time tree, so Inspect/Verify validate
 * against the exact tree the release was built with.
 */
function lockDocument(lock: DshRuntimeLockV1): string {
  return JSON.stringify({
    name: "ellamaka-dsh-closure",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {},
      ...Object.fromEntries(Object.entries(lock.packages).map(([path, entry]) => [path, { ...entry }])),
    },
  })
}

/**
 * The runtime lock: the npm `package-lock.json` the materialiser writes from
 * the embedded lock. This helper reads the lock from a closure/staging dir and
 * validates that it is a well-formed npm lockfile v3 document (used by content
 * verification and the fast-path inspect: presence + shape).
 */
export function readRuntimeLock(closureDir: string): Record<string, unknown> | null {
  const path = join(closureDir, "package-lock.json")
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { lockfileVersion?: unknown; packages?: unknown }
    if (parsed === null || typeof parsed !== "object") return null
    if (parsed.lockfileVersion !== 3 || typeof parsed.packages !== "object" || parsed.packages === null) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function anchorFor(layout: DshLayout, closureName: string): string {
  return join(
    layout.closuresDir,
    closureName,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "package.json",
  )
}

/** Clear the staging scene. Called only while holding the materialise lock. */
async function clearStaging(layout: DshLayout, log?: LogBridge): Promise<void> {
  if (!existsSync(layout.stagingDir)) return
  log?.info("materializer.staging.clear", { stagingDir: layout.stagingDir })
  rmSync(layout.stagingDir, { recursive: true, force: true })
}

/**
 * Materialise the closure for `manifest.fingerprint` into `closures/`:
 * validate the embedded lock against the manifest, extract every locked
 * package into `staging/`, verify the staged tree, then atomically activate
 * via rename.
 *
 * Throws on any failure (extract error, staged verification failure, invalid
 * install anchor) so the caller can degrade; a failed run never overwrites an
 * already-activated closure.
 */
export async function materializeClosure(options: MaterializeOptions): Promise<MaterializeResult> {
  const layout = resolveDshLayout(options.home)
  const log = options.log
  const fingerprint = options.manifest.fingerprint
  if (!fingerprint) {
    throw new Error("dsh runtime: manifest has no fingerprint to materialise")
  }
  const closureName = closureNameForFingerprint(fingerprint)
  const closureDir = join(layout.closuresDir, closureName)
  const lock = options.lock ?? DEFAULT_DSH_RUNTIME_LOCK

  // Drift gate: the lock must bind this exact manifest (see lockfile.ts).
  validateEmbeddedLock(lock, options.manifest)

  // Append-only: never overwrite a complete, working closure of this
  // fingerprint. A damaged closure (missing anchor / direct deps) is treated
  // as missing and re-materialised (DESIGN §3.4.7).
  if (isClosureComplete(closureDir, options.manifest)) {
    log?.info("materializer.activate.skip", { closureDir, reason: "exists" })
    return { anchor: anchorFor(layout, closureName), closureDir }
  }
  if (existsSync(closureDir)) {
    log?.warn("materializer.activate.replace", { closureDir, reason: "damaged" })
    rmSync(closureDir, { recursive: true, force: true })
  }

  // Self-managed staging: clear any leftover scene from a previous run.
  await clearStaging(layout, log)

  // Select the fastest reachable registry for this user (per-process cache).
  const registry = await resolveRegistry(options.deps)
  log?.info("materializer.registry", { registry })

  // Stage the manifest + the embedded lock (on-disk npm v3 copy) BEFORE the
  // extracts, so verification (B-02/B-03) can run against the staged tree.
  mkdirSync(layout.stagingDir, { recursive: true })
  writeFileSync(join(layout.stagingDir, "package.json"), closurePackageJson(options.manifest))
  writeFileSync(join(layout.stagingDir, "package-lock.json"), lockDocument(lock))
  writeFileSync(join(layout.stagingDir, "runtime-manifest.json"), JSON.stringify(options.manifest))
  log?.info("materializer.stage", { fingerprint, packages: Object.keys(lock.packages).length, registry })

  const extract = options.deps?.extract ?? (await createRealExtract())

  // Download-extract every locked package into its node_modules path.
  // Failures reject the run; staging is kept for diagnosis (DESIGN §3.4.7).
  try {
    await extractAll(lock, layout.stagingDir, extract, registry, log)
  } catch (error) {
    throw new Error(`dsh runtime: staged closure extraction failed: ${(error as Error).message}`)
  }

  // Verify the staged tree CONTENT before activation (B-02). Existence alone is
  // not enough: a staged direct dep installed at the wrong version must fail
  // here, keep staging for diagnosis, and never activate. This runs the same
  // full verifyClosureContent() used by the fast-path inspect (canonical
  // runtime-manifest compare + runtime-lock shape + pinned dep versions).
  const stagedClosureDir = layout.stagingDir
  const missing = directDepsMissingOnDisk({
    closureDir: stagedClosureDir,
    manifest: options.manifest,
  })
  const stagedAnchor = join(stagedClosureDir, "node_modules", "@deepseek-ai", "dsh", "package.json")
  if (missing.length > 0 || !existsSync(stagedAnchor)) {
    throw new Error(
      `dsh runtime: staged closure verification failed (missing ${[stagedAnchor, ...missing].filter(Boolean).join(", ")})`,
    )
  }
  try {
    verifyClosureContent(stagedClosureDir, options.manifest)
  } catch (error) {
    // Keep staging for diagnosis; never activate a wrong-version tree (B-02).
    log?.warn("materializer.verify.staged.failed", { error })
    throw new Error(`dsh runtime: staged closure content verification failed: ${(error as Error).message}`)
  }
  log?.info("materializer.verify", { fingerprint, packages: Object.keys(options.manifest.dependencies).length })

  // Atomically activate: rename staging → closures/<fingerprint>.
  mkdirSync(dirname(closureDir), { recursive: true })
  if (existsSync(closureDir)) {
    // Another process activated the same closure while we installed; adopt it.
    await clearStaging(layout, log)
    log?.info("materializer.activate.adopt", { closureDir })
    return { anchor: anchorFor(layout, closureName), closureDir }
  }
  await rename(layout.stagingDir, closureDir)
  writeFileSync(join(closureDir, "runtime-manifest.json"), JSON.stringify(options.manifest))
  log?.info("materializer.activate", { closureDir, fingerprint })
  return { anchor: anchorFor(layout, closureName), closureDir }
}

/**
 * Extract every locked package with bounded concurrency (the SEA binary's
 * network stack is reliable for concurrent small downloads; 16 keeps peak
 * memory modest while saturating the fastest registry's throughput).
 *
 * Optional packages (npm `optionalDependencies`, e.g. platform-specific
 * native-binding packages like `@koromix/koffi-*`) follow npm semantics: a
 * download/extract failure is skipped with a warning, never failing the whole
 * closure. A registry mirror may legitimately lack a platform package that
 * the official registry serves. Required packages always fail hard — a missing
 * required package is a genuine tree defect that must surface.
 */
async function extractAll(
  lock: DshRuntimeLockV1,
  stagingDir: string,
  extract: ExtractLike,
  registry: string,
  log?: LogBridge,
): Promise<void> {
  const paths = Object.keys(lock.packages)
  const CONCURRENCY = 16
  let cursor = 0
  let done = 0
  let skippedOptional = 0
  const worker = async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++]
      const entry = lock.packages[path]!
      const spec = `${packageNameFromLockPath(path)}@${entry.version}`
      const dest = join(stagingDir, ...path.split("/"))
      try {
        await extract(spec, dest, { registry })
      } catch (error) {
        if (entry.optional === true) {
          skippedOptional++
          log?.warn("materializer.extract.optional.skip", {
            package: spec,
            error: (error as Error).message,
          })
          // Pacote may leave a partial directory behind on failure; a skipped
          // optional package must not shadow a later activation's verification.
          rmSync(dest, { recursive: true, force: true })
          done++
          continue
        }
        throw error
      }
      done++
      if (done % 64 === 0) {
        log?.info("materializer.extract.progress", { done, total: paths.length })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker))
  log?.info("materializer.extract.done", {
    packages: done,
    ...(skippedOptional > 0 ? { skippedOptional } : {}),
  })
}

/** Direct dependency package.json paths missing under a closure dir. */
function directDepsMissingOnDisk(options: {
  closureDir: string
  manifest: DshRuntimeManifestV1
}): string[] {
  const missing: string[] = []
  for (const name of Object.keys(options.manifest.dependencies)) {
    const pkgPath = join(options.closureDir, "node_modules", ...name.split("/"), "package.json")
    if (!existsSync(pkgPath)) missing.push(name)
  }
  return missing
}

/**
 * Verify the closure's CONTENT against the embedded manifest (B-03). A closure
 * whose files merely exist is not trustworthy: a tampered
 * `runtime-manifest.json`, a truncated/corrupt `package-lock.json`, or a
 * direct dependency installed at the wrong version must be treated as damaged
 * and re-materialised.
 *
 * Checks:
 * 1. `runtime-manifest.json` is canonical-identical to the embedded manifest
 *    (fingerprint-exact — object-key order is normalised, so the materialiser's
 *    plain `JSON.stringify` write and the generator's canonical write compare
 *    equal for the same content).
 * 2. `package-lock.json` is a well-formed npm lockfile v3 document (parses as
 *    JSON with `lockfileVersion === 3` and a `packages` object). A truncated
 *    or corrupt lock fails to parse and marks the closure damaged; the lock is
 *    the on-disk copy of the build-time embedded lock.
 * 3. every direct dependency's installed `node_modules/<pkg>/package.json`
 *    `version` equals the manifest's exact version. The DSH manifest pins
 *    exact versions, so an exact string compare is the intended fingerprint
 *    semantics; a range spec would never be emitted by the generator.
 *
 * Throws on the first mismatch.
 */
function verifyClosureContent(closureDir: string, manifest: DshRuntimeManifestV1): void {
  const stored = JSON.parse(readFileSync(join(closureDir, "runtime-manifest.json"), "utf8")) as unknown
  if (canonicalSerialize(stored) !== canonicalSerialize(manifest)) {
    throw new Error("dsh runtime: closure runtime-manifest.json does not match the embedded manifest")
  }
  // On-disk lock (B-03): the closure must carry a well-formed npm lockfile v3
  // document — the copy of the build-time embedded lock the materialiser
  // wrote at extraction time. Presence + shape is the binding, so a missing,
  // truncated, or malformed lock marks the closure damaged.
  if (readRuntimeLock(closureDir) === null) {
    throw new Error("dsh runtime: closure package-lock.json is missing or malformed")
  }
  for (const name of Object.keys(manifest.dependencies)) {
    const pinned = manifest.dependencies[name]
    const pkgPath = join(closureDir, "node_modules", ...name.split("/"), "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown }
    if (pkg.version !== pinned) {
      throw new Error(`dsh runtime: closure dependency "${name}" is ${String(pkg.version)}, expected ${pinned}`)
    }
  }
}

/**
 * Whether a closure directory is complete for the given manifest: manifest +
 * lock + runtime-manifest present, the `@deepseek-ai/dsh` anchor present, every
 * direct dependency installed, AND the closure content matches the embedded
 * manifest (fingerprint-exact manifest + pinned dependency versions). Used by
 * the fast-path validate and by the append-only activate guard (a damaged or
 * tampered closure must be re-materialised, DESIGN §3.4.7).
 */
function isClosureComplete(closureDir: string, manifest: DshRuntimeManifestV1): boolean {
  if (!existsSync(join(closureDir, "package.json"))) return false
  if (!existsSync(join(closureDir, "package-lock.json"))) return false
  if (!existsSync(join(closureDir, "runtime-manifest.json"))) return false
  if (!existsSync(join(closureDir, "node_modules", "@deepseek-ai", "dsh", "package.json"))) return false
  if (directDepsMissingOnDisk({ closureDir, manifest }).length > 0) return false
  try {
    verifyClosureContent(closureDir, manifest)
    return true
  } catch {
    return false
  }
}

/**
 * Verify an already-activated closure on disk (stage Inspect / fast path).
 * Returns the install anchor when the closure is complete, `null` when the
 * closure is missing or damaged (e.g. the `@deepseek-ai/dsh` anchor is gone,
 * a direct dependency is missing, or the embedded manifest is absent).
 */
export function validateClosureOnDisk(options: {
  home: string
  manifest: DshRuntimeManifestV1
  deps?: MaterializeDeps
}): string | null {
  const layout = resolveDshLayout(options.home)
  const fingerprint = options.manifest.fingerprint
  if (!fingerprint) return null
  const closureName = closureNameForFingerprint(fingerprint)
  const closureDir = join(layout.closuresDir, closureName)
  if (!isClosureComplete(closureDir, options.manifest)) return null
  return anchorFor(layout, closureName)
}

/**
 * Integrity verification (DESIGN §3.4.5 stage 6 / Out of Scope note).
 *
 * Every package's content is exactly what the embedded lock pins: the
 * extraction step downloads the precise version per lock entry, and the
 * runtime's own check here is structural AND content-exact — every direct
 * dependency's package.json must be present under the closure, the stored
 * `runtime-manifest.json` must be canonical-identical to the embedded
 * manifest, and every pinned dependency version must match (B-03). A damaged
 * closure is signalled by throwing.
 */
export async function checkClosureIntegrity(options: {
  home: string
  manifest: DshRuntimeManifestV1
  deps?: MaterializeDeps
}): Promise<void> {
  const layout = resolveDshLayout(options.home)
  const closureName = closureNameForFingerprint(options.manifest.fingerprint ?? "")
  const closureDir = join(layout.closuresDir, closureName)
  const missing = directDepsMissingOnDisk({ closureDir, manifest: options.manifest })
  if (missing.length > 0) {
    throw new Error(
      `dsh runtime: closure integrity verification failed, missing packages: ${missing.join(", ")}`,
    )
  }
  verifyClosureContent(closureDir, options.manifest)
}