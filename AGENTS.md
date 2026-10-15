---
name: Ellamaka AGENT RULES
description: Long-lived architecture boundaries, implementation, logging, release, and verification rules for Ellamaka
---

# Agent Development Rules

## Canonical References

- [DESIGN](docs/DESIGN.md) is the authority for target behavior and detailed architecture contracts.
- Read sub-designs as the task requires: DSH foundation [DESIGN-dsh-base](docs/DESIGN-dsh-base.md), DSH Web [DESIGN-dsh-web](docs/DESIGN-dsh-web.md), tool container [DESIGN-ellamaka-tools](docs/DESIGN-ellamaka-tools.md), unified SDK [DESIGN-ellamaka-sdk](docs/DESIGN-ellamaka-sdk.md), Workbench [DESIGN-workbench](docs/DESIGN-workbench.md), Desktop [DESIGN-desktop](docs/DESIGN-desktop.md), Onboarding [DESIGN-onboarding](docs/DESIGN-onboarding.md), distribution [DESIGN-distribution](docs/DESIGN-distribution.md), logging [DESIGN-logging](docs/DESIGN-logging.md), config [DESIGN-config-engine](docs/DESIGN-config-engine.md).
- Package rules (required when changing the package): [opencode](packages/opencode/AGENTS.md), [ellamaka-cordis](packages/ellamaka-cordis/AGENTS.md), [ellamaka-app](packages/ellamaka-app/AGENTS.md), [ellamaka-desktop](packages/ellamaka-desktop/AGENTS.md).
- This file keeps the stable rules an agent must follow while implementing and verifying; detailed data models, flows, and APIs stay in their owning DESIGN, but a rule is not dropped here merely because a DESIGN also describes it.
- Root `AGENTS.md` and `AGENTS.zh-CN.md` are bilingual mirrors; any rule change updates both in the same commit.

## Architecture and Directories

Ellamaka combines Runtime, a Server composition host, the private WopalSpace application service, and the official App BFF. The Server may mount Public Platform API and App-private BFF on one host; lower-level Runtime does not depend on either WopalSpace or the App BFF. Browser/Desktop use the public SDK for platform capabilities and an app-private generated client for official App projections, while Wopal CLI owns Product management. The target boundaries are in DESIGN; this filesystem map lists only paths that currently exist.

| Path | Module responsibility |
|---|---|
| packages/ellamaka-core/ | Shared product primitives for paths, processes, files, and logging |
| packages/opencode/src/cli/ | Ellamaka CLI entry, command routing, and TUI startup |
| packages/opencode/src/config/, packages/opencode/src/plugin/ | Configuration evaluation and plugin assembly |
| packages/opencode/src/server/ | Server composition, Root/Instance APIs, HTTP and event connections; WopalSpace handler integration is under routes/instance/httpapi/ |
| packages/opencode/src/session/, packages/opencode/src/agent/, packages/opencode/src/permission/, packages/opencode/src/tool/ | Runtime sessions, agents, permission evaluation, and tool execution |
| packages/opencode/src/workbench/ | Server-side Workbench composition of Runtime and Space data |
| packages/ellamaka-cordis/ | DSH closure loading, Cordis lifecycle, and profile bridge |
| packages/sdk/js/ | Public Runtime/WopalSpace contracts and generated client |
| packages/ellamaka-app/ | Shared Browser/Desktop Onboarding and Workbench UI plus ownership of the Official App BFF contract/client |
| packages/ellamaka-desktop/ | Electron shell and Server sidecar lifecycle |
| packages/ellamaka-release/ | CLI/Desktop product builds, identity, and release |

Keep these boundaries in mind when choosing an owner:

- Space configuration and Runtime instances are scoped by request directory; process environment does not select the current Space for a multi-directory Server.
- Capability discovery is not Agent execution authorization. Reading configuration or passively querying Workbench facts does not activate a directory Runtime.
- The Ellamaka build that actually starts a Runtime prepares its own runtime resources. It does not scan or prewarm other installed products. ellamaka run remains native-only with DSH disabled.

## Development Commands

| Scenario | Command | When |
|---|---|---|
| Lint | bun run lint | After code changes |
| Full typecheck | bun run typecheck | After TypeScript changes |
| opencode unit tests | bun run test:unit (from packages/opencode/) | Runtime unit tests |
| opencode integration tests | bun run test:integration (from packages/opencode/) | Server or cross-module changes |
| App unit tests | bun run test:unit --force-exit (from packages/ellamaka-app/) | Frontend behavior changes |
| App boundary check | bun run check:workbench-boundaries (from packages/ellamaka-app/) | Workbench changes |
| Desktop tests | bun test --preload ./electron-mock.ts --force-exit src (from packages/ellamaka-desktop/) | Desktop main/renderer changes |
| Development entry | ./scripts/dev.sh help | GUI, TUI, and Server integration |

Run tests from their owning package. See package rules and script help for the full command matrix and artifact checks.

## Implementation Rules

- Server handlers adapt transport and invoke domain services; cross-domain composition belongs at the Server boundary. Runtime must not depend upward on WopalSpace. For cross-package work, also follow the nearest AGENT rules in each changed package.
- Preserve directory-instance scope when passing configuration and plugin context. After permission changes, verify the effective merged result; discovery lists are not authorization results.
- Changes to cross-package loading, resource resolution, or packaging require validation through the real product artifact, not only source checks.
- Give async work and child processes a clear owner. Cancellation and shutdown must wait for cleanup of owned resources.
- Use isolated Home, profiles, repositories, and credentials for validation; never mutate a user's live runtime state.
- Customization boundary (upstream files): put new capabilities in new files and keep upstream files to minimal import and call-injection points; guard customization branches with early returns so they do not overlap upstream mainline; prefer callback/closure injection over exposing upstream Service types; extract shared helpers instead of copying large upstream flows; do not perform unrelated formatting, import reordering, or dependency/object-key reordering on upstream files; do not add merge-strategy drivers to `.gitattributes` — resolve conflicts explicitly, file by file.
- DSH and Bridge: never run `pnpm install` or `bun install` at the `$WOPAL_HOME` root (pnpm climbs to the workspace root and destroys the Bun-managed dependency topology); while the engine runs, no write outside the engine process may touch `$WOPAL_HOME/dsh/home/profiles/` (even a same-content "idempotent" write races the engine); `ELLAMAKA_DSH` is the only enable switch; the Bridge ships only with the Ellamaka product — never published standalone and never a `$WOPAL_HOME/dsh` dependency; the tool container creates no dsh session and receives only the minimal per-call context; plugins install once and activate per profile, never two versions in one process.
- WopalSpace integration boundary: Setup, Ontology, and base Space business are implemented once in the private WopalSpace service and exposed through the Public Platform SDK. Product management, Evolution, Skill lifecycle, and scheduling remain Wopal CLI-owned. Ellamaka does not depend on Wopal CLI command handling, a shared schema package, or a minimum CLI version. Session provisioning accepts only registered Spaces and safe relative directories; a failed directory never deletes the Session.
- API and SDK: define the domain owner and Root/Instance scope first, and go through `HttpApiGroup`. Reusable Runtime/WopalSpace operations belong to the Public Platform contract and public SDK; official App-only projections/use cases belong to the App BFF private contract and must not enter public `/doc` or SDK exports. Regeneration is all-or-nothing for each contract — after a payload change, rerun its generator and verify type plus runtime parameter mapping. Never hand-edit generated files.
- Permission rules: agent frontmatter declares no `"*": allow`-style wildcards, only explicit narrowings; evaluation is LAST-wins, so an explicit rule must sit after the wildcard. After a change, verify the merged rule order on a live instance via `GET /agent`.
- Release discipline: the release build entry is the only bundling point for the CLI binary; introduce no Wopal CLI version floor or release-order dependency. CLI and Desktop update independently. Desktop UI changes must be validated on native Windows (a macOS build is not sufficient). Release workflows use only Node 24-native official actions — inspect `runs.using === "node24"` before adding or upgrading one. Committed releases are immutable; whole-version withdrawal follows DESIGN-distribution.
- Logging: ellamaka-core's structured logger owns routing and redaction; plugins log only through built-in `ctx.logger` (no `console.log`, no hand-built logger). Must log: lifecycle changes, errors and exceptions (including degraded paths), key decisions. Must not log: per-item records inside loops, routine success-path steps, information derivable from context. Aggregate a loop into one summary; carry context in structured fields rather than concatenating into the message; never swallow an exception in a `catch`. Default level INFO, DEBUG for diagnosis, TRACE selected explicitly per category. No log may carry credentials, prompt/message bodies, tool arguments, commands, paths, or unbounded child output. Level, routing, and file details live in DESIGN-logging.
- Debugging: widen output with `--log-level` / `--trace <category>` rather than adding temporary records to the code; an explicit `--log-level` overrides `--trace` promotion. Log locations (role-scoped directories, dev scope, DSH files) are in DESIGN-logging.
- Startup and progress: report only stages actually performed; show counts or percentages only when a real total exists; long phases emit heartbeat. Progress goes to stderr or a dedicated UI so machine stdout stays clean. `ELLAMAKA_DSH=0` reports one skipped event and performs zero DSH file/network/mount work.

## Testing

- Use TDD for behavior: first add a failing test for the observable input/output behavior, then implement and refactor.
- Test real owners and cross-module boundaries. Mock only explicit transport or external-system boundaries.
- Validate runtime closures, host integrations, and packaged artifacts through the corresponding real product path; state which limits remain after static checks.
- Automate repeatable logic and protocol checks. Reserve manual verification for GUI or native-host behavior that tests cannot observe.
- Every changed file must pass `bunx oxlint --deny-warnings <files>` (no new warning) and `bunx prettier --check`; TypeScript changes must typecheck; run tests from the owning package directory, never from the repo root.

### Manual Verification Entry Points

GUI, onboarding, and desktop-shell behavior verification entries. An agent can check Desktop through CDP; hand off only behavior that still needs human observation.

| Entry | Command | Isolation |
|---|---|---|
| Desktop (regular) | `./scripts/dev.sh desktop` | Uses the real environment; first run needs `--rebuild` to build the sidecar |
| Desktop (CDP) | `./scripts/dev.sh desktop --rebuild --cdp-debug` | Uses the real environment; ports 5173 and 9222 must be free |
| Workbench / backend | `./scripts/dev.sh serve` | Port 4096; `--cdp-debug` opens 9222 CDP |
| TUI | `./scripts/dev.sh tui` | In-process backend by default |
| Stop | `./scripts/dev.sh stop <backend\|frontend\|desktop\|all>` | — |

- Desktop CDP: `agent-browser --session <name> connect 9222` connects to the Electron window for UI verification.
- Logs (dev runs): `.wopal-space/logs/dev/<scope>/ellamaka-dev-{tui,serve,sidecar}.log`. `<scope>` is the first 10 hex chars of the md5 of the repo/worktree root that owns `scripts/dev.sh` (symlinks resolved) — resolve it from `.wopal-space/logs/dev/registry`, or recompute as dev.sh does `printf '%s' "<root>" | md5 -q | cut -c1-10`. A worktree run logs into its base space's ledger.
- A Plan's User Validation must reference this table and give a command the user can copy and run directly; generic wording such as "start the app" is not acceptable.

## User-Supplied Rules

- Regenerate the JS SDK with `./packages/sdk/js/script/build.ts`.
- The default branch is `main` and is the review baseline.
- Diff against `main` or `origin/main`; read upstream reference code from `labs/ref-repos/opencode/`.
- Execute clearly authorized requests directly. Ask only when key information is missing, a real safety risk exists, or an irreversible boundary applies.
