/**
 * The install-command contract: the ONE place that answers "how does this host
 * re-launch `<ellamaka> dsh plugin …` for the market?"
 *
 * The market (`dshmarket`) performs every install, remove and update by
 * spawning a child — `<command> dsh plugin --profile <p> <verb> <args>` — via
 * the `desktopPnpm.runPlugin` service this host injects. The command's shape is
 * therefore a cross-process contract, and getting it wrong is silent: the mount
 * succeeds, and the failure surfaces much later as a yargs usage dump from the
 * child that the market reports as "install failed".
 *
 * Three hosts need this answer, each with a different runtime:
 *
 * - the compiled CLI binary (`ellamaka serve` / `ellamaka web`): the running
 *   executable IS the CLI, so the command is the executable alone;
 * - a bun source launch (`dev.sh` runs `bun …/src/index.ts serve`): the
 *   executable is bun, so the CLI entry must ride along as a prefix arg;
 * - the Desktop sidecar (Electron `utilityProcess.fork`, a Node host): neither
 *   `process.execPath` (Electron's helper) nor `argv[1]` (the sidecar bundle)
 *   can run `dsh plugin`, so the launcher comes from configuration or from the
 *   engine binary the installer lays down.
 *
 * Runtime features are NOT a usable discriminator. A `bun build --compile`
 * product still reports `process.versions.bun` and still carries a Bun-shaped
 * argv — measured 2026-09-10: `["bun", "/$bunfs/root/<name>", …]` — while its
 * `execPath` is the real, runnable CLI. Probing "is this bun?" therefore
 * mistook the compiled binary for a source launch and forwarded Bun's virtual
 * bundle path as a prefix arg; the child then read it as a positional and died
 * (see the module's test file for the pinned shapes). The Bun virtual bundle
 * path is the actual fingerprint of a compiled product, so that is what this
 * module keys on.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Prefixes of Bun's in-memory virtual filesystem for compiled executables.
 * Everything under them exists only inside a running bunfs, never on disk and
 * never as a path a child process could open — so a command part carrying one
 * is always a mistake. The build scripts already name the same two roots when
 * they bake `OTUI_TREE_SITTER_WORKER_PATH` (`packages/opencode/script/build.ts`,
 * `packages/ellamaka-release/src/cli/build.ts`).
 */
const BUNFS_ROOTS = ["/$bunfs/root/", "B:/~BUN/root/"] as const

/**
 * Environment variable carrying an authoritative launcher for hosts whose own
 * process cannot name one. Whitespace-separated, so `bun /path/to/index.ts`
 * expresses the source-launch shape; `dev.sh` sets it for the Desktop app.
 */
export const INSTALL_COMMAND_ENV = "ELLAMAKA_DSH_INSTALL_COMMAND"

/**
 * The facts a host must supply to resolve its own launcher. Every field is
 * injectable so tests exercise the real decision table without spawning
 * anything or mutating the ambient process.
 */
export interface InstallCommandProbe {
  /** `process.argv` verbatim (index 1 is the entry under a bun runtime). */
  argv: readonly string[]
  /** `process.execPath` — the executable that is actually running. */
  execPath: string
  /** True under a Bun runtime (`process.versions.bun !== undefined`). */
  isBun: boolean
  /** Environment to read the override and `WOPAL_HOME` from. */
  env: Record<string, string | undefined>
  /**
   * Whether this host may fall back to the engine binary under
   * `<WOPAL_HOME>/bin`. A host whose own process can name a launcher keeps
   * `false`: consulting the filesystem would let a stale binary left by an
   * older install win over the one actually running. The Desktop sidecar sets
   * `true`, because its own process can name nothing runnable.
   */
  allowEngineFallback?: boolean
}

/** True when a command part is a Bun virtual-bundle path rather than a real one. */
export function isBunfsPath(value: string): boolean {
  return BUNFS_ROOTS.some((root) => value.startsWith(root))
}

/**
 * The engine binary the installer lays down under the WOPAL_HOME bin
 * directory — the launcher available to a host whose own process is not the
 * CLI. `wopalHome` is read from the supplied env so a packaged app with a
 * custom home resolves against its own, and a missing value falls back to the
 * conventional `~/.wopal`.
 */
function engineBinaryPath(env: Record<string, string | undefined>): string {
  const home = env.WOPAL_HOME ?? join(homedir(), ".wopal")
  return join(home, "bin", process.platform === "win32" ? "ellamaka.exe" : "ellamaka")
}

/**
 * Resolve the launcher for the `dsh plugin` surface.
 *
 * Order, most authoritative first:
 * 1. `ELLAMAKA_DSH_INSTALL_COMMAND` — an explicit launcher wins over anything
 *    inferred, so a custom deployment never needs a code change.
 * 2. `<WOPAL_HOME>/bin/ellamaka`, for a caller that sets `allowEngineFallback`.
 *    That flag means "this process cannot name a runnable launcher", so it is
 *    answered before any argv inference: the host may be a bundler's runtime
 *    executing a desktop bundle (a test runner is the everyday case), whose
 *    argv describes the RUNNER, not the CLI that should be re-launched.
 * 3. A Bun virtual-bundle argv entry — a compiled product; `execPath` IS the CLI.
 * 4. A bun runtime whose argv[1] is a real path — a source launch; bun needs the
 *    entry as a prefix arg.
 * 5. Any other host — `execPath` is the runnable host.
 *
 * Returns `undefined` when nothing usable exists, which the caller reports as
 * "no install worker" rather than spawning a command that cannot work.
 */
export function resolveInstallCommand(probe: InstallCommandProbe): string[] | undefined {
  const override = probe.env[INSTALL_COMMAND_ENV]
  if (override !== undefined && override.trim().length > 0) {
    return override.trim().split(/\s+/)
  }

  // A host that must ask the filesystem is one whose own argv cannot name the
  // CLI, so nothing below may be inferred from it.
  if (probe.allowEngineFallback) {
    const engine = engineBinaryPath(probe.env)
    return existsSync(engine) ? [engine] : undefined
  }

  const entry = probe.argv[1]

  // A compiled product: execPath is the CLI and argv[1] is bunfs noise that
  // must never be forwarded (a child would treat it as a positional).
  if (entry !== undefined && isBunfsPath(entry)) {
    return [probe.execPath]
  }

  // A source launch: bun runs the CLI entry the host was started from.
  if (probe.isBun && entry !== undefined && entry.length > 0) {
    return [probe.execPath, entry]
  }

  // Any other host: its own executable is the runnable CLI.
  return [probe.execPath]
}
