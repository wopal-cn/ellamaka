import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Runtime manifest types & pure helpers for the DSH production materialisation
// (DESIGN-ellamaka-dsh.md §3.4.3).
//
// The manifest carries ONLY the DSH official DIRECT dependencies as exact
// versions (the single editing source is `packages/ellamaka-cordis/package.json`).
// It deliberately carries NO lock snapshot and NO registry derivation from a
// lock file: the materialiser resolves the exact versions at runtime with npm
// (Arborist), which produces the real runtime lock (package-lock.json) for the
// closure. The fingerprint therefore covers the exact dependency set, not a
// transitive lock tree — a version bump changes the fingerprint, a registry
// drift does not.
// ---------------------------------------------------------------------------

export interface DshRuntimeManifestV1 {
  schema: "ellamaka.dsh-runtime/v1"
  bridgeAbi: number
  dependencies: Record<string, string>
  fingerprint?: string
}

/** The subset of package.json that carries DSH official direct dependencies. */
export interface DshDependencies {
  dependencies?: Record<string, string>
}

/** The manifest schema string this runtime understands. */
export const DSH_RUNTIME_SCHEMA = "ellamaka.dsh-runtime/v1"
export const DSH_RUNTIME_ABI = 1

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Deep-canonicalize a JSON-serializable value: object keys are sorted and
 * nested arrays/objects normalized so the byte stream is stable regardless of
 * insertion order. Used both for the fingerprint hash and the emitted file.
 */
export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalSerialize(v)).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalSerialize(v)}`).join(",")}}`
}

/**
 * Normalise line endings to LF and trim trailing whitespace so a committed
 * manifest file can be compared byte-exactly against the canonical output
 * regardless of how git checked it out.
 */
export function normalizeManifestText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trimEnd()
}

/**
 * Compare a committed manifest file's text to freshly generated output,
 * tolerating CRLF/LF checkout differences. windows-latest runners enable
 * `core.autocrlf`, which rewrites a committed trailing LF into CRLF on
 * checkout while the freshly generated output stays LF; a byte-exact compare
 * therefore false-positives as drift on Windows CI.
 */
export function manifestsTextEqual(committed: string, generated: string): boolean {
  return normalizeManifestText(committed) === normalizeManifestText(generated)
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * SHA-256 digest over canonical JSON of every field except the manifest's own
 * `fingerprint` (HASH/get phase). Returns `sha256:<hex>`.
 */
export function computeManifestFingerprint(m: DshRuntimeManifestV1): string {
  const { fingerprint: _fp, ...rest } = m
  const digest = createHash("sha256").update(canonicalSerialize(rest)).digest("hex")
  return `sha256:${digest}`
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

function assertManifestShape(raw: unknown): asserts raw is DshRuntimeManifestV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("dsh runtime manifest: expected an object")
  }
  const m = raw as Partial<DshRuntimeManifestV1>
  if (m.schema !== DSH_RUNTIME_SCHEMA) {
    throw new Error(
      `dsh runtime manifest: unsupported schema "${String(m.schema)}" (expected "${DSH_RUNTIME_SCHEMA}")`,
    )
  }
  if (typeof m.bridgeAbi !== "number") {
    throw new Error("dsh runtime manifest: missing required numeric field `bridgeAbi`")
  }
  if (typeof m.dependencies !== "object" || m.dependencies === null) {
    throw new Error("dsh runtime manifest: missing required object field `dependencies`")
  }
}

/** Parse a raw manifest string and validate its schema/ABI shape. */
export function parseDshRuntimeManifest(raw: string): DshRuntimeManifestV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("dsh runtime manifest: invalid JSON")
  }
  assertManifestShape(parsed)
  return parsed
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------

/**
 * Build a complete runtime manifest from the package's DSH dependencies.
 * Deterministic for identical inputs: the emitted JSON and the fingerprint are
 * derived purely from the exact dependency versions (no lock file involved —
 * the closure lock is produced at runtime by npm during materialisation).
 */
export function buildDshRuntimeManifest(pkg: DshDependencies): DshRuntimeManifestV1 {
  const dependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (name.startsWith("@deepseek-ai/") || name === "@deepseek-ai/dsh") {
      dependencies[name] = version
    }
  }

  const manifest: DshRuntimeManifestV1 = {
    schema: DSH_RUNTIME_SCHEMA,
    bridgeAbi: DSH_RUNTIME_ABI,
    dependencies,
  }
  manifest.fingerprint = computeManifestFingerprint(manifest)
  return manifest
}
