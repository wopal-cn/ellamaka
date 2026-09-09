/**
 * The single source of the default DSH runtime lock for every host entry
 * (serve/web/TUI/Desktop sidecar). The lock is a build-time generated file
 * (`packages/ellamaka-cordis/generated/dsh-runtime-lock.json`, produced by
 * `script/generate-dsh-runtime-lock.ts`, DESIGN-dsh-poc §3.4.3).
 *
 * The static JSON import (import attributes) lets bundlers inline the lock
 * into the CLI binary and the Desktop sidecar bundle, so the released artifact
 * carries its own dependency tree without a separate runtime file read.
 * `tsgo` accepts it via `resolveJsonModule` (see `packages/ellamaka-cordis/tsconfig.json`).
 *
 * The lock is validated against the embedded manifest before first use
 * (`validateEmbeddedLock` — fingerprint binding, drift gate): a build whose
 * manifest and lock come from different generations fails fast instead of
 * installing an unverified tree.
 */
import rawLock from "../../generated/dsh-runtime-lock.json" with { type: "json" }
import type { DshRuntimeLockV1 } from "./lockfile.js"
import { parseDshRuntimeLock } from "./lockfile.js"

/**
 * The default runtime lock baked into this build. Parsed (rather than cast) so
 * a malformed or schema-drifted generated file fails fast at load with a clear
 * message instead of silently misbehaving at materialisation time.
 */
export const DEFAULT_DSH_RUNTIME_LOCK: DshRuntimeLockV1 = parseDshRuntimeLock(
  JSON.stringify(rawLock),
)