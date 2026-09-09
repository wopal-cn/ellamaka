/**
 * The dsh-market install-worker contract for a host that cannot spawn the
 * official `dsh` CLI from its own argv (A3: dshmarket接入).
 *
 * The market (`@deepseek-ai/dsh-market` upstream `apply()`) probes the cordis
 * context for two services before choosing an install path:
 *
 * - when `desktopProfiles` is undefined it spawns the host CLI it infers from
 *   `process.argv[1]` (the official `dsh` launcher only);
 * - when `desktopProfiles` IS present it enters the Desktop branch and calls
 *   the injected `desktopPnpm.runPlugin(args, invokingDir, signal)` instead of
 *   spawning anything itself. That branch is the official extension point for
 *   hosts that do not present as the official launcher — which is exactly the
 *   ellamaka position, since its plugin command lives under the `dsh` group
 *   (`ellamaka dsh plugin`, Plan 223 D-02) and its binary name carries no
 *   `dsh`.
 *
 * This module supplies both services. `desktopPnpm.runPlugin` spawns a fresh
 * `ellamaka dsh plugin --profile <p> <verb> <args>` child process (via the
 * mount-assembler-supplied {@link CreateDesktopWorkerOptions.ellamakaCommand})
 * and returns the streaming handle the market's `createDesktopPluginRuntime`
 * consumes (`dsh-cli.ts` upstream): `{ stdout, stderr, done, cancel }`.
 * Process-level isolation means a crash or cancel of the install child never
 * disturbs the running engine. `ellamaka dsh plugin` owns the official end
 * state (profile manifest + `node_modules/` entity) and the running server
 * hot-replays it (A2) — this worker never touches containers directly.
 *
 * The market mutates the arg shape for its own pnpm expectations before the
 * call arrives (`preparePluginArgs`, pnpm-compat): mutating commands gain a
 * trailing `--reporter=ndjson`, workspace roots gain a `-w`, and route-level
 * flags (`--force`, `--no-frozen-lockfile`, `--config.*`, release-age) may
 * appear before or after the verb. None of those belong to the ellamaka
 * surface — the installer consumes them, not the CLI — so `runPlugin` strips
 * the known pnpm-only flags at every position and forwards the clean verbatim
 * remainder.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { PassThrough } from "node:stream"
import { join } from "node:path"

/** The official-order dsh plugin command prefix the worker re-launches. */
const DSH_GROUP = "dsh"

/**
 * Flags that are pnpm's own and never reach the ellamaka surface. Matched as
 * a prefix so `--config.<anything>=<value>` and `--reporter=<mode>` are both
 * covered; the bare forms (`--force`, `--no-frozen-lockfile`) and the short
 * workspace flag (`-w`) match exactly.
 */
function isPnpmOnlyArg(arg: string): boolean {
  if (arg === "-w" || arg === "--force" || arg === "--no-frozen-lockfile") return true
  return arg.startsWith("--config.") || arg.startsWith("--reporter")
}

/** The shape of `desktopProfiles.current` the market reads. */
export interface DesktopProfileCurrent {
  readonly name: string
  readonly dir: string
}

/** The streaming handle contract the market consumes (upstream DesktopPnpmHandleLike). */
export interface DesktopPnpmHandle {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly done: Promise<{
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
  }>
  cancel(): void
}

/** The injectable install-worker service (upstream DesktopPnpmLike subset). */
export interface DesktopPnpmService {
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandle
}

/** The two services the market probes before choosing its install path. */
export interface DesktopWorkerServices {
  readonly desktopProfiles: {
    readonly current: DesktopProfileCurrent
  }
  readonly desktopPnpm: DesktopPnpmService
}

export interface CreateDesktopWorkerOptions {
  /**
   * Full launch command for the ellamaka `dsh plugin` surface: the executable
   * followed by any prefix args needed to reach the CLI entry. Production
   * passes `[process.execPath]` (the compiled binary IS the CLI); bun dev
   * passes `[bun, <opencode src/index.ts>]`. Composed by the mount assembler
   * (dsh-mount.ts), which alone knows the runtime mode.
   */
  ellamakaCommand: readonly string[]
  /** The territory root whose `home/profiles/<profile>` owns the install. */
  dshRoot: string
  /** Profile name the installs target (default `web`). */
  profile?: string
}

/**
 * Build the market's two install-worker services. The worker spawns
 * `<command> dsh plugin --profile <profile> <verb> <cleanArgs>` under the
 * profile directory, owns the child's process group (so cancel kills the whole
 * spawn tree), and streams its stdio back as the market's expected handle.
 */
export function createDesktopWorker(options: CreateDesktopWorkerOptions): DesktopWorkerServices {
  const profileName = options.profile ?? "web"
  const profileDir = join(options.dshRoot, "home", "profiles", profileName)
  const command = options.ellamakaCommand

  const runPlugin: DesktopPnpmService["runPlugin"] = (rawArgs, invokingDir, signal) => {
    // Strip the pnpm-only flags the market injects at any position; the rest
    // (verb + operands) is forwarded verbatim to the ellamaka surface.
    const args = rawArgs.filter((arg) => !isPnpmOnlyArg(arg))

    const bin = command[0]
    const prefixArgs = command.slice(1)
    const cleanArgs = [...prefixArgs, DSH_GROUP, "plugin", "--profile", profileName, ...args]
    const child = spawn(bin, cleanArgs, {
      cwd: invokingDir,
      // Own process group so cancel/timeout can signal the whole tree.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    // Route the child's stdio through PassThrough buffers so the handle keeps
    // emitting readable data even for the never-launched (ENOENT) case, where
    // the raw child streams close without data.
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    child.stdout?.pipe(stdout)
    child.stderr?.pipe(stderr)

    let settled = false
    const cancel = (): void => {
      if (settled || child.pid === undefined) return
      if (process.platform === "win32") {
        child.kill()
      } else {
        try {
          process.kill(-child.pid, "SIGTERM")
        } catch {
          child.kill("SIGTERM")
        }
      }
    }
    const onAbort = (): void => cancel()
    signal?.addEventListener("abort", onAbort, { once: true })

    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("error", (error) => {
          // A binary that never launched (ENOENT) surfaces here. Mirror the
          // market's exit-127 contract and carry the locating detail on stderr.
          settled = true
          signal?.removeEventListener("abort", onAbort)
          stderr.write(`ellamaka binary failed to start: ${error.message}
`)
          stderr.end()
          stdout.end()
          resolve({ exitCode: 127, signal: null })
        })
        child.on("close", (code, sig) => {
          settled = true
          signal?.removeEventListener("abort", onAbort)
          stdout.end()
          stderr.end()
          resolve({ exitCode: code, signal: sig ?? null })
        })
      },
    )

    return { stdout, stderr, done, cancel }
  }

  return {
    desktopProfiles: {
      current: { name: profileName, dir: profileDir },
    },
    desktopPnpm: { runPlugin },
  }
}
