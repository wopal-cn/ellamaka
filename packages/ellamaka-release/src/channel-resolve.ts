// packages/ellamaka-release/src/channel-resolve.ts
//
// The ONLY build-time channel resolver for the closed vocabulary
// {stable, beta, main, local}. Vocabulary ownership stays with identity.ts
// (D-01): this module consumes the exported constants and defines no channel
// literals of its own.
//
// This module MUST stay side-effect-free and Node-loadable: unlike
// build-env.ts (which runs runtime-specific APIs at module top level), it is
// imported from pure-Node build contexts (electron.vite.config.ts,
// electron-builder.config.ts, ellamaka-app/vite.js). No runtime-specific
// APIs, no fs at module top level, no top-level await.

import { RELEASE_CHANNELS, DEV_CHANNELS } from "./identity.ts"

export type BuildChannel = (typeof RELEASE_CHANNELS)[number] | (typeof DEV_CHANNELS)[number]

const VOCABULARY: readonly string[] = [...RELEASE_CHANNELS, ...DEV_CHANNELS]

function isBuildChannel(raw: string | undefined): raw is BuildChannel {
  return raw !== undefined && VOCABULARY.includes(raw)
}

/**
 * Resolve a raw channel input against the closed vocabulary.
 *
 * Strict mode (no `fallback` argument): out-of-vocabulary values — including
 * undefined — throw, so a misconfigured build fails fast (fail-closed).
 * Fallback mode (`fallback: "local"`): out-of-vocabulary and undefined inputs
 * fold to "local", preserving the dev experience for Vite contexts.
 */
export function resolveBuildChannel(raw: string | undefined, fallback?: "local"): BuildChannel {
  if (isBuildChannel(raw)) return raw
  if (fallback === "local") return "local"
  throw new Error(
    `invalid build channel ${JSON.stringify(raw)}; expected one of ${VOCABULARY.join(", ")}`,
  )
}
