// packages/ellamaka-release/src/npm/exports.ts
//
// Publish-time rewrite of the contract packages' `exports` map.
//
// `packages/plugin` and `packages/sdk/js` keep their `exports` pointing at raw
// TypeScript (`./src/*.ts`) so that `typecheck`/`test` run without a prior
// build, while `files: ["dist"]` ships only the compiled output. The publish
// step therefore rewrites every subpath to its dist counterpart before packing
// — a package published with the dev map would resolve to files that are not
// in the tarball.
//
// The mapping is pinned by the fork contract test
// `packages/opencode/test/plugin-sdk-branding.test.ts` (`toDistTarget`); the
// parity guard in `test/npm-publish-exports.test.ts` fails when the two drift.

import { isJsonObject } from "./json"

export interface DistExportTarget {
  import: string
  types: string
}

const DEV_SOURCE_PREFIX = "./src/"
const DIST_PREFIX = "./dist/"
const TS_EXT = ".ts"
const JS_EXT = ".js"

/**
 * Map a development export target (`./src/*.ts`) to its shipped
 * `./dist/*.js` file. Fail-closed: a target that is not a `./src/*.ts` path is
 * rejected rather than rewritten into a file that `files: ["dist"]` never
 * ships.
 */
export function toDistTarget(source: string): string {
  if (!source.startsWith(DEV_SOURCE_PREFIX)) {
    throw new Error(`cannot publish export target "${source}": expected a "${DEV_SOURCE_PREFIX}*.ts" source path`)
  }
  if (!source.endsWith(TS_EXT)) {
    throw new Error(`cannot publish export target "${source}": expected a "${TS_EXT}" source file`)
  }
  return `${DIST_PREFIX}${source.slice(DEV_SOURCE_PREFIX.length, -TS_EXT.length)}${JS_EXT}`
}

/** The `{ import, types }` pair shipped for a development export target. */
export function distExportTarget(source: string): DistExportTarget {
  const file = toDistTarget(source)
  return { import: file, types: `${file.slice(0, -JS_EXT.length)}.d.ts` }
}

/**
 * Rewrite a dev `exports` map into the shipped `{ import, types }` form.
 *
 * Fail-closed on a malformed map. A missing or empty `exports` would publish a
 * package whose public contract is gone — including the SDK's `/v2` subpaths —
 * while the tarball still ships, so it aborts the release instead. A non-string
 * target (conditional exports) is rejected for the same reason: rewriting it
 * would ship a subpath still pointing at `./src`, which is absent from the
 * tarball.
 */
export function rewriteExports(exports: unknown): Record<string, DistExportTarget> {
  if (!isJsonObject(exports)) {
    throw new Error(`cannot publish exports: expected an object map, got ${JSON.stringify(exports)}`)
  }
  if (Object.keys(exports).length === 0) {
    throw new Error("cannot publish exports: the export map is empty")
  }
  const rewritten: Record<string, DistExportTarget> = {}
  for (const [subpath, target] of Object.entries(exports)) {
    if (typeof target !== "string") {
      throw new Error(
        `cannot publish export "${subpath}": expected a "${DEV_SOURCE_PREFIX}*.ts" string target, ` +
          `got ${JSON.stringify(target)}`,
      )
    }
    rewritten[subpath] = distExportTarget(target)
  }
  return rewritten
}
