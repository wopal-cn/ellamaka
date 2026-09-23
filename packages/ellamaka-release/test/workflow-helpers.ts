// packages/ellamaka-release/test/workflow-helpers.ts
//
// Shared helpers for the release workflow assertions. The CLI and Desktop
// publish workflows must place the npm publish step the same way (gated on a
// real release, before the immutable R2 commit point), so the extraction and
// counting live here instead of being re-derived per test file.

/** Number of non-overlapping occurrences of `needle` in `text`. */
export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/**
 * The YAML block of the step containing `marker`, from the step's own
 * `- name:` / `- uses:` line up to (excluding) `marker`.
 *
 * Fails loudly when the marker or its step header is missing, so a moved or
 * renamed step cannot silently satisfy a `toContain` assertion elsewhere.
 */
export function stepBlockBefore(workflow: string, marker: string): string {
  const markerIndex = workflow.indexOf(marker)
  if (markerIndex < 0) throw new Error(`workflow step marker not found: ${marker}`)
  const headerIndex = workflow.lastIndexOf("\n      - ", markerIndex)
  if (headerIndex < 0) throw new Error(`workflow step header not found before: ${marker}`)
  return workflow.slice(headerIndex, markerIndex)
}
