import { isPathWithin, realPathOf } from "./confinement"
import { SpaceServiceError, spaceErrorCodes, type RegisteredSpace, type SpaceResolveResult } from "./types"

/**
 * Space resolution.
 *
 * The stable registry name wins. A trusted directory only reverse-looks-up an
 * already registered Space whose real path contains it — the most specific
 * (longest) root wins, mirroring the older owner's nested-Space rule. Nothing
 * is registered, created, or repaired here: a miss returns a diagnostic.
 */
export function resolveRegisteredSpace(
  spaces: readonly RegisteredSpace[],
  input: { readonly name?: string; readonly directory?: string },
): SpaceResolveResult {
  if (input.name !== undefined && input.name.length > 0) {
    const byName = spaces.find((space) => space.name === input.name)
    if (!byName) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.spaceNotFound,
        message: "Space is not registered: " + input.name,
        suggestion: "List the registered Spaces and pass one of their names.",
      })
    }
    return { name: byName.name, path: byName.path, space: byName, source: "name" }
  }

  if (input.directory === undefined || input.directory.length === 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "A Space name or a trusted directory is required to resolve a Space",
      suggestion: "Pass the stable Space name, or call from inside a registered Space root.",
    })
  }

  const candidates = spaces.flatMap((space) => {
    const roots = new Set<string>([space.path])
    const real = realPathOf(space.path)
    if (real !== undefined) roots.add(real)
    return [...roots].map((root) => ({ space, root }))
  })
  const directory = input.directory
  const realDirectory = realPathOf(directory) ?? directory
  const matches = candidates.filter(({ root }) => isPathWithin(root, directory) || isPathWithin(root, realDirectory))
  if (matches.length === 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "No registered Space contains this directory: " + directory,
      suggestion: "Open a path inside a registered Space, or pass the Space name explicitly.",
    })
  }
  const longest = matches.reduce((best, current) => (current.root.length > best.root.length ? current : best))
  return { name: longest.space.name, path: longest.space.path, space: longest.space, source: "directory" }
}
