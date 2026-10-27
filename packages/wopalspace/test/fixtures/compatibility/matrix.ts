export type CompatibilityOwner = "setup" | "ontology" | "space" | "workbench"

export interface CompatibilityCase {
  readonly id: string
  readonly owner: CompatibilityOwner
  readonly behavior: string
  readonly evidence: readonly string[]
  readonly fixture: "setup-state" | "git-space" | "existing-regression"
}

export interface IntentionalDelta {
  readonly id: string
  readonly owners: readonly CompatibilityOwner[]
  readonly behavior: string
  readonly design: string
}

/**
 * The compatibility baseline captured from the approved Plan base commit.
 * Rows name observable behavior and the existing tests that guard it. They
 * are migration constraints; the target architecture is still defined by
 * Active DESIGN.
 */
export const compatibilityBaseline = {
  baseCommit: "c2de827fe3ae6741b99756dc4f716f735f6fb397",
  cases: [
    {
      id: "setup-inspect-failure",
      owner: "setup",
      behavior: "inspect failure reports engineInstalled=false and the error without credential fields",
      evidence: ["projects/wopal-cli/tests/lib/setup-operations.test.ts"],
      fixture: "setup-state",
    },
    {
      id: "setup-engine-reuse",
      owner: "setup",
      behavior: "an installed engine is reused, and runtime impact stays explicit",
      evidence: ["projects/wopal-cli/tests/lib/setup-operations.test.ts"],
      fixture: "setup-state",
    },
    {
      id: "setup-ontology-mode",
      owner: "setup",
      behavior: "existing clone/fork topology conflicts fail before setup writes",
      evidence: ["projects/wopal-cli/tests/lib/setup-operations.test.ts"],
      fixture: "git-space",
    },
    {
      id: "setup-credential-redaction",
      owner: "setup",
      behavior: "GitHub tokens and provider keys never appear in operation results",
      evidence: ["projects/wopal-cli/tests/lib/setup-operations.test.ts"],
      fixture: "setup-state",
    },
    {
      id: "setup-recovery-state",
      owner: "setup",
      behavior: "absent, interrupted, completed, and corrupt onboarding state remain distinguishable",
      evidence: ["packages/ellamaka-onboarding/test/service.test.ts"],
      fixture: "setup-state",
    },
    {
      id: "setup-progress-cancel",
      owner: "setup",
      behavior: "progress is observable, cancellation reaches the operation, and single-flight is preserved",
      evidence: [
        "packages/ellamaka-onboarding/test/service.test.ts",
        "packages/ellamaka-onboarding/test/router.test.ts",
      ],
      fixture: "setup-state",
    },
    {
      id: "ontology-clone-topology",
      owner: "ontology",
      behavior: "clone mode reports origin/main to local/main and no upstream push chain",
      evidence: [
        "projects/wopal-cli/tests/lib/ontology-status.test.ts",
        "packages/wopalspace/test/fixtures/compatibility/baseline-results.json",
      ],
      fixture: "git-space",
    },
    {
      id: "ontology-fork-topology",
      owner: "ontology",
      behavior: "fork mode reports origin and upstream merge/push segments",
      evidence: [
        "projects/wopal-cli/tests/lib/ontology-status.test.ts",
        "packages/wopalspace/test/fixtures/compatibility/baseline-results.json",
      ],
      fixture: "git-space",
    },
    {
      id: "ontology-dirty-worktree",
      owner: "ontology",
      behavior: "dirty host repositories are never rewritten by inspection, and sync refuses before branch mutation",
      evidence: [
        "projects/wopal-cli/tests/lib/ontology/sync.test.ts",
        "projects/wopal-cli/tests/lib/git/state.test.ts",
      ],
      fixture: "git-space",
    },
    {
      id: "ontology-sync-partial-failure",
      owner: "ontology",
      behavior: "local success followed by push failure reports both stages without repeating local work",
      evidence: ["projects/wopal-cli/tests/lib/ontology/sync.test.ts"],
      fixture: "git-space",
    },
    {
      id: "ontology-sync-conflict",
      owner: "ontology",
      behavior: "sync conflict prediction agrees with apply and preserves the host repository",
      evidence: ["projects/wopal-cli/tests/lib/ontology/sync.test.ts"],
      fixture: "git-space",
    },
    {
      id: "space-sync-noop",
      owner: "space",
      behavior: "a fully synchronized space is a no-op with stable sparse patterns",
      evidence: [
        "projects/wopal-cli/tests/lib/space-sync.integration.test.ts",
        "packages/wopalspace/test/fixtures/compatibility/baseline-results.json",
      ],
      fixture: "git-space",
    },
    {
      id: "space-preview-parity",
      owner: "space",
      behavior: "preview reports contributions, stray files, and the same sparse range without writes",
      evidence: [
        "projects/wopal-cli/tests/lib/space-sync.integration.test.ts",
        "packages/wopalspace/test/fixtures/compatibility/baseline-results.json",
      ],
      fixture: "git-space",
    },
    {
      id: "space-dirty-outside-touch-set",
      owner: "space",
      behavior: "unrelated tracked and untracked changes are preserved",
      evidence: ["projects/wopal-cli/tests/lib/space-sync.integration.test.ts"],
      fixture: "git-space",
    },
    {
      id: "space-dirty-touch-set",
      owner: "space",
      behavior: "dirty changes intersecting the touch set fail before any ref or file write",
      evidence: [
        "projects/wopal-cli/tests/lib/space-sync.integration.test.ts",
        "packages/wopalspace/test/fixtures/compatibility/baseline-results.json",
      ],
      fixture: "git-space",
    },
    {
      id: "space-private-upload",
      owner: "space",
      behavior: "private selection cannot ride an ordinary sync into local main",
      evidence: [
        "projects/wopal-cli/tests/lib/space-sync.integration.test.ts",
        "packages/wopalspace/test/fixtures/compatibility/baseline-results.json",
      ],
      fixture: "git-space",
    },
    {
      id: "space-merge-conflict",
      owner: "space",
      behavior: "preview and apply report the same conflict and apply leaves no ambiguous state",
      evidence: [
        "projects/wopal-cli/tests/lib/space-sync.integration.test.ts",
        "packages/wopalspace/test/fixtures/compatibility/baseline-results.json",
      ],
      fixture: "git-space",
    },
    {
      id: "space-protected-path",
      owner: "space",
      behavior: "protected AGENTS, assembly, and ignore paths survive deletion and rename cases",
      evidence: ["projects/wopal-cli/tests/lib/space-sync.integration.test.ts"],
      fixture: "git-space",
    },
    {
      id: "space-rollback",
      owner: "space",
      behavior: "failed finishing steps restore refs, worktrees, sparse range, and snapshot",
      evidence: ["projects/wopal-cli/tests/lib/space-sync.integration.test.ts"],
      fixture: "git-space",
    },
    {
      id: "workbench-controlled-files",
      owner: "workbench",
      behavior: "Space files remain confined to the registered root and preserve normal file browsing",
      evidence: ["packages/opencode/test/server/workbench-space-files.test.ts"],
      fixture: "existing-regression",
    },
    {
      id: "workbench-space-overview",
      owner: "workbench",
      behavior: "projects, worktrees, sessions, and directory grouping retain their current facts",
      evidence: ["packages/opencode/test/server/wopal-space-overview.test.ts"],
      fixture: "existing-regression",
    },
    {
      id: "workbench-session-projection",
      owner: "workbench",
      behavior: "Session Tree and creation projections keep their observable ordering and grouping",
      evidence: [
        "packages/opencode/test/server/workbench-session-tree.test.ts",
        "packages/opencode/test/server/workbench-session-projection.test.ts",
      ],
      fixture: "existing-regression",
    },
    {
      id: "workbench-pty",
      owner: "workbench",
      behavior: "PTY lifecycle, output isolation, disconnect, and cleanup remain unchanged",
      evidence: [
        "packages/opencode/test/pty/pty-session.test.ts",
        "packages/opencode/test/pty/pty-output-isolation.test.ts",
        "packages/ellamaka-app/src/pages/workbench/pty-manager.test.ts",
      ],
      fixture: "existing-regression",
    },
    {
      id: "workbench-routing",
      owner: "workbench",
      behavior: "workspace routing and reconnect behavior keep their current request contract",
      evidence: [
        "packages/opencode/test/server/httpapi-workspace-routing.test.ts",
        "packages/opencode/test/server/workspace-routing.test.ts",
      ],
      fixture: "existing-regression",
    },
  ],
  intentionalDeltas: [
    {
      id: "ontology-contribute-removed",
      owners: ["ontology"],
      behavior: "ontology.contribute and its create/update/cleanup service surface do not exist",
      design: "DESIGN-wopalspace.md#contribute",
    },
    {
      id: "ontology-inspect-refresh-split",
      owners: ["ontology"],
      behavior: "inspect is local-only; explicit refresh performs Git fetch and contribution PR lookup",
      design: "DESIGN-wopalspace.md#ontology",
    },
    {
      id: "setup-web-only",
      owners: ["setup"],
      behavior: "Web Onboarding is the only Setup presentation; terminal setup and machine-runner steps are retired",
      design: "DESIGN-onboarding.md#frontend-ownership",
    },
    {
      id: "setup-product-install-removed",
      owners: ["setup"],
      behavior: "Setup initializes Home, Ontology, Space, credential, and preset but does not install products",
      design: "DESIGN-onboarding.md#product-boundary",
    },
    {
      id: "public-platform-app-bff-split",
      owners: ["setup", "ontology", "space", "workbench"],
      behavior: "reusable domain operations are public; App projections and use cases stay in the private App BFF",
      design: "DESIGN-ellamaka-sdk.md#official-app-bff-boundary",
    },
    {
      id: "passive-space-queries",
      owners: ["space"],
      behavior: "Space list, files, search, scan, and status queries do not bootstrap a directory Runtime",
      design: "DESIGN-wopalspace.md#space",
    },
    {
      id: "space-preview-no-git-writes",
      owners: ["space"],
      behavior: "Space sync preview does not write refs, index, sparse state, snapshot, registry, or Git objects",
      design: "DESIGN-wopalspace.md#refactor-compatibility-contract",
    },
  ],
} as const satisfies {
  baseCommit: string
  cases: readonly CompatibilityCase[]
  intentionalDeltas: readonly IntentionalDelta[]
}
