---
name: WopalSpace module agent rules
description: Long-lived architecture, implementation, testing, debugging, and verification rules for the WopalSpace application module
maintenance: Maintain this file only when long-lived implementation, testing, debugging, or verification constraints change and cannot be carried by code, tests, or DESIGN alone; record only rules that affect future Agent decisions, never one-off tasks, implementation facts, incident history, or information directly evident from the code.
---

# Agent Development Rules

## Canonical References

- Parent project rules: [../../AGENTS.md](../../AGENTS.md).
- WopalSpace business boundaries and behavior contracts: [../../docs/DESIGN-wopalspace.md](../../docs/DESIGN-wopalspace.md).
- Public Platform API, HttpApi, OpenAPI, and generated SDK boundaries: [../../docs/DESIGN-ellamaka-sdk.md](../../docs/DESIGN-ellamaka-sdk.md).
- This file contains only long-lived operating constraints that affect implementation quality in this module; detailed flows, data models, and API definitions belong to DESIGN.

## Architecture and Directories

`@wopal/wopalspace` is Ellamaka's private WopalSpace application service. It implements WopalSpace business rules, is composed by the Server, and is exposed through the unified Public Platform contract. Lower-level Runtime, Session, Agent, PTY, and Tool modules must not depend upward on this module.

### Source organization

- Split `src/` by business domain first. The stable owners are Setup, Ontology, Space, and Product Settings. When a domain grows beyond one cohesive file into multiple responsibilities, converge it under the corresponding `src/<domain>/`; do not create empty directory layers merely for symmetry.
- Do not duplicate business logic by caller such as Web, CLI, or Desktop, and do not organize the package root into cross-cutting technical buckets such as `services/`, `models/`, or `adapters/`. A source path should make the business owner obvious.
- Each domain owns its domain types, rules, services, and domain-specific adapters/helpers. Domains depend on one another only through explicit exported contracts/services; deep imports into another domain's internals are forbidden.
- Keep `src/index.ts` as the package export boundary only. It must not own business workflows, I/O, bootstrap, resource lifecycles, or complex state decisions.
- Promote code to shared only after two or more domains genuinely reuse a stable concept, and name the shared module by its concrete responsibility. Do not create generic `utils`, `common`, or `helpers` dumping grounds with no clear owner.
- Keep low-level Git, filesystem, process, and credential capabilities behind narrow interfaces and concrete business operations. Share such infrastructure only when it is truly cross-domain; low-level adapters must not become the organizing center of the business model.
- Split code when responsibilities have independent reasons to change and can be tested independently. Do not add factories, interfaces, or layers solely for symmetry when there is one implementation and no replacement need, and do not let one service accumulate multiple independent business responsibilities.

### Test organization

- Organize `test/` by test layer first and business domain second: keep unit and integration layers separate, then align tests with the owning `src/` domain rather than with callers or individual implementation files.
- As the suite grows, converge unit/integration tests under their domain directories. Truly cross-domain package-boundary tests such as contract or import-purity checks may live in a dedicated boundary/contract location instead of being forced into one domain.
- Keep domain-specific fixtures/helpers close to that domain. Promote temporary Home, Git repo, remote/worktree, or similar builders to shared `test/fixtures` only when multiple domains genuinely reuse them. Shared fixtures construct and clean environments; they must not hide business decisions or assertions.
- Test names and paths should communicate both layer and business behavior so an agent can identify ownership and execution layer without opening the file. Internal source refactors should not require large test moves when behavior ownership is unchanged.
- Test layout must support automatic discovery rather than per-file registration. New domain tests must naturally enter both the package-local and root-runner layer that owns them.

## Development Commands (build format test)

Use the repository's existing tooling; do not create a separate test framework for this package.

| Scenario                  | Command                                                                                       | Run from               |
| ------------------------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| Unit tests                | `bun run test:unit`                                                                           | `packages/wopalspace/` |
| Integration tests         | `bun run test:integration`                                                                    | `packages/wopalspace/` |
| All package tests         | `bun test`                                                                                    | `packages/wopalspace/` |
| Typecheck                 | `bun run typecheck`                                                                           | `packages/wopalspace/` |
| Test isolation gate       | `bun run check:test-isolation`                                                                | repository root        |
| Root targeted unit        | `bun run packages/opencode/script/run-tests-root.ts --layer unit --package wopalspace`        | repository root        |
| Root targeted integration | `bun run packages/opencode/script/run-tests-root.ts --layer integration --package wopalspace` | repository root        |

## Implementation Rules

- This module implements WopalSpace application business only. Do not absorb responsibilities owned by Runtime, CLI presentation, Product lifecycle, Evolution, Skill lifecycle, or Scheduling.
- Domain/service code must not depend on HTTP, CLI, or UI types. Transport, authentication, HttpApi error mapping, and presentation stay in the outer adapter/host boundary.
- Reusable public capabilities are exposed only through the canonical contract → Server HttpApi → Public Platform SDK path. Do not create a second HTTP/RPC/DTO contract.
- Do not expose arbitrary filesystem, Git, Shell, or process execution. Every low-level capability must be constrained by a concrete business operation and limited to the scope it owns.
- Resolve every path from trusted host context, then normalize, realpath-check, and enforce the operation's business boundary. Caller input must not replace the host root or broaden access.
- Query/inspect operations remain read-only: they must not create Runtime instances, start background work, or cause hidden persistent side effects.
- Write operations with preview/apply semantics must share the same decision logic. Preview performs zero writes; apply rereads and validates critical facts before the first persistent mutation.
- Multi-step writes define explicit commit, cancellation, and recovery boundaries. Failures return explainable state and must not leave an ambiguous half-completed result.
- Existing user files, unrelated dirty changes, and persisted state are protected by default. An operation may modify only the touch-set it explicitly owns.
- Secrets enter only the execution boundary that needs them and must never be written to plans, persistent state, events, error details, or logs.
- Package import must remain pure: importing this module must not create directories, modify `$WOPAL_HOME`, spawn processes, access the network, or register background work.
- Concurrent work must have an explicit owner. Single-flight, cancellation, cleanup, and retry for the same resource use testable service/state boundaries, not uncontrolled implicit process-global state.

## Testing

- Behavior changes in this package follow the parent Testing Best Practices and use TDD whenever its canonical applicability rule selects a RED cycle. Define the failing behavior at the owning domain/service/contract boundary before choosing the package-specific unit or integration layer below.
- Unit tests cover pure domain rules and service behavior whose dependencies are fully controlled through injection. Real Git, network access, subprocesses, filesystem watchers, and real clocks do not belong in the unit layer.
- Integration tests cover real filesystem behavior, Git repositories/remotes/worktrees/sparse checkout, persistence, controlled processes, and external adapter boundaries. Use temporary environments and temporary repositories only.
- Tests must never read or modify the real user's `$WOPAL_HOME`, real Spaces, real working repositories, or writable real remotes. When a Home is needed, create and pass an isolated directory explicitly.
- Maintain automated regression coverage for long-lived invariants such as preview/apply, partial success, cancel/retry, dirty-state protection, path confinement, and secret redaction.
- Preview tests must prove both the returned decision and zero writes. Apply tests must verify that actual side effects match the preview decision and cover preserved/recoverable state after failure.
- New tests must automatically enter their unit or integration layer. Test entry points must not rely long-term on per-file manual registration that can silently omit newly added tests.
- Any change to tests, fixtures, preloads, test configuration, or test entry points must run the root `bun run check:test-isolation` gate. Also confirm that root test orchestration still includes this package and that the executed file set did not shrink unexpectedly.

## Debugging and Verification

- Debugging, manual verification, and real-process smoke tests use an isolated `WOPAL_HOME`, temporary repositories, and controlled credentials; never use a real user's Home or Space as a test environment.
- TypeScript changes must pass `bun run typecheck`; changed code files also follow the parent `oxlint --deny-warnings` and Prettier gates.
- Server/SDK contract changes must be verified at the real HttpApi/generated-SDK consumer boundary in addition to module service tests.
- When changing test layers, runners, or package scripts, run both package-local and root targeted commands and confirm they execute the intended test layer.
- Logs, errors, and diagnostics follow Ellamaka's root logging rules; never log secrets, user file contents, command arguments, or unbounded child-process output for debugging.

## Code Review Rules

Inherit the review process and defect-report boundary from `../../AGENTS.md`; this section adds only WopalSpace-specific checkpoints.

### WopalSpace-specific checkpoints

- Check that responsibilities stay within the WopalSpace application-owner boundary and do not create a second public contract.
- Check that source decomposition preserves business ownership and does not introduce cross-domain deep imports, caller duplication, technical-layer bucketing, generic shared dumping grounds, or speculative abstraction.
- Check that query/import paths do not introduce hidden side effects, Runtime bootstrap, network access, or process activity.
- Check that paths remain confined by trusted host roots and business boundaries, including realpath/symlink escape cases.
- Check that preview and apply share decision logic and that pre-write revalidation, partial success, cancel/retry, and failure recovery remain explainable.
- Check that user content, dirty changes, persisted state, and secrets remain within their protected boundaries.
- Check that tests use the correct layer and isolated fixtures, and that new tests cannot be silently omitted by package-local or root runners.

## User-Supplied Rules

- This module inherits the user rules in `../../AGENTS.md`; there are no additional module-specific user rules.
