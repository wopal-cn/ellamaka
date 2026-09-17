// packages/ellamaka-release/src/channel-resolve.ts
//
// The ONLY build-time channel resolver for the closed vocabulary
// {stable, beta, main, local}. Vocabulary ownership stays with identity.ts
// (D-01): this module consumes the exported constants and defines no channel
// literals of its own.
//
// This module MUST stay side-effect-free and Node-loadable: unlike
// build-env.ts (top-level Bun.file / import.meta.dir / bun version gate), it
// is imported from pure-Node build contexts (electron.vite.config.ts,
// electron-builder.config.ts, ellamaka-app/vite.js). No Bun APIs, no fs at
// module top level, no top-level await.

import { RELEASE_CHANNELS, DEV_CHANNELS } from "./identity.ts"

export type BuildChannel = "stable" | "beta" | "main" | "local"

const VOCABULARY: readonly string[] = [...RELEASE_CHANNELS, ...DEV_CHANNELS]

/**
 * Resolve a raw channel input against the closed vocabulary.
 *
 * Strict mode (no `fallback` argument): out-of-vocabulary values — including
 * undefined — throw, so a misconfigured build fails fast (fail-closed).
 * Fallback mode (`fallback: "local"`): out-of-vocabulary and undefined inputs
 * fold to "local", preserving the dev experience for Vite contexts.
 */
export function resolveBuildChannel(raw: string | undefined, fallback?: "local"): BuildChannel {
  if (raw !== undefined && (VOCABULARY as readonly string[]).includes(raw)) {
    return raw as BuildChannel
  }
  if (fallback === "local") return "local"
  throw new Error(
    `invalid build channel ${JSON.stringify(raw)}; expected one of ${VOCABULARY.join(", ")}`,
  )
}
