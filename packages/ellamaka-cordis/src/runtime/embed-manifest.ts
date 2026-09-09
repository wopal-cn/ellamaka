/**
 * The single source of the default DSH runtime manifest for every host entry
 * (serve/web/TUI/Desktop sidecar). The manifest is a build-time generated file
 * (`packages/ellamaka-cordis/generated/dsh-runtime-manifest.json`, produced by
 * `script/generate-dsh-runtime-manifest.ts`, DESIGN-dsh-poc §3.4.3).
 *
 * The static JSON import (import attributes) lets bundlers inline the manifest
 * into the CLI binary and the Desktop sidecar bundle, so the released artifact
 * carries its own manifest without a separate runtime file read. `tsgo` accepts
 * it via `resolveJsonModule` (see `packages/ellamaka-cordis/tsconfig.json`).
 *
 * Entries read the manifest from here unless a caller passes one explicitly
 * (e.g. tests inject a synthetic manifest through the manager options).
 */
import rawManifest from "../../generated/dsh-runtime-manifest.json" with { type: "json" }
import type { DshRuntimeManifestV1 } from "./manifest.js"
import { parseDshRuntimeManifest } from "./manifest.js"

/**
 * The default runtime manifest baked into this build. Parsed (rather than cast)
 * so a malformed or schema-drifted generated file fails fast at load with a
 * clear message instead of silently misbehaving at mount time.
 */
export const DEFAULT_DSH_RUNTIME_MANIFEST: DshRuntimeManifestV1 =
  parseDshRuntimeManifest(JSON.stringify(rawManifest))
