---
name: Ellamaka AGENT RULES
description: WopalSpace engine fork of OpenCode for running space-aware agents, commands, plugins, configuration, and TUI behavior
---

# Agent Development Rules

## Canonical References

- DESIGN: `docs/DESIGN.md`
- DSH FUSION: `docs/DESIGN-dsh-base.md` (foundation: file territory, closure, hot reload)
- DSH WEB PROFILE: `docs/DESIGN-dsh-web.md` (plugin supply chain, plugin market, Workbench integration)
- TOOL CONTAINER: `docs/DESIGN-ellamaka-tools.md` (capability adoption, tool projection, sandbox)
- API CONTRACT: `docs/API-CONTRACT.md`
- WORKBENCH: `docs/DESIGN-workbench.md`
- ONBOARDING: `docs/DESIGN-onboarding.md`
- DESKTOP: `docs/DESIGN-desktop.md`
- DISTRIBUTION: `docs/DESIGN-distribution.md`
- Config Reference: `docs/references/ellamaka-config-mechanism.md`
- opencode package rules: `packages/opencode/AGENTS.md`
- ellamaka-cordis package rules: `packages/ellamaka-cordis/AGENTS.md`
- ellamaka-app package rules: `packages/ellamaka-app/AGENTS.md`
- desktop package rules: `packages/ellamaka-desktop/AGENTS.md`

## Architecture and Directories

Execution chain: OpenCode upstream → ellamaka fork → `--wopal-space` → `.wopal/` ontology → `.wopal-space/` runtime.

| Directory | Responsibility |
|---|---|
| `packages/opencode/` | Inherited OpenCode engine main package; see `packages/opencode/AGENTS.md` for internal rules |
| `packages/ellamaka-core/` | Shared core, flags, global paths, installation/runtime primitives |
| `packages/ui/` | Inherited UI component library; only modify when engine/TUI requires |
| `packages/plugin/` | Workspace support package |
| `packages/sdk/` | SDK workspace; JS SDK regeneration uses existing script |
| `packages/ellamaka-brand/` | Brand constants, logo, build wrapper, WopalSpace auto-detection, install path detection, and package-level tests |
| `packages/ellamaka-app/` | Workbench Web UI frontend; see `packages/ellamaka-app/AGENTS.md` for internal rules |
| `packages/ellamaka-desktop/` | Electron desktop app hosting ellamaka-app Workbench and local Ellamaka sidecar; see `packages/ellamaka-desktop/AGENTS.md` |
| `docs/` | Project DESIGN, API contract, references, research, and plans |

### Wopal Integration

Wopal capabilities enter the engine through two module groups in `packages/opencode/src/`: `wopal/` (CLI adapter, contract, schema, SpaceRegistry) and `workbench/` (session provisioning, session projection, directory health); their HTTP surface lives in the `workbench` and `wopal-space` HttpApi groups.

- Session provisioning accepts only registered Spaces and safe relative directories (traversal and unknown Spaces are rejected); a failed directory never deletes the Session.
- Endpoint behavior and error semantics are owned by [API-CONTRACT](./docs/API-CONTRACT.md); integration tests live in `packages/opencode/test/server/` (`wopal-cli-adapter`, `wopal-space-overview`, `workbench-session-api`).

## Development Commands

| Scenario | Command |
|---|---|
| Lint | `bun run lint` |
| Full-repo typecheck | `bun run typecheck` |
| opencode package tests | `bun test --timeout 30000 --force-exit` (from `packages/opencode`) |
| opencode build | `bun run build` (from `packages/opencode`) |
| ellamaka-brand package tests | `bun test` (from `packages/ellamaka-brand`) |
| Build ellamaka-branded CLI | `bun packages/ellamaka-release/src/cli/build.ts --web-ui ellamaka-app` |
| Build CLI binary | `./scripts/build.sh cli` |
| Build desktop app | `./scripts/build.sh desktop` |
| Release CLI | `./scripts/release-cli.sh [--patch\|--minor\|--major\|--rc] [--dry-run]` |
| Release Desktop | `./scripts/release-desktop.sh [--patch\|--minor\|--major\|--beta] [--dry-run]` |
| Withdraw a released version | `./scripts/withdraw-release.sh <cli\|desktop> [--channel stable\|beta] [version]` |
| Dev server (TUI/Workbench/Desktop) | `./scripts/dev.sh` |
| Desktop package tests | `bun test --preload ./electron-mock.ts --force-exit src` (from `packages/ellamaka-desktop`) |

Tests cannot run from repo root. Run `./scripts/dev.sh help` and `./scripts/build.sh help` for full parameter documentation.

## Implementation Rules

### WopalSpace Customization Constraints

- WopalSpace customizations should go in new files first; upstream files should only contain minimal import and call injection points.
- Use early-return guards in customization branches to avoid overlapping with upstream mainline changes.
- When new modules need access to upstream internal capabilities, prefer callback/closure injection over directly exposing upstream Service type boundaries.
- Extract shared helpers when reusing upstream logic; do not copy large upstream flows.
- Do not perform unrelated formatting, import reordering, dependency reordering, or object key reordering on upstream files.
- `.gitattributes` carries no `merge=ours` rules; conflicts surface and are resolved explicitly, file by file. Do not add merge strategy drivers.

### HTTP API and SDK Contract

- Follow `docs/API-CONTRACT.md` for every new endpoint. Establish the domain owner, Root/Instance scope, existing group, and resource semantics before defining Effect Schemas, requests, success results, domain errors, and compatibility.
- Endpoints belong to `HttpApiGroup`. Global WopalSpace control capabilities belong to the Root API. Session, file, project, PTY, and working-directory capabilities belong to the Instance API. Handlers only translate between HTTP and domain services.
- Paths express domain resources and their natural relationships. Query parameters express query conditions. Filesystem access, shell execution, CLI invocation, and directory provisioning are owned by their domain services rather than exposed as browser-callable primitives.
- The SDK is generated through Effect HttpApi → OpenAPI → `packages/sdk/js/script/build.ts`. Application code uses the generated client; `packages/sdk/js/src/v2/gen/**` is owned by the generation pipeline.
- Every endpoint addition or modification tests its schemas, success result, domain errors, and middleware boundary, regenerates the SDK, and updates the relevant DESIGN documents.
- **SDK regeneration is all-or-nothing**: after any payload schema change, always run `bun script/build.ts` from `packages/sdk/js` (never hand-edit gen files). A field is shipped only when BOTH `types.gen.ts` and `sdk.gen.ts` contain it — the type layer alone is not proof; a stale `buildClientParams` mapping silently drops the field at encoding time with no error (see SDK generation section in [ellamaka design](./docs/DESIGN.md)). Verify with `rg "<fieldName>" src/v2/gen/` hitting both files, or diff the regenerated output.
- **Permission rules: explicit beats wildcard only by position**: evaluation is LAST-wins over the merged ruleset, and one agent's frontmatter can come from multiple copies (`~/.wopal` home + space `.wopal`) deep-merged in load order. Frontmatter must not declare `"*": allow`-style wildcards (engine defaults already provide the wildcard fallback); only explicit narrowings. After changing permission frontmatter, verify on the live instance via `GET /agent` that the explicit rule sits after any wildcard in the merged list (see permission merge section in [ellamaka design](./docs/DESIGN.md)).

### Workbench Frontend Development

Workbench frontend development rules (state ownership, identity scope, dependency direction, PTY lifecycle, effect race protection, persistence, testing, and other mandatory boundaries) are in `packages/ellamaka-app/AGENTS.md`. This file does not duplicate those rules; changes to Workbench frontend code must follow that specification.

### CLI Release Contract

- The release build entry (`packages/ellamaka-release/src/cli/build.ts`) is the only bundling point for published CLI binaries (`scripts/build.sh cli`, CI `publish-ellamaka-cli.yml`). Its `define` block MUST keep the `"process.env.MIN_WOPAL_CLI_VERSION"` entry — the value is exported by `scripts/build.sh` (via `resolve_min_wopal_cli_version`) and falls back to `.ci/versions.json` through `readMinWopalCliVersion`. The runtime (`packages/opencode/src/wopal/cli-contract.ts`) fails closed at module load, and compiled bundles skip the source-tree file fallback: a build that drops or misspells this define still passes its own smoke test on the build machine (the checkout resolves the fallback path) but crashes on every end-user machine. When moving or splitting build entries, move this define with them.

### Desktop Release Contract

- `main` is for local `build.sh desktop --channel main` verification only. Release workflows accept only `beta` and `stable`.
- Windows Desktop UI changes require native Windows CI and runtime validation. macOS builds are insufficient.
- Release workflows use only Node 24-native official JavaScript actions. Before adding or upgrading an action, inspect its `action.yml`; `runs.using` must be `node24`. `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` is a compatibility guard, never a substitute for the upgrade. Release workflow tests lock the approved action baseline.
- Product versions use namespaced tags (`ellamaka-cli-vX.Y.Z`, `ellamaka-desktop-vX.Y.Z`) per [Tags 与 Channels](./docs/DESIGN-distribution.md#tags-与-channels). Committed releases are immutable: the same `product + version` tag is never deleted, moved, or re-built. Pre-commit failed attempts may be retried at the same version after controlled cleanup; post-commit major failures require whole-version withdrawal (record in `release/withdrawn-versions.json`, restore aliases, delete versioned objects) and the version is permanently retired.
- Windows quit waits for the SidecarSupervisor to stop before Electron terminates.
- Beta versions use `X.Y.Z-beta.N` and publish to `ellamaka-desktop/beta/`. Stable publishes to `ellamaka-desktop/`.
- Sidecar, Electron Main/Renderer, icons, and electron-builder share the same channel/version environment variables.
- Public macOS packages use ad-hoc signing. This guarantees bundle signature integrity, but users must still accept Gatekeeper risk manually.
- Versioned R2 paths are immutable. Pre-commit failed attempts may clear their own partial objects before retry at the same version; post-commit releases must never be overwritten. Whole-version withdrawal follows [Failed Attempt and Whole-Version Withdrawal](./docs/DESIGN-distribution.md#failed-attempt-and-whole-version-withdrawal).
- Download tables show DMG, EXE, AppImage, and deb. ZIP, blockmap, and `latest-*.yml` are updater assets.

### Cordis Development Constraints

- **Dependency boundary**: `@deepseek-ai/cordis` appears only inside `@wopal/ellamaka-cordis` (the version is owned by that package's `package.json` and never restated in docs); deeply-coupled dsh packages (agent-loop/session/session-query/compaction/subagent/schedule) stay out of mainline runtime for now (see [ellamaka design](./docs/DESIGN.md) current conventions — no red lines in PoC, changes need user+Wopal joint confirmation); the runtime probe test (`forbidden-load.test.ts`) remains as an observation tool
- **Live-home quarantine (dsh in ellamaka)**: while the ellamaka engine is running, nothing outside the engine process may write under `$WOPAL_HOME/dsh/home/profiles/` — including "idempotent" writes whose content is unchanged (the loader's standing rebuild keys on composition-file mtime/size, not content, so a same-content write races the engine and can trigger the tool-cordis registration-conflict error storm). Tests, dumps, and diagnostics that would touch profile files run against a temp home by injection (`dumpDshConfig`/`mountDshWeb` accept `dshHome`/`installAnchor`); CLI tests assert definitions or use injected temp homes, never the real `Global.Path.wopalHome`. Engine restart is the user's action; the host never repairs the live home. The plugin install area is the profile's own `node_modules/` + the profile `package.json` declaration (official semantics) — the legacy `plugins/` install area and `installed.json` store are retired (a leftover store file migrates once into the profile manifests on the next CLI run).
- **Toolchain isolation — dsh profiles vs wopal root**: dsh profile plugins are installed by the Bun installer into each profile's own `node_modules/`. The official `dsh` CLI is a pnpm shell; never point any command at `$WOPAL_HOME/dsh/home` — a `pnpm-workspace.yaml` at the wopal root makes pnpm climb to `$WOPAL_HOME` as the workspace root, listing root deps instead of the profile's plugins and destroying Bun-managed topologies on add/remove (verified 2026-09-09). `$WOPAL_HOME` root dependencies are owned exclusively by the npm/arborist toolchain (`package.json` + `package-lock.json`); never run `pnpm install` or `bun install` at the wopal root — it overwrites the node_modules layout and produces the three-lockfile pollution (npm/pnpm/bun on the same dependency set, observed 2026-09-09).
- **Bridge form**: all Effect↔async bridges follow the bridge API rules in [ellamaka design](./docs/DESIGN.md) (`Effect.forkIn(scope)(work)` with the work Fiber held; interrupt via `runtime.runFork(Fiber.interrupt(fiber))`; never drive long-running work via `runPromise`)
- **Contract discipline**: contracts are self-owned inside `@wopal/ellamaka-cordis` (shapes borrowed from dsh; never import dsh contract packages or track rc releases); external plugins mount only after passing contract conformance smoke tests (see the adoption boundary in [tool container design](./docs/DESIGN-ellamaka-tools.md))
- **Test gate**: the bridge package's own tests live in `packages/ellamaka-cordis/test/`; cross-package behavior is carried by the opencode-side `test/cli/serve/dsh-mount.test.ts`, `test/cli/cmd/tui/dsh-mount.test.ts`, `test/server/dsh-single-port.test.ts`, and peers; bridge package changes keep those tests green
- **Event-log folds are LAST-wins**: dsh session events (`sandbox/mode`, `approval/policy`) fold with the last event winning. "Restore the default" requires appending the default value explicitly; "equal to default" and "not chosen" are different semantics and must never share a code path (see the approval bridge section and its fold invariant in [tool container design](./docs/DESIGN-ellamaka-tools.md)). A test that asserts "same value appends nothing" pins the wrong semantics unless the log carries no prior overrides.
- **Host never repairs the live dsh home**: closure materialization is the Runtime Manager's job at startup. A missing or corrupt closure triggers automatic materialization. Never ask the user to run a repair script, and never hand-edit `$WOPAL_HOME/dsh` content to fix a startup failure.
- **Bun host compatibility gate**: the released `ellamaka serve` runs as a single Bun process. User plugins must not require Node private module loaders or `--expose-internals`. `plugin add` completes a static dependency scan and an isolated mount precheck before writing the profile declaration or touching a running container; an incompatible plugin is rejected with an actionable diagnostic. Never fake `loader.internal`, switch to Node, or degrade the whole host to work around it. The official Node-only `cordis-plugin-hmr` is a host-side exception: the Bun path uses the Bridge's HMR adapter instead, and that exception never transfers to third-party plugins.
- **Plugin installation uses no external toolchain**: the installer never forwards to pnpm or npm. It reuses the Runtime Manager's pacote download and registry speed-probe, and resolves user plugin trees with the built-in minimal resolver at runtime.
- **Plugins install once, activate per profile**: installation is a process-level action (install, upgrade, uninstall happen once for the whole host); activation is declared per container through the profile bundle list. Never run two versions of the same package in one process.
- **Tool container never creates a session**: tool calls go through the dedicated `ellamaka-tools` profile. The container creates and holds no dsh session, and the adapter passes only the minimal per-call context the tools consume. The web profile stays complete and is never reused as a tool backend. The disable list is the profile's user patch layer: ellamaka seeds it only when the template is empty and never overwrites user edits.
- **`ELLAMAKA_DSH` is the only enable switch**: it defaults to on. serve, web, TUI, and the Desktop sidecar all disable through `ELLAMAKA_DSH=0`. Never introduce a second enable branch.
- **DSH territory is `$WOPAL_HOME/dsh` only**: dependency closures, profile definitions, and runtime data live there. The host sets `DSH_HOME=$WOPAL_HOME/dsh/home` at process start; integration code never reads that env var for its own paths. `~/.dsh` belongs to the official dsh CLI — never create, modify, or delete anything inside it.
- **Multi-profile isolation**: the core containers (web and `ellamaka-tools`) stay in one process. Experimental third-party profiles run in separate processes with their own DSH_HOME. They never enter the main web container and never share the main engine's home or profiles — a running engine's `profiles/` directory is engine territory. Closures are read-only and may be shared; home must be isolated.
- **Shell single-port invariant**: the renderer loads UI from exactly one http origin (the server port). The shell carries no engine logic and opens no second listening port. The engine has one artifact form — the full CLI binary; never maintain a second forked engine build. `/dsh` stays a prefix mount rather than a root, and `/` is the device-negotiation front door (mobile UA → `/dsh/`, desktop UA → `/workbench`).

### Logging Rules

- **Plugin logging**: cordis plugins log exclusively via built-in `ctx.logger` (auto-named by plugin); no `console.log`, no manual Logger creation; the container-level Exporter bridges to the ellamaka `Log` system at the assembly layer (see [tool container design](./docs/DESIGN-ellamaka-tools.md)), so plugins never care where logs go
- **Must log**: lifecycle state changes (init/created/disposed/mount/unmount), errors and exceptions (including degraded paths), key decisions (selection/fallback/skip)
- **Must not log**: per-item operations inside loops (per-file/per-entry), routine operations on the success path (every load/every search), information derivable from context
- **Aggregate**: when a loop needs observability, log one summary outside the loop (`log.info("reverted", { count })`), never per-item inside the loop body
- **Structured**: carry context in the `extra` field (`log.info("reverting", { file, hash })`), never concatenate into the message; use fixed verb phrases for the message so it is searchable
- **Never swallow errors silently**: a `catch` must log (error or warn); no empty catch
- **Level**: default `INFO`; `debug` is diagnostic-only and not emitted in production
- **Trace is opt-in per category**: `TRACE` is the fifth level, below `DEBUG`. It carries the high-volume lifecycle records that normal operation must not emit. Emit them via `log.trace(category, message, extra)` (Effect code: `EffectLogger.create(...).trace(...)`). The level alone emits nothing — a record is written only when a category is explicitly selected. Categories are a closed registry (`Log.TraceCategory`): `bus`, `permission`, `session`, `llm`, `plugin`, `io`. Never introduce a category without a call site and a row in LOGGING.md
- **Trace never carries payloads or user data**: bus trace records the event type only; permission trace records the permission name, decision `action` (`allow|ask|deny`), an `escalated` marker, a count, and the reply outcome; session/LLM trace records the step counter and runtime/model identifiers. Never write the event payload, prompt or message content, tool arguments, evaluated pattern, command, path, session id, or pending request contents. An explicit `--log-level` always wins over `--trace` promotion
- **Authority**: [packages/opencode/LOGGING.md](./packages/opencode/LOGGING.md) is the detailed serve-logging policy (channels, DSH classification, trace categories). Update it in the same change as any logging-behavior edit

### Debugging Logs

When diagnosing serve, TUI, or sidecar behavior, widen output through the log level rather than adding temporary records to the code. TRACE always names its categories; `--log-level TRACE` without `--trace` is rejected on purpose.

| Scenario | Command | Notes |
|----------|---------|-------|
| List trace categories | `ellamaka serve --trace` | Prints the registry and exits |
| Default (quiet, structured) | `ellamaka serve` | `INFO`, warnings, and failures only |
| Permission + event lifecycle | `ellamaka serve --trace permission,bus` | Promotes the level to `TRACE`; other categories stay silent |
| Session/LLM loop detail | `ellamaka serve --trace session,llm` | The loops that historically flooded the log |
| Plugin and I/O startup | `ellamaka serve --trace plugin,io` | Plugin load, MCP connect, LSP/format activity |
| Every category (escape hatch) | `ellamaka serve --trace all` | Must be explicit; no implicit all |
| Implementation diagnostics | `ellamaka serve --log-level DEBUG` | Bounded, still redacted |
| Override trace promotion | `ellamaka serve --log-level INFO --trace bus` | Explicit level wins; no `TRACE` records emit |

- Log locations: non-dev CLI writes `serve-*` / `tui-*` / `sidecar-*` under `$WOPAL_HOME/logs/`; dev mode writes to `.wopal-space/logs/dev/<scope>/`. Cleanup keeps the latest 10 timestamped files collectively.
- DSH has four levels, so host `TRACE` maps to DSH `DEBUG` at the boundary; DSH log files are `$WOPAL_HOME/logs/dsh-runtime.log` and `dsh-plugins.log`.
- If a category's records are missing, confirm the category is in the selector (an explicit `--log-level` overrides `--trace`, and an unknown category is rejected at startup).

## Testing & Verification

- Code changes follow TDD: write a failing test first, then implement code to make it pass.
- Run `bun run lint` before committing (repo-wide pre-existing warnings are tolerated as a baseline). Every file you touch must pass `bunx oxlint --deny-warnings <files>` (`<files>` = your changed files, e.g. `git diff --name-only HEAD~1 | grep -E '\.tsx?$' | xargs bunx oxlint --deny-warnings`): no new warning in any changed file, regardless of the repo-wide warning count.
- Format touched files with `bunx prettier --write <files>`; `bunx prettier --check --ignore-unknown <files>` must pass.
- After modifying any TypeScript code or adding new files, run `bun run typecheck` (or the corresponding package's typecheck) and ensure zero TypeScript type errors.
- Avoid mocks as much as possible; test real implementations, do not duplicate logic into tests.
- Tests must run from the corresponding package directory, never from repo root.
- After modifying CLI/runtime/config/plugin/agent/TUI space mode, verify or document: `WOPAL_SPACE` flag, `.wopal/config/settings.*`, TUI settings, plugin loading, theme loading.
- When selecting code from the OpenCode reference repo, distinguish reference-implementation known failures, environment issues, and ellamaka-specific problems.
- Test safety rules (preventing hangs and orphan processes) are in the space `REGULATIONS.md`.

### Manual Verification Entry Points

Behaviors an agent cannot verify automatically (GUI interaction, onboarding flow, desktop shell) are handed to the user for manual verification through the entries below.

| Entry | Command | Isolation |
|-------|---------|-----------|
| Desktop (regular) | `./scripts/dev.sh desktop` | Uses the real environment; first run needs `--rebuild` to build the sidecar |
| Workbench / backend | `./scripts/dev.sh serve` | Port 4096; `--cdp-debug` opens 9222 CDP |
| TUI | `./scripts/dev.sh tui` | In-process backend by default |
| Stop | `./scripts/dev.sh stop <backend\|frontend\|desktop\|all>` | — |

- Logs: `.wopal-space/logs/dev/<scope>/ellamaka-dev-{desktop,sidecar}.log` (`<scope>` is derived from the worktree path).
- A Plan's User Validation must reference this table and give a command the user can copy and run directly; generic wording such as "start the app" is not acceptable.

## User-Supplied Rules

- JS SDK regeneration: `./packages/sdk/js/script/build.ts`.
- The default branch in this repo is `main`. ellamaka has stopped tracking upstream OpenCode (2026-08-31); the `dev` branch is no longer used for upstream merge integration.
- Use `main` or `origin/main` as the diff baseline. To reference upstream OpenCode module code, read from `labs/ref-repos/opencode/` in the workspace.
- Prefer auto-executing clear requests; confirm when missing critical info, security risks, or irreversible operations.
