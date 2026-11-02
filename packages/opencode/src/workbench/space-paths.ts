import { realpath } from "fs/promises"
import type { RegisteredSpace } from "@wopal/wopalspace"
import { normalizeWorkbenchPath } from "./session-tree"

type SpacePathFacts = { path: string }

/** A registry collision has no deterministic owner and must not pick by order. */
export function uniqueSpaceRootFailure(
  spaces: ReadonlyArray<{ path: string }>,
): { code: "SPACE_PATH_AMBIGUOUS"; message: string } | undefined {
  const seen = new Set<string>()
  for (const space of spaces) {
    const path = normalizeWorkbenchPath(space.path)
    if (seen.has(path)) {
      return {
        code: "SPACE_PATH_AMBIGUOUS" as const,
        message: "Multiple registered Spaces resolve to the same directory",
      }
    }
    seen.add(path)
  }
  return undefined
}

/** Resolve once for a Space read; a missing root remains readable as a fact. */
async function canonicalSpace<T extends SpacePathFacts>(space: T): Promise<T & { canonicalPath: string }> {
  try {
    return { ...space, canonicalPath: normalizeWorkbenchPath(await realpath(space.path)) }
  } catch {
    return { ...space, canonicalPath: normalizeWorkbenchPath(space.path) }
  }
}

/** Resolve a request path against current registered Space identities. */
export async function spaceByPath(
  spaces: readonly RegisteredSpace[],
  requested: string,
): Promise<Array<RegisteredSpace & { canonicalPath: string }>> {
  const canonical = await Promise.all(spaces.map(canonicalSpace))
  let requestedPath: string
  try {
    requestedPath = normalizeWorkbenchPath(await realpath(requested))
  } catch {
    requestedPath = normalizeWorkbenchPath(requested)
  }
  return canonical.filter(
    (space) => space.canonicalPath === requestedPath || normalizeWorkbenchPath(space.path) === requestedPath,
  )
}
