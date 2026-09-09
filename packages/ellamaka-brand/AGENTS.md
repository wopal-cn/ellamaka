---
name: ellamaka build package
description: Branding constants, WopalSpace detection, installation guard, and branded CLI build for the ellamaka fork
---

# Agent Development Rules

## 1. Canonical References

- Parent Rules: `../../AGENTS.md`
- Branding Design: `../../docs/BRANDING.md`
- Project Design: `../../docs/DESIGN.md`

## 2. Architecture and Directories

This package is responsible for ellamaka's brand identity injection and build. Upstream files reference brand constants via `import { BINARY_NAME } from "@ellamaka/build/branding"` rather than hardcoding brand values in source.

| File | Responsibility |
|------|---------------|
| `branding.ts` | Brand constants (BINARY_NAME, CHANNEL_*); changes require rebuild via `bun packages/ellamaka-release/src/cli/build.ts` |
| `detect.ts` | WopalSpace auto-detection: walks up from cwd looking for `.wopal/.git` worktree marker |
| `is-wopal-install.ts` | Installation path guard: checks whether `process.execPath` resides under `WOPAL_HOME/bin/` |
| `logo.ts` | ellamaka ASCII logo |
| `test/` | Package-level tests |

> Build/release tooling (branded CLI build, release identity, manifests,
> Gitee releases, cleanup, upstream lock, legacy inventory) moved to
> `../ellamaka-release`. See `../ellamaka-release/AGENTS.md`.

## 3. Development Commands

| Scenario | Command |
|----------|---------|
| Test | `bun test` from `packages/ellamaka-brand` |
| Build | `bun packages/ellamaka-release/src/cli/build.ts --web-ui ellamaka-app` |

## 4. Implementation Rules

- `branding.ts` is the single source of truth for brand constants; all brand value changes go here only.
- `detect.ts` detects WopalSpace by checking whether `.wopal/.git` is a regular file (worktree marker); stops at the home directory or filesystem root.
- `isWopalInstall()` uses the `WOPAL_HOME` environment variable (supports `~/` prefix); path-based check replaces channel-name prefix matching.
- `packages/ellamaka-release/src/cli/build.ts` is the sole build entry point; never run upstream build scripts directly. Build parameters are controlled via `--arch` and `--web-ui`.
- `--web-ui ellamaka-app` embeds the ellamaka Web UI, `--web-ui app` embeds the upstream app baseline, and `--web-ui none` skips Web UI embedding.
- After adding brand constants or changing channel naming, check whether `../../docs/BRANDING.md` needs a corresponding update.

## 5. Testing

- Code changes follow TDD: write a failing test first, then implement to make it pass.
- Run `bun test` from `packages/ellamaka-brand`.
- After modifying `branding.ts`, run `branding.test.ts`; after modifying `detect.ts`, run `detect.test.ts`; after modifying `is-wopal-install.ts`, run `is-wopal-install.test.ts`.

## 6. User-Supplied Rules

(None)
