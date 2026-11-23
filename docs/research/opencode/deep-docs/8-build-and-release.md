Loading...

Index your code with Devin

[DeepWiki](https://deepwiki.com/)

[DeepWiki](https://deepwiki.com/)

[anomalyco/opencode](https://github.com/anomalyco/opencode "Open repository")

Index your code with

Devin

Edit WikiShare

Loading...

Last indexed: 17 March 2026 ([7daea6](https://github.com/anomalyco/opencode/commits/7daea69e)
)

- [Overview](https://deepwiki.com/anomalyco/opencode/1-overview)
- [Repository Structure & Packages](https://deepwiki.com/anomalyco/opencode/1.1-repository-structure-and-packages)
- [Architecture Overview](https://deepwiki.com/anomalyco/opencode/1.2-architecture-overview)
- [Core Application](https://deepwiki.com/anomalyco/opencode/2-core-application)
- [CLI Entrypoint & Commands](https://deepwiki.com/anomalyco/opencode/2.1-cli-entrypoint-and-commands)
- [Configuration System](https://deepwiki.com/anomalyco/opencode/2.2-configuration-system)
- [Session & Agent System](https://deepwiki.com/anomalyco/opencode/2.3-session-and-agent-system)
- [AI Provider & Model Management](https://deepwiki.com/anomalyco/opencode/2.4-ai-provider-and-model-management)
- [Tool System & Permissions](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)
- [HTTP Server & REST API](https://deepwiki.com/anomalyco/opencode/2.6-http-server-and-rest-api)
- [Event Bus & Real-time Updates](https://deepwiki.com/anomalyco/opencode/2.7-event-bus-and-real-time-updates)
- [LSP & Code Formatting](https://deepwiki.com/anomalyco/opencode/2.8-lsp-and-code-formatting)
- [Plugin System](https://deepwiki.com/anomalyco/opencode/2.9-plugin-system)
- [MCP Integration](https://deepwiki.com/anomalyco/opencode/2.10-mcp-integration)
- [Skills & Command System](https://deepwiki.com/anomalyco/opencode/2.11-skills-and-command-system)
- [User Interfaces](https://deepwiki.com/anomalyco/opencode/3-user-interfaces)
- [Terminal User Interface (TUI)](<https://deepwiki.com/anomalyco/opencode/3.1-terminal-user-interface-(tui)>)
- [Web Application](https://deepwiki.com/anomalyco/opencode/3.2-web-application)
- [Desktop Applications](https://deepwiki.com/anomalyco/opencode/3.3-desktop-applications)
- [UI Component Library](https://deepwiki.com/anomalyco/opencode/4-ui-component-library)
- [Component Architecture & Exports](https://deepwiki.com/anomalyco/opencode/4.1-component-architecture-and-exports)
- [Session Turn & Message Rendering](https://deepwiki.com/anomalyco/opencode/4.2-session-turn-and-message-rendering)
- [Styling System & Themes](https://deepwiki.com/anomalyco/opencode/4.3-styling-system-and-themes)
- [SDK & API](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api)
- [JavaScript SDK](https://deepwiki.com/anomalyco/opencode/5.1-javascript-sdk)
- [OpenAPI Specification & Code Generation](https://deepwiki.com/anomalyco/opencode/5.2-openapi-specification-and-code-generation)
- [IDE Extensions & Integrations](https://deepwiki.com/anomalyco/opencode/6-ide-extensions-and-integrations)
- [VS Code Extension](https://deepwiki.com/anomalyco/opencode/6.1-vs-code-extension)
- [Zed Extension](https://deepwiki.com/anomalyco/opencode/6.2-zed-extension)
- [Slack Integration](https://deepwiki.com/anomalyco/opencode/6.3-slack-integration)
- [Console Management System](https://deepwiki.com/anomalyco/opencode/7-console-management-system)
- [Console Architecture](https://deepwiki.com/anomalyco/opencode/7.1-console-architecture)
- [Console Backend](https://deepwiki.com/anomalyco/opencode/7.2-console-backend)
- [Console Frontend](https://deepwiki.com/anomalyco/opencode/7.3-console-frontend)
- [Build & Release](https://deepwiki.com/anomalyco/opencode/8-build-and-release)
- [Release Pipeline](https://deepwiki.com/anomalyco/opencode/8.1-release-pipeline)
- [Nix Builds](https://deepwiki.com/anomalyco/opencode/8.2-nix-builds)
- [Reference](https://deepwiki.com/anomalyco/opencode/9-reference)
- [Providers & Models](https://deepwiki.com/anomalyco/opencode/9.1-providers-and-models)
- [TUI Commands & Keybindings](https://deepwiki.com/anomalyco/opencode/9.2-tui-commands-and-keybindings)
- [Configuration Schema Reference](https://deepwiki.com/anomalyco/opencode/9.3-configuration-schema-reference)

Menu

# Build & Release

Relevant source files

- [.github/actions/setup-bun/action.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/actions/setup-bun/action.yml)
- [.github/actions/setup-git-committer/action.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/actions/setup-git-committer/action.yml)
- [.github/workflows/deploy.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/deploy.yml)
- [.github/workflows/generate.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/generate.yml)
- [.github/workflows/publish-vscode.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish-vscode.yml)
- [.github/workflows/publish.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml)
- [.github/workflows/sign-cli.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/sign-cli.yml)
- [.github/workflows/test.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/test.yml)
- [.github/workflows/typecheck.yml](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/typecheck.yml)
- [package.json](https://github.com/anomalyco/opencode/blob/7daea69e/package.json)
- [packages/opencode/script/build.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts)
- [packages/opencode/script/publish.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts)
- [packages/opencode/src/bun/registry.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/bun/registry.ts)
- [packages/opencode/test/mcp/oauth-browser.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/mcp/oauth-browser.test.ts)
- [packages/script/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/script/package.json)
- [packages/script/src/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/script/src/index.ts)
- [script/format.ts](https://github.com/anomalyco/opencode/blob/7daea69e/script/format.ts)
- [script/generate.ts](https://github.com/anomalyco/opencode/blob/7daea69e/script/generate.ts)
- [script/publish.ts](https://github.com/anomalyco/opencode/blob/7daea69e/script/publish.ts)
- [sdks/vscode/script/publish](https://github.com/anomalyco/opencode/blob/7daea69e/sdks/vscode/script/publish)

This document describes OpenCode's multi-platform build system, CI/CD pipeline, and distribution strategy. The build process produces standalone CLI binaries for 12+ platform variants, desktop applications for 6 platforms (via both Tauri and Electron), and distributes them through 8+ package managers. For information about Nix-specific builds, see [Nix Builds](https://deepwiki.com/anomalyco/opencode/8.2-nix-builds)
. For the complete release pipeline workflow, see [Release Pipeline](https://deepwiki.com/anomalyco/opencode/8.1-release-pipeline)
.

## Overview

OpenCode uses a comprehensive build and release system that targets maximum platform coverage. The system is built around three primary artifacts:

| Artifact Type    | Build Tool       | Platform Count | Distribution                    |
| ---------------- | ---------------- | -------------- | ------------------------------- |
| CLI Binaries     | Bun Compile      | 12 variants    | npm, Homebrew, AUR, Nix, Docker |
| Tauri Desktop    | Tauri CLI + Rust | 6 platforms    | GitHub Releases, auto-update    |
| Electron Desktop | Electron Builder | 6 platforms    | GitHub Releases, auto-update    |

The build system is coordinated through GitHub Actions workflows that run on merge to `ci`, `dev`, `beta`, or `snapshot-*` branches, or via manual workflow dispatch.

**Sources:** [.github/workflows/publish.yml1-448](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L1-L448)
[package.json1-115](https://github.com/anomalyco/opencode/blob/7daea69e/package.json#L1-L115)

## Build System Architecture

### CLI Binary Compilation

The CLI build process uses Bun's `compile` feature to create self-contained executables that bundle the entire OpenCode server and dependencies. The build is orchestrated by [packages/opencode/script/build.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts)

The build targets are defined in the `allTargets` array:

| Platform | Architecture | ABI   | AVX2 | Binary Name                        |
| -------- | ------------ | ----- | ---- | ---------------------------------- |
| Linux    | x64          | glibc | ✓    | `opencode-linux-x64`               |
| Linux    | x64          | glibc | ✗    | `opencode-linux-x64-baseline`      |
| Linux    | arm64        | glibc | \-   | `opencode-linux-arm64`             |
| Linux    | x64          | musl  | ✓    | `opencode-linux-x64-musl`          |
| Linux    | x64          | musl  | ✗    | `opencode-linux-x64-baseline-musl` |
| Linux    | arm64        | musl  | \-   | `opencode-linux-arm64-musl`        |
| macOS    | x64          | \-    | ✓    | `opencode-darwin-x64`              |
| macOS    | x64          | \-    | ✗    | `opencode-darwin-x64-baseline`     |
| macOS    | arm64        | \-    | \-   | `opencode-darwin-arm64`            |
| Windows  | x64          | \-    | ✓    | `opencode-windows-x64`             |
| Windows  | x64          | \-    | ✗    | `opencode-windows-x64-baseline`    |
| Windows  | arm64        | \-    | \-   | `opencode-windows-arm64`           |

Each binary is compiled with platform-specific configuration [packages/opencode/script/build.ts154-228](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts#L154-L228)
:

- **Compile target**: `bun-{os}-{arch}[-baseline][-{abi}]` passed to Bun's compile API
- **Outfile**: `dist/{name}/bin/opencode[.exe]`
- **Exec arguments**: `--user-agent=opencode/{version}`, `--use-system-ca`
- **Define constants**: `OPENCODE_VERSION`, `OPENCODE_MIGRATIONS`, `OPENCODE_CHANNEL`, `OPENCODE_LIBC`
- **Bundled workers**: Parser worker and TUI worker embedded using `$bunfs/root/` virtual path

The build process also generates a models snapshot before compilation [packages/opencode/script/build.ts18-27](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts#L18-L27)
:

**Sources:** [packages/opencode/script/build.ts1-230](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts#L1-L230)
[.github/workflows/publish.yml70-104](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L70-L104)

### Desktop Application Builds

#### Tauri Build Process

Tauri desktop builds use the `tauri-apps/tauri-action` GitHub Action with Rust cross-compilation for native performance. The build matrix covers 6 platform combinations [.github/workflows/publish.yml105-248](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L105-L248)
:

The Tauri build uses a custom action invocation [.github/workflows/publish.yml222-247](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L222-L247)
:

For Linux builds, a custom tauri-cli version is installed from a specific branch to support truly portable AppImages [.github/workflows/publish.yml197-213](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L197-L213)

**Sources:** [.github/workflows/publish.yml105-248](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L105-L248)
[packages/desktop/scripts/prepare.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/scripts/prepare.ts)

#### Electron Build Process

Electron builds use `electron-builder` with similar cross-platform coverage [.github/workflows/publish.yml249-371](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L249-L371)
:

| Platform | Architecture | Build Flag      |
| -------- | ------------ | --------------- |
| macOS    | x64          | `--mac --x64`   |
| macOS    | arm64        | `--mac --arm64` |
| Windows  | x64          | `--win`         |
| Windows  | arm64        | `--win --arm64` |
| Linux    | x64          | `--linux`       |
| Linux    | arm64        | `--linux`       |

The Electron build process [.github/workflows/publish.yml323-365](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L323-L365)
:

1.  **Prepare**: Run `scripts/prepare.ts` to download platform CLI binary
2.  **Build**: Run `bun run build` to compile frontend with Vite
3.  **Package**: Run `electron-builder` with platform flags
4.  **Publish**: Upload to GitHub Releases (if release mode)
5.  **Auto-update metadata**: Generate `latest*.yml` files

Auto-update metadata files are collected separately for final publishing [.github/workflows/publish.yml366-370](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L366-L370)
:

**Sources:** [.github/workflows/publish.yml249-371](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L249-L371)
[packages/desktop-electron/scripts/prepare.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop-electron/scripts/prepare.ts)

## CI/CD Pipeline

### Workflow Structure

The `publish` workflow orchestrates the entire build and release process [.github/workflows/publish.yml1-448](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L1-L448)
:

**Sources:** [.github/workflows/publish.yml33-448](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L33-L448)

### Version Job

The `version` job determines the version number and creates release metadata [.github/workflows/publish.yml34-68](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L34-L68)
:

The job outputs four critical values:

- `version`: The semantic version string (e.g., `1.2.3`)
- `release`: GitHub release ID if creating a release
- `tag`: Git tag name (e.g., `v1.2.3`)
- `repo`: Target repository (normal or beta)

**Sources:** [.github/workflows/publish.yml34-68](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L34-L68)
[script/version.ts](https://github.com/anomalyco/opencode/blob/7daea69e/script/version.ts)
[packages/script/src/index.ts20-76](https://github.com/anomalyco/opencode/blob/7daea69e/packages/script/src/index.ts#L20-L76)

### Build Job Dependencies

Build jobs run in parallel after version is determined, with `publish` depending on all three build jobs completing [.github/workflows/publish.yml372-378](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L372-L378)
:

This ensures all artifacts are available before distribution begins.

**Sources:** [.github/workflows/publish.yml372-448](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L372-L448)

## Distribution Channels

### npm Registry Publishing

The CLI is published to npm as a wrapper package `opencode-ai` with platform-specific optional dependencies [packages/opencode/script/publish.ts1-182](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L1-L182)
:

The wrapper package is constructed [packages/opencode/script/publish.ts23-40](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L23-L40)
:

Each platform package is published with OS and CPU constraints [packages/opencode/script/build.ts203-214](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts#L203-L214)
:

Publishing happens with channel tags [packages/opencode/script/publish.ts42-50](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L42-L50)
:

**Sources:** [packages/opencode/script/publish.ts1-50](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L1-L50)
[packages/opencode/script/build.ts203-216](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts#L203-L216)

### Docker Multi-Architecture Images

Docker images are built for `linux/amd64` and `linux/arm64` using `buildx` [packages/opencode/script/publish.ts52-56](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L52-L56)
:

This creates two tags per release:

- Version-specific: `ghcr.io/anomalyco/opencode:1.2.3`
- Channel-specific: `ghcr.io/anomalyco/opencode:latest`

**Sources:** [packages/opencode/script/publish.ts52-56](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L52-L56)
[.github/workflows/publish.yml384-395](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L384-L395)

### Native Package Managers

#### Homebrew

The Homebrew formula is generated and committed to `anomalyco/homebrew-tap` [packages/opencode/script/publish.ts116-181](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L116-L181)
:

The formula is automatically committed and pushed to the tap repository [packages/opencode/script/publish.ts169-180](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L169-L180)

**Sources:** [packages/opencode/script/publish.ts116-181](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L116-L181)

#### Arch User Repository (AUR)

The AUR package `opencode-bin` uses a PKGBUILD that downloads binaries from GitHub releases [packages/opencode/script/publish.ts68-114](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L68-L114)
:

The PKGBUILD is committed directly to `aur.archlinux.org/opencode-bin.git` using SSH authentication [packages/opencode/script/publish.ts98-113](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L98-L113)

**Sources:** [packages/opencode/script/publish.ts59-114](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/publish.ts#L59-L114)
[.github/workflows/publish.yml420-437](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L420-L437)

## Auto-Update System

Desktop applications support automatic updates through platform-specific metadata files:

### Tauri Updater

Tauri uses `latest.json` manifest files [packages/desktop/scripts/finalize-latest-json.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/scripts/finalize-latest-json.ts)
:

The Tauri action automatically generates this file and uploads it to the release [.github/workflows/publish.yml230-231](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L230-L231)

**Sources:** [.github/workflows/publish.yml222-247](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L222-L247)
[packages/desktop/scripts/finalize-latest-json.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/scripts/finalize-latest-json.ts)

### Electron Updater

Electron uses `latest.yml`, `latest-mac.yml`, and `latest-linux.yml` files:

These files are collected from build artifacts and finalized by [packages/desktop-electron/scripts/finalize-latest-yml.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop-electron/scripts/finalize-latest-yml.ts)
then uploaded to GitHub releases [script/publish.ts70-71](https://github.com/anomalyco/opencode/blob/7daea69e/script/publish.ts#L70-L71)

**Sources:** [.github/workflows/publish.yml366-370](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L366-L370)
[packages/desktop-electron/scripts/finalize-latest-yml.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop-electron/scripts/finalize-latest-yml.ts)
[script/publish.ts70-71](https://github.com/anomalyco/opencode/blob/7daea69e/script/publish.ts#L70-L71)

## Version Management

### Script Utility

The `@opencode-ai/script` package provides version management logic used across all build scripts [packages/script/src/index.ts1-78](https://github.com/anomalyco/opencode/blob/7daea69e/packages/script/src/index.ts#L1-L78)
:

Environment variables control the build:

| Variable           | Purpose               | Example                   |
| ------------------ | --------------------- | ------------------------- |
| `OPENCODE_VERSION` | Override version      | `1.2.3`                   |
| `OPENCODE_BUMP`    | Bump type             | `major`, `minor`, `patch` |
| `OPENCODE_CHANNEL` | Distribution channel  | `latest`, `beta`          |
| `OPENCODE_RELEASE` | Create GitHub release | `true`                    |

**Sources:** [packages/script/src/index.ts20-76](https://github.com/anomalyco/opencode/blob/7daea69e/packages/script/src/index.ts#L20-L76)

### Preview Versions

Preview versions for non-latest channels use timestamp-based identifiers [packages/script/src/index.ts34-36](https://github.com/anomalyco/opencode/blob/7daea69e/packages/script/src/index.ts#L34-L36)
:

This ensures preview builds are always treated as pre-releases and sorted correctly by semver.

**Sources:** [packages/script/src/index.ts26-48](https://github.com/anomalyco/opencode/blob/7daea69e/packages/script/src/index.ts#L26-L48)

### Release Flow

The complete release flow for a production release [script/publish.ts60-74](https://github.com/anomalyco/opencode/blob/7daea69e/script/publish.ts#L60-L74)
:

The root `script/publish.ts` coordinates publishing of multiple packages [script/publish.ts76-84](https://github.com/anomalyco/opencode/blob/7daea69e/script/publish.ts#L76-L84)
:

**Sources:** [script/publish.ts1-87](https://github.com/anomalyco/opencode/blob/7daea69e/script/publish.ts#L1-L87)
[.github/workflows/publish.yml372-448](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L372-L448)

## Build Optimization

### Caching Strategy

The CI pipeline uses multiple caching layers:

| Cache Type        | Key                                   | Scope        | Purpose                   |
| ----------------- | ------------------------------------- | ------------ | ------------------------- |
| Bun dependencies  | `bun-${{ hashFiles('**/bun.lock') }}` | Global       | Node modules cache        |
| Rust dependencies | `rust-${{ matrix.settings.target }}`  | Per-platform | Cargo cache for Tauri     |
| APT packages      | `apt-${{ matrix.settings.target }}`   | Per-platform | Linux system dependencies |

**Sources:** [.github/actions/setup-bun/action.yml26-37](https://github.com/anomalyco/opencode/blob/7daea69e/.github/actions/setup-bun/action.yml#L26-L37)
[.github/workflows/publish.yml159-174](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L159-L174)
[.github/workflows/publish.yml299-314](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L299-L314)

### Parallel Execution

Build jobs run in parallel using matrix strategies:

- **CLI**: Single job, sequential builds for 12 platforms
- **Tauri**: 6 parallel jobs (one per platform)
- **Electron**: 6 parallel jobs (one per platform)

This reduces total build time from ~2 hours sequential to ~30 minutes parallel.

**Sources:** [.github/workflows/publish.yml105-127](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L105-L127)
[.github/workflows/publish.yml254-277](https://github.com/anomalyco/opencode/blob/7daea69e/.github/workflows/publish.yml#L254-L277)

### Baseline Binary Strategy

For x64 platforms, both baseline (no AVX2) and optimized binaries are built [packages/opencode/script/build.ts63-124](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts#L63-L124)
:

The baseline builds ensure compatibility with older CPUs while optimized builds provide better performance on modern hardware.

**Sources:** [packages/opencode/script/build.ts63-145](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/build.ts#L63-L145)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [Build & Release](https://deepwiki.com/anomalyco/opencode/8-build-and-release#build-release)
- [Overview](https://deepwiki.com/anomalyco/opencode/8-build-and-release#overview)
- [Build System Architecture](https://deepwiki.com/anomalyco/opencode/8-build-and-release#build-system-architecture)
- [CLI Binary Compilation](https://deepwiki.com/anomalyco/opencode/8-build-and-release#cli-binary-compilation)
- [Desktop Application Builds](https://deepwiki.com/anomalyco/opencode/8-build-and-release#desktop-application-builds)
- [Tauri Build Process](https://deepwiki.com/anomalyco/opencode/8-build-and-release#tauri-build-process)
- [Electron Build Process](https://deepwiki.com/anomalyco/opencode/8-build-and-release#electron-build-process)
- [CI/CD Pipeline](https://deepwiki.com/anomalyco/opencode/8-build-and-release#cicd-pipeline)
- [Workflow Structure](https://deepwiki.com/anomalyco/opencode/8-build-and-release#workflow-structure)
- [Version Job](https://deepwiki.com/anomalyco/opencode/8-build-and-release#version-job)
- [Build Job Dependencies](https://deepwiki.com/anomalyco/opencode/8-build-and-release#build-job-dependencies)
- [Distribution Channels](https://deepwiki.com/anomalyco/opencode/8-build-and-release#distribution-channels)
- [npm Registry Publishing](https://deepwiki.com/anomalyco/opencode/8-build-and-release#npm-registry-publishing)
- [Docker Multi-Architecture Images](https://deepwiki.com/anomalyco/opencode/8-build-and-release#docker-multi-architecture-images)
- [Native Package Managers](https://deepwiki.com/anomalyco/opencode/8-build-and-release#native-package-managers)
- [Homebrew](https://deepwiki.com/anomalyco/opencode/8-build-and-release#homebrew)
- [Arch User Repository (AUR)](https://deepwiki.com/anomalyco/opencode/8-build-and-release#arch-user-repository-aur)
- [Auto-Update System](https://deepwiki.com/anomalyco/opencode/8-build-and-release#auto-update-system)
- [Tauri Updater](https://deepwiki.com/anomalyco/opencode/8-build-and-release#tauri-updater)
- [Electron Updater](https://deepwiki.com/anomalyco/opencode/8-build-and-release#electron-updater)
- [Version Management](https://deepwiki.com/anomalyco/opencode/8-build-and-release#version-management)
- [Script Utility](https://deepwiki.com/anomalyco/opencode/8-build-and-release#script-utility)
- [Preview Versions](https://deepwiki.com/anomalyco/opencode/8-build-and-release#preview-versions)
- [Release Flow](https://deepwiki.com/anomalyco/opencode/8-build-and-release#release-flow)
- [Build Optimization](https://deepwiki.com/anomalyco/opencode/8-build-and-release#build-optimization)
- [Caching Strategy](https://deepwiki.com/anomalyco/opencode/8-build-and-release#caching-strategy)
- [Parallel Execution](https://deepwiki.com/anomalyco/opencode/8-build-and-release#parallel-execution)
- [Baseline Binary Strategy](https://deepwiki.com/anomalyco/opencode/8-build-and-release#baseline-binary-strategy)
