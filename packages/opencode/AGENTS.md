---
name: opencode package AGENT RULES
description: Main inherited OpenCode engine package for CLI, runtime, config, server, session, tools, storage, and TUI integration
---

# Agent Development Rules

## Canonical References

- Project DESIGN: `../../docs/DESIGN.md`
- Core Readiness contract: `../../docs/DESIGN.md#core-readiness-and-preparation`
- Parent Rules: `../../AGENTS.md`
- Test Rules: `test/AGENTS.md`
- Server Test Rules: `test/server/AGENTS.md`
- HttpApi Route Rules: `src/server/routes/instance/httpapi/AGENTS.md`
- Effect Migration Reference: `specs/effect/migration.md`

## Architecture and Directories

Execution chain: CLI entry → config/runtime services → server/session/tool/storage/TUI → WopalSpace hooks.

This is ellamaka's main engine package. It carries the OpenCode inherited runtime and plugs into WopalSpace config, plugin, agent, command, permission, and TUI hooks; customization boundaries follow the parent `../../AGENTS.md`.

| Directory               | Responsibility                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/`              | CLI commands, TUI command entry, and command-specific runtime glue                                                          |
| `src/config/`           | Config schema, loading, merge, command/agent/plugin config, and wopal-space config hooks                                    |
| `src/server/`           | Effect HttpApi server, routes, middleware, and adapters                                                                     |
| `src/session/`          | Session lifecycle, messages, events, retry/status session domain logic                                                      |
| `src/tool/`             | Tool definitions, permission-facing tool behavior, and runtime execution surfaces                                           |
| `src/storage/`          | Database access, storage adapters, and persisted runtime data                                                               |
| `src/effect/`           | Shared Effect runtime helpers, InstanceState, and service runtime utilities                                                 |
| `src/permission/`       | Permission matching, merge, and tool authorization behavior                                                                 |
| `src/plugin/`           | Plugin loading, plugin origin handling, and plugin runtime integration                                                      |
| `test/`                 | Package-local tests and fixtures; detailed rules in `test/AGENTS.md`                                                        |
| `migration/`            | Drizzle migration output                                                                                                    |

## Development Commands (build format test)

| Scenario                 | Command                             | When                                                                                                                  |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dev                      | `bun run dev`                       | Local package dev entry                                                                                               |
| Typecheck                | `bun typecheck`                     | After TypeScript changes; never run `tsc` directly                                                                    |
| Test (default subset)    | `bun run test:unit`                 | After behavior changes (fast unit subset, ~25s)                                                                       |
| Test (heavy integration) | `bun run test:integration`          | After changes that `test/AGENTS.md` classifies as integration                                                      |
| Test (e2e)               | `bun run test:e2e`                  | After changes to real provider-chain / browser e2e tests                                                              |
| Test (full regression)   | `bun run test:all`                  | Full regression (equivalent to `bun test --timeout 30000 --force-exit --max-concurrency=4`)                           |
| Build                    | `bun run build`                     | After runtime, CLI, or package build changes                                                                          |
| Database migration       | `bun run db generate --name <slug>` | After schema changes                                                                                                  |

The package-local commands above run from `packages/opencode`. Repository-root commands are reserved for the explicit cross-package orchestration described below and repository-wide gates owned by the parent rules.

## Implementation Rules

- Follow parent `../../AGENTS.md` for Bun, TypeScript, WopalSpace mode, upstream customization boundaries, and verification rules.
- Module shape rules (namespace ban, self-reexport, barrel ban) follow the User-Supplied Rules at the bottom of this file.
- For `index.ts` single-file modules, self-reexport with `"."`, not `"./index"`.
- In `src/config`, follow the existing self-export pattern when adding new modules: `export * as ConfigAgent from "./agent"`.
- Drizzle schemas live in `src/**/*.sql.ts`.
- Drizzle tables and columns use snake*case; join columns use `<entity>_id`; indexes use `<table>*<column>\_idx`.
- Migrations are generated by Drizzle Kit to `migration/<timestamp>_<slug>/migration.sql` and `snapshot.json`.
- Migration tests read per-folder layout; do not depend on `_journal.json`.
- Use `Effect.gen(function* () { ... })` for Effect composition.
- Use `Effect.fn("Domain.method")` for named/traced public effects; `Effect.fnUntraced` for internal helpers.
- `Effect.fn` / `Effect.fnUntraced` accept pipeable operators directly; avoid unnecessary outer `.pipe()`.
- Use `Effect.callback` for callback-based APIs.
- Use `Effect.void` instead of `Effect.succeed(undefined)` or `Effect.succeed(void 0)`.
- Prefer `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)`.
- Use `Schema.Class` for multi-field data; branded schemas for single-value types.
- Use `Schema.TaggedErrorClass` for typed errors; `Schema.Defect` for defect-like causes.
- In `Effect.gen` / `Effect.fn`, prefer `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))`.
- Use `makeRuntime` (`src/effect/run-service.ts`) for all services; returns `{ runPromise, runFork, runCallback }` with a shared memoMap that deduplicates layers.
- Use `InstanceState` (`src/effect/instance-state.ts`) for per-directory state requiring per-instance cleanup; backed by ScopedCache keyed by directory with automatic disposal. Services needing directory isolation must use it.
- In `InstanceState.make` closure, do work directly; use `Effect.addFinalizer` / `Effect.acquireRelease` for cleanup, `Effect.forkScoped` for background consumers. Do not add extra fibers, `ensure()`, or `started` flags.
- `bootstrap.ts` wraps `init()` as fire-and-forget; keep service `init()` synchronous internally. If non-blocking init is needed, fork at the call site, not inside `make` closure.
- Effect v4 beta has no `Effect.fork` or `Effect.forkDaemon`; use `Effect.forkIn(scope)`.
- In Effect services, prefer yielding existing Effect services over ad hoc platform APIs.
- Prefer `FileSystem.FileSystem` for file I/O, `ChildProcessSpawner.ChildProcessSpawner` + `ChildProcess.make(...)` for processes, `HttpClient.HttpClient` for HTTP.
- When already in Effect code, prefer `Path.Path`, `Config`, `Clock`, `DateTime`.
- For background loops or scheduled tasks, use `Effect.repeat` or `Effect.schedule` with `Effect.forkScoped` in the layer definition.
- Use `Effect.cached` when multiple concurrent callers share one in-flight computation; do not hand-roll `Fiber | undefined` or `Promise | undefined` caches. See `specs/effect/migration.md`.
- When modifying `src/server/routes/instance/httpapi/`, follow HttpApi route patterns; do not rebuild stable layers in request handlers.

## Testing

- Behavior changes in this package follow the parent Testing Best Practices and use TDD whenever its canonical applicability rule selects a RED cycle. Put the failing test at the lowest observable opencode boundary that owns the behavior, then use the package-specific layer and helpers owned by `test/AGENTS.md`.
- `test/AGENTS.md` is the detailed owner for layer selection, runner discovery, integration directory/file naming, the unit-layer speed budget, Effect fixtures, readiness helpers, and test-host conventions. Update that file—not this section—when those mechanics change.
- Run package-local test entries from `packages/opencode`; use the repository root only for explicit cross-package orchestration (`bun run test:unit|test:integration|test:e2e`) or repository-wide gates owned by the parent rules.
- Server and HttpApi middleware tests follow `test/server/AGENTS.md`; prefer focused middleware tests and the Effect HTTP stack.
- When modifying database schema, generate a migration and add or update migration tests.
- After modifying CLI/runtime/config/plugin/agent/TUI space mode, verify or document: `WOPAL_SPACE` flag, `.wopal/config/settings.*`, TUI settings, plugin loading, theme loading.
- Windows Git clones typically use `core.symlinks=false`; the plugin resolver must resolve flattened symlink placeholder files (whose content is a constrained relative source path) to the real file inside the same plugin directory, and reject directory-escape targets.

## User-Supplied Rules

### Module Shape

Do not use `export namespace Foo { ... }` for module organization. It is not standard ESM, it prevents tree-shaking, and it breaks Node's native TypeScript runner. Use flat top-level exports combined with a self-reexport at the bottom of the file:

```ts
// src/foo/foo.ts
export interface Interface { ... }
export class Service extends Context.Service<Service, Interface>()("@opencode/Foo") {}
export const layer = Layer.effect(Service, ...)
export const defaultLayer = layer.pipe(...)

export * as Foo from "./foo"
```

Consumers import the namespace projection:

```ts
import { Foo } from "@/foo/foo"

yield * Foo.Service
Foo.layer
Foo.defaultLayer
```

Namespace-private helpers stay as non-exported top-level declarations in the same file — they remain inaccessible to consumers (they are not projected by `export * as`) but are usable by the file's own code.

#### When the file is an `index.ts`

If the module is `foo/index.ts` (single-namespace directory), use `"."` for the self-reexport source rather than `"./index"`:

```ts
// src/foo/index.ts
export const thing = ...

export * as Foo from "."
```

#### Multi-sibling directories

For directories with several independent modules (e.g. `src/session/`, `src/config/`), keep each sibling as its own file with its own self-reexport, and do not add a barrel `index.ts`. Consumers import the specific sibling:

```ts
import { SessionRetry } from "@/session/retry"
import { SessionStatus } from "@/session/status"
```

Barrels in multi-sibling directories force every import through the barrel to evaluate every sibling, which defeats tree-shaking and slows module load.
