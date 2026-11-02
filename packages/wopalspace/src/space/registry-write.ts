import { updateSettingsEntry } from "../settings-registry"
import { readSpaceRegistry, spaceRegistryPath } from "./registry"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { RegisteredSpace } from "./types"

/**
 * Space registration writes.
 *
 * The shared settings writer owns the JSONC read-modify-publish lock; this
 * module supplies only the Space slice's invariants, which are enforced
 * against the document reread while the lock is held.
 */

export interface RegisterSpaceInput {
  readonly name: string
  readonly path: string
  readonly ontology: string
  readonly branch: string
  readonly type: string
  readonly displayName?: string
  readonly createdAt: string
}

export type RegisterSpaceResult = "created" | "reused" | "renamed"

function fail(code: string, message: string, suggestion?: string): never {
  throw new SpaceServiceError({ code, message, ...(suggestion ? { suggestion } : {}) })
}

/**
 * Validate the in-lock document for one registration.
 *
 * Refusals happen before any edit is applied: a name owned by a different
 * path, a path already registered, a nested Space, or a conflicting type or
 * ontology for an existing registration.
 */
function validateRegistration(current: RegisteredSpace | undefined, input: RegisterSpaceInput): (text: string) => void {
  return (text: string) => {
    void text
    if (current === undefined) return
    if (current.path !== input.path) {
      fail(
        spaceErrorCodes.nameExists,
        "Space " + JSON.stringify(input.name) + " already exists at " + current.path,
        "Use a different name, or re-run init against the registered path.",
      )
    }
    if (current.type.length > 0 && current.type !== input.type) {
      fail(
        spaceErrorCodes.typeMismatch,
        "Space " +
          JSON.stringify(input.name) +
          " was created with type " +
          JSON.stringify(current.type) +
          " and cannot change to " +
          JSON.stringify(input.type),
        "Changing types would discard work on the existing branch; remove the Space first if you really need another type.",
      )
    }
    if (current.ontology !== undefined && current.ontology !== input.ontology) {
      fail(
        spaceErrorCodes.typeMismatch,
        "Space " +
          JSON.stringify(input.name) +
          " uses ontology " +
          JSON.stringify(current.ontology) +
          " and cannot change to " +
          JSON.stringify(input.ontology),
        "Remove the Space first if you really need another ontology.",
      )
    }
  }
}

/** Reject a Space root nested in, or containing, another registered Space. */
export function assertNoNesting(spaces: readonly RegisteredSpace[], input: { name: string; path: string }): void {
  for (const space of spaces) {
    if (space.name === input.name && space.path === input.path) continue
    const nested = input.path.startsWith(space.path + "/") || space.path.startsWith(input.path + "/")
    if (nested) {
      fail(
        spaceErrorCodes.nested,
        "Cannot create Space " +
          JSON.stringify(input.name) +
          " inside or around existing Space " +
          JSON.stringify(space.name),
        "Spaces cannot be nested. Choose a path outside existing Spaces.",
      )
    }
  }
}

/** Register or refresh one Space entry through the shared settings writer. */
export function registerSpace(wopalHome: string, input: RegisterSpaceInput): RegisterSpaceResult {
  const registry = readSpaceRegistry(wopalHome)
  const existing = Object.hasOwn(registry.spaces, input.name) ? registry.spaces[input.name] : undefined
  const pathOwner = Object.values(registry.spaces).find((space) => space.path === input.path)
  if (pathOwner !== undefined && pathOwner.name !== input.name) {
    fail(
      spaceErrorCodes.pathRegistered,
      "A Space is already registered at " + input.path + " (" + pathOwner.name + ")",
      "Use a different path, or re-run init with the registered name.",
    )
  }
  assertNoNesting(Object.values(registry.spaces), { name: input.name, path: input.path })

  const entry = {
    path: input.path,
    name: input.displayName ?? existing?.displayName ?? input.name,
    ontology: input.ontology,
    branch: input.branch,
    createdAt: existing?.createdAt ?? input.createdAt,
    type: input.type,
  }

  const changed = updateSettingsEntry(spaceRegistryPath(wopalHome), ["spaces", input.name], entry, {
    validate: validateRegistration(existing, input),
  })
  if (existing === undefined) return "created"
  if (changed) return "renamed"
  return "reused"
}
