import type { DshRuntimeManifestV1 } from "./manifest.js"

/**
 * The embedded DSH runtime lock (DESIGN-dsh-poc §3.4.3).
 *
 * The lock is the complete transitive dependency tree resolved from the
 * manifest's exact direct dependency versions at BUILD time (source
 * environment, where Arborist is reliable) and embedded into the binary via a
 * static JSON import. At runtime the materialiser reads the embedded lock and
 * downloads each package with `pacote` — the SEA single-file binary never
 * resolves the dependency tree itself.
 *
 * The lock schema is `ellamaka.dsh-runtime-lock/v1`. Each `packages` entry maps
 * a `node_modules/...` path (relative to the closure root, including nested
 * entries carrying a different version of the same package) to its exact
 * version. The lock binds to `manifestFingerprint` so a manifest drift is
 * detectable at runtime instead of silently installing a mismatched tree.
 */

export interface DshRuntimeLockEntryV1 {
  version: string
  /**
   * Whether this package is an optional dependency of its parent (npm
   * `optionalDependencies` semantics, e.g. platform-specific native binding
   * packages). Optional packages that fail to download are skipped at
   * materialisation time (a warning is logged) instead of failing the whole
   * closure; required packages always fail hard. Absent/`undefined` means
   * required.
   */
  optional?: boolean
}

export interface DshRuntimeLockV1 {
  schema: "ellamaka.dsh-runtime-lock/v1"
  /** The manifest fingerprint this lock was resolved from (drift binding). */
  manifestFingerprint: string
  /** `node_modules/...` path → exact version. */
  packages: Record<string, DshRuntimeLockEntryV1>
}

export const DSH_RUNTIME_LOCK_SCHEMA = "ellamaka.dsh-runtime-lock/v1"

/** Parse a raw embedded-lock JSON string and validate its shape. */
export function parseDshRuntimeLock(raw: string): DshRuntimeLockV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("dsh runtime lock: invalid JSON")
  }
  return assertLockShape(parsed)
}

function assertLockShape(raw: unknown): DshRuntimeLockV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("dsh runtime lock: expected an object")
  }
  const lock = raw as Partial<DshRuntimeLockV1>
  if (lock.schema !== DSH_RUNTIME_LOCK_SCHEMA) {
    throw new Error(`dsh runtime lock: unsupported schema "${String(lock.schema)}"`)
  }
  if (typeof lock.manifestFingerprint !== "string" || typeof lock.packages !== "object" || lock.packages === null) {
    throw new Error("dsh runtime lock: missing required fields `manifestFingerprint` / `packages`")
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/") || typeof entry.version !== "string") {
      throw new Error(`dsh runtime lock: malformed packages entry "${path}"`)
    }
    if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
      throw new Error(`dsh runtime lock: malformed packages entry "${path}" — \`optional\` must be a boolean`)
    }
  }
  return lock as DshRuntimeLockV1
}

/**
 * Validate the embedded lock against the embedded manifest (drift gate).
 *
 * The lock is only loadable together with the manifest it was resolved from:
 * the bound fingerprint must equal the manifest's, and every direct dependency
 * must be present at exactly the manifest's pinned version. Any mismatch means
 * the build produced a (manifest, lock) pair from different generations and
 * must fail fast instead of installing a tree the Bridge never verified.
 */
export function validateEmbeddedLock(lock: DshRuntimeLockV1, manifest: DshRuntimeManifestV1): void {
  if (lock.manifestFingerprint !== manifest.fingerprint) {
    throw new Error(
      `dsh runtime lock: fingerprint drift — lock binds "${lock.manifestFingerprint}" but manifest is "${manifest.fingerprint}"; regenerate the lock`,
    )
  }
  for (const [name, pinned] of Object.entries(manifest.dependencies)) {
    const entry = lock.packages[`node_modules/${name}`]
    if (!entry) {
      throw new Error(`dsh runtime lock: direct dependency "${name}" missing from the embedded lock`)
    }
    if (entry.version !== pinned) {
      throw new Error(
        `dsh runtime lock: direct dependency "${name}" is ${entry.version} in the lock, expected ${pinned}; regenerate the lock`,
      )
    }
  }
}