import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { isPathWithin, realPathOf } from "./confinement"
import { tryGit, type GitRunner } from "./git"
import { readAssemblyState } from "./snapshot"
import { resolveRegisteredSpace } from "./resolve"
import { readSpaceRegistry, registeredSpaces } from "./registry"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { RegisteredSpace, SpaceFacts, SpaceListItem, SpaceListResult, SpaceResolveResult } from "./types"

/** Registry-versus-disk facts; diagnostics only. */
export function spaceFacts(space: RegisteredSpace, git: GitRunner): SpaceFacts {
  const present = existsSync(space.path)
  const snapshot = readAssemblyState(space.path)
  const worktreePath = join(space.path, ".wopal")
  const worktreeValid =
    present &&
    existsSync(worktreePath) &&
    tryGit(git, worktreePath, ["rev-parse", "--git-dir"]).ok &&
    tryGit(git, worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout === space.branch

  const mismatch: string[] = []
  if (!present) mismatch.push("root-missing")
  if (snapshot.status === "missing") mismatch.push("snapshot-missing")
  if (snapshot.status === "invalid") mismatch.push("snapshot-invalid")
  if (snapshot.status === "ok" && snapshot.legacyPrivate.length > 0) mismatch.push("snapshot-legacy-private")
  if (snapshot.status === "ok" && snapshot.state.type !== space.type) {
    mismatch.push("type-mismatch")
  }
  if (present && !worktreeValid) mismatch.push("worktree-not-attached")

  return { present, snapshot: snapshot.status, worktree: worktreeValid, mismatch }
}

/**
 * List registered Spaces with safe disk facts.
 *
 * The registry is the entry point. A registry-versus-disk mismatch is
 * reported as a diagnostic; nothing is created, repaired or rewritten here.
 */
export function listSpaces(wopalHome: string, git: GitRunner): SpaceListResult {
  const registry = readSpaceRegistry(wopalHome)
  const items: SpaceListItem[] = registeredSpaces(registry).map((space) => ({
    ...space,
    facts: spaceFacts(space, git),
  }))
  return { items, total: items.length }
}

/**
 * Resolve a Space by stable name or by a trusted host directory.
 *
 * A directory only reverse-looks-up an already registered Space whose real
 * path contains it. Resolution never registers, creates or activates a
 * Runtime.
 */
export function resolveSpace(
  wopalHome: string,
  input: { readonly name?: string; readonly directory?: string },
): SpaceResolveResult {
  const registry = readSpaceRegistry(wopalHome)
  return resolveRegisteredSpace(registeredSpaces(registry), input)
}

/** One registered Space by name. */
export function spaceByName(wopalHome: string, name: string): RegisteredSpace {
  const registry = readSpaceRegistry(wopalHome)
  const space = registeredSpaces(registry).find((entry) => entry.name === name)
  if (!space) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space is not registered: " + name,
      suggestion: "List the registered Spaces and pass one of their names.",
    })
  }
  return space
}

/** The ontology path a Space's snapshot names, through the registry. */
export function ontologyPathForSpace(wopalHome: string, space: RegisteredSpace): string {
  const registry = readSpaceRegistry(wopalHome)
  const name = space.ontology
  if (name !== undefined && Object.hasOwn(registry.ontologies, name)) {
    return registry.ontologies[name].path
  }
  const reading = readAssemblyState(space.path)
  const ontology = reading.status === "ok" ? reading.state.source.ontology : undefined
  return join(wopalHome, "ontologies", ontology ?? name ?? "wopal-space-ontology")
}

/** Canonical registered root, refusing an unavailable directory. */
export function canonicalSpaceRoot(space: RegisteredSpace): string {
  const real = realPathOf(space.path)
  if (real === undefined) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Registered Space root is unavailable: " + space.path,
      suggestion: "Check that the Space directory still exists, then retry.",
    })
  }
  return real
}

/** Is a caller path inside this registered root? */
export function insideSpace(space: RegisteredSpace, path: string): boolean {
  const root = realPathOf(space.path) ?? resolve(space.path)
  return isPathWithin(root, realPathOf(path) ?? resolve(path))
}
