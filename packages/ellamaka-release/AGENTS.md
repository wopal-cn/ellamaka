---
name: ellamaka-release package
description: Centralized build/release tooling for the ellamaka fork (identity, build, manifests, Gitee, cleanup, upstream lock, legacy inventory)
---

# Agent Development Rules

## Canonical References

- Parent Rules: `../../AGENTS.md`
- Distribution / release contract: `../../docs/DESIGN-distribution.md`
- Branding: `../../docs/BRANDING.md`

## Purpose

`@wopal/ellamaka-release` concentrates ALL build and release logic that
previously lived in `packages/ellamaka/` and `scripts/*.mjs`. Workflows and
operator scripts invoke the thin CLI entries under `src/cli/` via
`bun packages/ellamaka-release/src/cli/*.ts`; libraries live in `src/` and
are importable as `@wopal/ellamaka-release/<module>` (workspace resolution,
exports `{"./*": "./src/*.ts"}`).

## Module Layout

| Module | Path | Responsibility |
|--------|------|----------------|
| identity | `src/identity.ts` | Single source of truth for the release identity model (parse/build/release identity, channels, namespaced tags, legacy versions, upstream lock validation, migration floor, SemVer compare). The ONLY copy — build-time, runtime, and scripts all share it. |
| build targets | `src/build-targets.ts` | Build target matrix (per-OS/arch). |
| build identity | `src/build-identity.ts` | Build-time identity injection helper. |
| context | `src/context.ts` | Build release context (serialize/parse). |
| manifest | `src/manifest.ts` | Release manifest generation (`manifest.json`, checksums, release notes). |
| gitee | `src/gitee.ts` | Gitee release creation. |
| cleanup core | `src/cleanup/core.ts` | Product-agnostic cleanup kernel: reference graph, retention planning, withdrawal planning (protection model, [Cleanup Contract](../../docs/DESIGN-distribution.md#cleanup-contract)). |
| cleanup products | `src/cleanup/products.ts` | Product difference = config (`ellamaka-cli` / `ellamaka-desktop` channels, R2 roots, alias names, restore strategy). |
| upstream lock | `src/upstream-lock.ts` | The ONLY writer of `release/upstreams.lock.json` (operator-run). |
| inventory | `src/inventory.ts` | Read-only legacy inventory capture ([Legacy Migration](../../docs/DESIGN-distribution.md#legacy-migration)). |

## CLI Entries (`src/cli/`)

Thin entry points: parse argv → call library → exit code. Invoked as
`bun packages/ellamaka-release/src/cli/<name>.ts ...`. Do not import these
into other modules (they carry top-level CLI side effects).

| Entry | Purpose |
|-------|---------|
| `build.ts` | Branded CLI build. |
| `context.ts` | Generate `release-context.json`. |
| `manifest.ts` | Generate release manifest from archives. |
| `gitee.ts` | Create Gitee release. |
| `cleanup.ts` | Release cleanup (retention / withdraw), `--product ellamaka-cli\|ellamaka-desktop`. |
| `upstream-lock.ts` | Update upstream lock (`engine --version X.Y.Z [--dry-run]`). |
| `inventory.ts` | Legacy inventory capture (`--dry-run` / `--output`). |

## Development Commands

| Scenario | Command |
|----------|---------|
| Tests | `bun test` (from `packages/ellamaka-release`) |
| Single test | `bun test test/<module>.test.ts` (from `packages/ellamaka-release`) |

## Testing & TDD Rules

- Follow TDD: write a failing test first, then implement to make it pass.
- Tests map 1:1 to modules under `test/` (e.g. `test/cleanup-core.test.ts`
  covers `src/cleanup/core.ts`).
- The cleanup kernel (`src/cleanup/core.ts`) MUST stay product-agnostic and
  is covered by `test/cleanup-core.test.ts`; product differences are tested
  in `test/cleanup-products.test.ts`.
- Migration-only modules (identity, manifest, gitee, inventory, etc.) keep
  their original contract tests as regression guards.
- After any TypeScript change, run typecheck at repo root
  (`bun run typecheck`) to keep the package type-clean.