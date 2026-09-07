import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DshRuntimeManifestV1 } from "./manifest.js"
import type { DshRuntimeLockV1 } from "./lockfile.js"
import {
  MATERIALIZE_TIMEOUT_MS,
  closureNameForFingerprint,
  isDshEnabled,
  resolveDshLayout,
  type DshRuntimeStatus,
} from "./status.js"
import { acquireMaterializeLock, releaseMaterializeLock, type LockToken } from "./lock.js"
import {
  checkClosureIntegrity,
  materializeClosure,
  validateClosureOnDisk,
  type ExtractLike,
} from "./materializer.js"
import { createDshLogger, type LogBridge } from "./log.js"
import { DEFAULT_DSH_RUNTIME_MANIFEST } from "./embed-manifest.js"

// Re-export the wiring surface entries consume from `@wopal/ellamaka-cordis/runtime`
// in one place: the default manifest, the install-anchor resolver, and the
// runtime registry selector (Task 4 / §3.4.3).
export { DEFAULT_DSH_RUNTIME_MANIFEST }
export { resolveInstallAnchor } from "./status.js"
export { pickFastestRegistry, CANDIDATE_REGISTRIES, DEFAULT_REGISTRY } from "./registry.js"
export type { RegistryCandidate, RegistryProbeResult } from "./registry.js"
export type { InstallAnchor } from "./status.js"

/**
 * Unified DSH Runtime Manager (DESIGN §3.4.5, 9-step state machine).
 *
 * Every entry (serve/web/TUI/Desktop sidecar) calls {@link initializeDshRuntime}
 * at startup. The manager:
 *   1. Gate    — `ELLAMAKA_DSH=0` → `disabled` with zero filesystem access.
 *   2. Resolve — compute the expected fingerprint and target closure directory.
 *   3. Inspect — verify an existing closure's CONTENT; complete → Load (no
 *                network). A tampered manifest/lock or a wrong dependency
 *                version is treated as damaged and re-materialised (B-03).
 *   4. Lock    — otherwise acquire the cross-process `materialize.lock`;
 *                waiters re-inspect after the holder finishes.
 *   5. Stage   — extract the embedded lock's packages into `staging/` (pacote).
 *   6. Verify  — validate the staged tree (anchor + every direct dependency).
 *   7. Activate— atomically rename staging → `closures/<fingerprint>/`.
 *   8. Profile — create missing profile templates (never overwrite user edits).
 *   9. Load    — validate the closure loader and report `ready`.
 *
 * Single-flight: concurrent calls in one process share one durable in-flight
 * promise, so only one materialisation runs. Multi-process coordination is the file lock.
 * Failures degrade (never overwrite a working closure, no retry this launch).
 *
 * Timeout (B-05): the hard materialisation timeout is applied at the CALLER
 * boundary, never inside the durable work. On timeout the caller returns
 * `degraded` WITHOUT releasing the lock while the underlying materialisation keeps
 * running — the durable work holds the lock and only releases it in its own
 * completion handler, so no second process can clear the same `staging/` and
 * materialisation concurrently. A concurrent call for the same fingerprint shares the
 * in-flight durable promise (kept until the materialisation settles), so it neither
 * touches staging nor steals the lock; after the abandoned materialisation settles, the
 * shared promise resolves — a successful activation still counts as `ready`
 * (idempotent).
 *
 * Hung materialisation / lock-holding (round-2 W-01 decision): a live-but-hung
 * materialisation holds the lock until the process dies — there is no lease or
 * GC (§3.4.7). This is an ACCEPTED self-healing limitation: when the hung
 * process dies, the atomic reclaim protocol (lock.ts B-01) reaps its lock and
 * the next launch retries; a live-but-hung process holding the lock is a
 * pathological network case where `degraded` with a structured log is the
 * designed behaviour (no child-process install is implemented).
 */

/** The fetch signature the manager may use for a network probe (tests stub it). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<unknown>

/**
 * The loader-resolution hook used to validate the closure before `ready`.
 * Production defaults to a structural check on the `@deepseek-ai/dsh` anchor
 * (B-06); tests inject a stub so the loader gate fires without a real closure.
 */
export type LoaderResolver = (installAnchor: string) => unknown

export interface ManagerDeps {
  fetch?: FetchLike
  extract?: ExtractLike
  /**
   * Loader-resolution hook. When omitted, `finishReady` runs a structural
   * loadability check on the closure's `@deepseek-ai/dsh` package.json.
   */
  resolveLoader?: LoaderResolver
}

export interface InitializeDshOptions {
  readonly wopalHome: string
  readonly logFile: string
  readonly entry: "serve" | "web" | "tui" | "init"
  readonly manifest: DshRuntimeManifestV1
  /** The embedded lock to materialise from; defaults to the build-time lock. */
  readonly lock?: DshRuntimeLockV1
  readonly deps?: ManagerDeps
  /** For tests: explicit env instead of `process.env`. */
  readonly env?: Record<string, string | undefined>
  /**
   * Hard timeout for the whole materialisation (download + install combined),
   * DESIGN §3.4.4. Defaults to 5 minutes; tests inject a short value.
   */
  readonly timeoutMs?: number
}

/** How long to wait for a concurrently-materialising process to finish. */
const LOCK_WAIT_MS = 10 * 60 * 1000

interface ManagerContext {
  readonly options: InitializeDshOptions
  readonly log: LogBridge
  readonly fingerprint: string
  readonly closureName: string
  readonly closureDir: string
  anchor: string
}

/**
 * The durable in-flight work per `home::fingerprint`. It settles only when the
 * underlying materialisation settles, so a timed-out caller never
 * removes the entry while the abandoned materialisation is still running (B-05).
 */
const inFlight = new Map<string, Promise<DshRuntimeStatus>>()

/**
 * Initialize the DSH runtime for this launch. Returns the terminal runtime
 * status: `disabled` | `ready` | `degraded`.
 */
export function initializeDshRuntime(options: InitializeDshOptions): Promise<DshRuntimeStatus> {
  const env = options.env ?? process.env
  const fingerprint = options.manifest.fingerprint ?? ""

  // 1. Gate — disabled short-circuits before ANY filesystem access and before
  // any log output: the logger is constructed lazily, so `ELLAMAKA_DSH=0`
  // creates no log file, no parent directory and writes nothing to stderr
  // (B-02). Returning `"disabled"` silently keeps the binding "disabled → no
  // file access, no dsh stage output" strict.
  if (!isDshEnabled(env)) {
    return Promise.resolve("disabled")
  }

  // The logger is only constructed after the gate passes, so the enabled paths
  // keep their structured diagnosis while the disabled path stays silent.
  const log = createDshLogger({ logFile: options.logFile })
  if (!fingerprint) {
    log.error("dsh.init.degraded", { reason: "manifest has no fingerprint" })
    return Promise.resolve("degraded")
  }

  const key = `${options.wopalHome}::${fingerprint}`
  const timeoutMs = options.timeoutMs ?? MATERIALIZE_TIMEOUT_MS
  const existing = inFlight.get(key)
  if (existing) {
    // Concurrent caller shares the durable work (single-flight). Apply this
    // caller's own timeout so a slow materialisation degrades this caller without ever
    // touching staging or stealing the lock (B-05).
    return raceTimeout(existing, timeoutMs, log)
  }

  const ctx: ManagerContext = {
    options,
    log,
    fingerprint,
    closureName: closureNameForFingerprint(fingerprint),
    closureDir: join(resolveDshLayout(options.wopalHome).closuresDir, closureNameForFingerprint(fingerprint)),
    anchor: join(
      resolveDshLayout(options.wopalHome).closuresDir,
      closureNameForFingerprint(fingerprint),
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "package.json",
    ),
  }

  // The durable work settles only when the materialisation settles; it owns the lock and
  // its release. Single-flight reuses it across concurrent calls, keeping the
  // entry until settle (B-05).
  const work = run(ctx).catch((error) => {
    // Never crash the host: any unhandled failure degrades.
    ctx.log.error("dsh.init.degraded", { error })
    return "degraded" as DshRuntimeStatus
  })
  inFlight.set(key, work)
  void work.finally(() => inFlight.delete(key))
  return raceTimeout(work, timeoutMs, log)
}

/**
 * Race the durable work with the hard materialisation timeout. On timeout the
 * caller degrades WITHOUT aborting or releasing anything — the in-flight work
 * keeps running and releases the lock in its own completion handler (B-05).
 */
function raceTimeout(
  work: Promise<DshRuntimeStatus>,
  timeoutMs: number,
  log: LogBridge,
): Promise<DshRuntimeStatus> {
  return withTimeout(
    work,
    timeoutMs,
    `dsh materialisation timed out after ${Math.round(timeoutMs / 1000)}s`,
  ).catch((error) => {
    if (error instanceof Error && error.message.startsWith("dsh materialisation timed out")) {
      log.error("dsh.stage.materialise.timeout", { error })
      return "degraded" as DshRuntimeStatus
    }
    throw error
  })
}

/** The 9-step state machine body. */
async function run(ctx: ManagerContext): Promise<DshRuntimeStatus> {
  const { log, options } = ctx

  // 2. Resolve — the closure dir is derived from the fingerprint.
  log.info("dsh.stage.resolve", { fingerprint: ctx.fingerprint, closureDir: ctx.closureDir })
  const layout = resolveDshLayout(options.wopalHome)

  // 3. Inspect — fast path: an intact closure loads with zero network.
  let anchor = validateClosureOnDisk({ home: options.wopalHome, manifest: options.manifest, deps: options.deps })
  if (anchor) {
    try {
      await checkClosureIntegrity({ home: options.wopalHome, manifest: options.manifest, deps: options.deps })
    } catch (error) {
      // Damaged closure → treat as missing and re-materialise.
      log.warn("dsh.inspect.integrity", { error })
      anchor = null
    }
  }
  if (anchor) {
    log.info("dsh.stage.inspect", { status: "hit", closureDir: ctx.closureDir })
    return finishReady(ctx)
  }

  // 4. Lock — cross-process mutex; waiters re-inspect after the holder finishes.
  log.info("dsh.stage.lock", { lockFile: layout.lockFile })
  const token = await acquireMaterializeLock(layout.lockFile, LOCK_WAIT_MS)
  if (!token) {
    log.error("dsh.stage.lock.timeout", { lockFile: layout.lockFile })
    return "degraded"
  }

  try {
    // Another process may have materialised while we waited for the lock.
    anchor = validateClosureOnDisk({ home: options.wopalHome, manifest: options.manifest, deps: options.deps })
    if (anchor) {
      await checkClosureIntegrity({ home: options.wopalHome, manifest: options.manifest, deps: options.deps })
      log.info("dsh.stage.inspect", { status: "waiter-hit", closureDir: ctx.closureDir })
      return finishReady(ctx)
    }

    // 5+6+7 — Stage, Verify, Activate. The caller's hard timeout (raceTimeout)
    // never abandons this: on timeout the caller degrades while this promise
    // keeps running and only releases the lock here, in its own completion
    // handler, so no second process can clear the same staging/ (B-05).
    log.info("dsh.stage.stage", { stagingDir: layout.stagingDir })
    const result = await materializeClosure({
      home: options.wopalHome,
      manifest: options.manifest,
      lock: options.lock,
      deps: options.deps,
      log,
    })
    log.info("dsh.stage.verify", { status: "ok", packages: Object.keys(options.manifest.dependencies).length })
    log.info("dsh.stage.activate", { closureDir: result.closureDir })
    ctx.anchor = result.anchor

    // 8+9 — Profile seeding and Load happen inside finishReady (idempotent).
    return finishReady(ctx)
  } catch (error) {
    log.error("dsh.stage.materialise.failed", { error })
    return "degraded"
  } finally {
    // The lock is released only when the durable work settles (materialisation done,
    // success or failure). A timed-out caller never reaches here — it returned
    // `degraded` without releasing, so the in-flight materialisation stays single-writer
    // on staging until it completes (B-05).
    await releaseMaterializeLock(layout.lockFile, token)
  }
}

/**
 * Default loader validation (B-06): the closure's primary export must be
 * loadable before the manager reports `ready`. Parses the `@deepseek-ai/dsh`
 * package.json and requires a resolvable entry point (`main`/`module`/
 * `exports`/`bin`) — a corrupt, missing, or entry-less anchor throws and the
 * closure degrades instead of leaking a crash at mount time. The full
 * six-module closure resolution happens at the entry mount (B-01), which is
 * itself wrapped in a degrade boundary.
 */
function defaultLoaderCheck(installAnchor: string): void {
  const raw = JSON.parse(readFileSync(installAnchor, "utf8")) as {
    main?: unknown
    module?: unknown
    exports?: unknown
    bin?: unknown
  }
  if (!raw.main && !raw.module && !raw.exports && !raw.bin) {
    throw new Error("dsh runtime: @deepseek-ai/dsh has no resolvable entry point")
  }
}

/**
 * Terminal transition to `ready`. Before reporting `ready` the manager
 * validates the loader (B-06) and idempotently seeds the profile templates on
 * the fast path (W-01) — the fresh-materialise path seeds them too, and
 * `seedProfiles` never overwrites existing files.
 */
function finishReady(ctx: ManagerContext): DshRuntimeStatus {
  const layout = resolveDshLayout(ctx.options.wopalHome)
  try {
    const loader = ctx.options.deps?.resolveLoader ?? defaultLoaderCheck
    loader(ctx.anchor)
  } catch (error) {
    ctx.log.error("dsh.init.load.failed", { anchor: ctx.anchor, error })
    return "degraded"
  }
  ctx.log.info("dsh.stage.load", { anchor: ctx.anchor })
  // Idempotent: creates missing profile templates (fast-path closure hit never
  // seeded them before, DESIGN §3.4.5 step 8 / W-01).
  seedProfiles(layout.profileDir, ctx.log)
  ctx.log.info("dsh.init.ready", { entry: ctx.options.entry })
  return "ready"
}

/**
 * Create missing profile templates (`web` and `ellamaka-tools`) and the
 * profiles/node_modules shortcuts dir. Existing profiles and user patches are
 * never touched (DESIGN §3.4.8 / §3.5).
 */
function seedProfiles(profileDir: string, log: LogBridge): void {
  const bundlesByProfile: Record<string, string[]> = {
    web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
    "ellamaka-tools": ["@deepseek-ai/dsh-base"],
  }
  for (const [name, bundles] of Object.entries(bundlesByProfile)) {
    const dir = join(profileDir, name)
    mkdirSync(dir, { recursive: true })
    const manifestPath = join(dir, "package.json")
    if (!existsSync(manifestPath)) {
      writeFileSync(
        manifestPath,
        JSON.stringify(
          { name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles } } },
          null,
          2,
        ) + "\n",
      )
    }
    const patchPath = join(dir, "cordis.patch.yml")
    if (!existsSync(patchPath)) {
      writeFileSync(
        patchPath,
        `# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; \`!!js\` expressions allowed).\n[]\n`,
      )
    }
  }
  mkdirSync(join(profileDir, "node_modules"), { recursive: true })
  log.info("dsh.stage.profile", { profiles: Object.keys(bundlesByProfile).join(",") })
}

/** Reject a promise after `ms` with the given message (hard timeout). */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
