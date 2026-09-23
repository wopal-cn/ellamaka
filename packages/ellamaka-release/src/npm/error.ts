// packages/ellamaka-release/src/npm/error.ts
//
// One rendering of an unknown thrown value, shared by every module that has to
// put a cause into a message. Kept apart from `execute.ts` so modules that only
// report errors do not have to pull in the process-spawning layer.

/** Human-readable message for an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
