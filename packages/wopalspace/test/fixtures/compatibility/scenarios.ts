import materializationPatterns from "./materialization-patterns.json"
import type { CompatibilityFixture } from "./git-space"

/** Replay the exact input changes used to capture baseline-results.json.
 * These helpers only construct input; the caller invokes/asserts its domain owner.
 */
export function prepareSpaceScenario(
  fixture: CompatibilityFixture,
  scenario: "noop" | "unique-and-stray" | "dirty-touch-set" | "merge-conflict",
) {
  fixture.applySparse(materializationPatterns)
  if (scenario === "unique-and-stray") {
    fixture.commit(fixture.worktree, "config/note.md", "# n\n", "feat: note")
    fixture.write(fixture.worktree, "rules/custom.md", "# c\n")
  }
  if (scenario === "dirty-touch-set") {
    fixture.commit(fixture.ontology, "rules/typescript.md", "# incoming\n")
    fixture.write(fixture.worktree, "rules/typescript.md", "# user dirty\n")
  }
  if (scenario === "merge-conflict") {
    fixture.commit(fixture.ontology, "rules/typescript.md", "# host content\n")
    fixture.commit(fixture.worktree, "rules/typescript.md", "# space content\n")
  }
  return {
    ontologyPath: fixture.ontology,
    spaceWorktreePath: fixture.worktree,
    spaceBranch: "space/demo-space",
    spacePath: fixture.space,
    spaceName: "demo-space",
  }
}
