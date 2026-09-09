import type { Argv } from "yargs"
import { Cause, Effect, Schema } from "effect"
import { AppRuntime, type AppServices } from "@/effect/app-runtime"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { cmd, type WithDoubleDash } from "./cmd/cmd"

/**
 * User-visible command failure. Throw via `fail("...")` from an effectCmd handler
 * to surface a printed message + non-zero exit. Recognised by the global error
 * formatter in `src/cli/error.ts` (FormatError), so the existing top-level
 * catch + cleanup in `src/index.ts` runs normally.
 */
export class CliError extends Schema.TaggedErrorClass<CliError>()("CliError", {
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number),
}) {}

export const fail = (message: string, exitCode = 1) => Effect.fail(new CliError({ message, exitCode }))

interface EffectCmdOpts<Args, A> {
  command: string | readonly string[]
  aliases?: string | readonly string[]
  describe: string | false
  builder?: (yargs: Argv) => Argv<Args>
  /**
   * Whether the command needs a project InstanceContext. Defaults to true.
   *
   * `true` (default): wraps the handler in `InstanceStore.Service.provide({directory})`
   * so `InstanceRef` resolves to a loaded `InstanceContext`. Auto-disposes via
   * `Effect.ensuring(store.dispose(ctx))` on every Exit (matches the legacy
   * `bootstrap()` finally-disposal). Runs InstanceBootstrap (config + plugin
   * init + LSP/File/etc forks) eagerly.
   *
   * `false`: skip the instance entirely. Saves the InstanceBootstrap work and
   * suppresses the `server.instance.disposed` IPC event. The handler runs
   * directly under AppRuntime — it can yield any `AppServices` but must not
   * yield `InstanceRef` (it'd be undefined, causing a defect).
   *
   * Function form: `(args) => boolean` decides per-invocation. Useful for
   * commands like `run --attach <url>` where one flag flips between local
   * (needs instance) and remote (doesn't).
   *
   * Use `false` for commands that don't read project state (e.g. `models`,
   * `serve`, `web`, `account`, `db`, `upgrade`).
   */
  instance?: boolean | ((args: Args) => boolean)
  /**
   * Run the handler WITHOUT constructing the AppLayer runtime at all. Only
   * meaningful together with `instance: false`; takes precedence over it.
   *
   * The handler receives plain yargs args (no Effect context, no services —
   * not even AppRuntime), so it must be a pure local operation: file/disk
   * work, stdout/stderr writes, process exit. `CliError` failures still flow
   * through the global FormatError path in `src/cli/error.ts` (message +
   * exit code), identical to the AppRuntime path.
   *
   * Commands documented as engine-free shims (e.g. the `dsh` group, which
   * only reads/writes profile composition files) MUST use this — routing
   * them through AppRuntime would boot the whole engine (DB migrations,
   * models.dev fetch, provider layer) just to read one JSON file.
   */
  light?: boolean
  /** Defaults to process.cwd(). Override for commands that take a directory positional. */
  directory?: (args: Args) => string
  handler: (args: WithDoubleDash<Args>) => Effect.Effect<A, CliError, AppServices | InstanceStore.Service>
}

/**
 * Effect-native CLI command builder. Wraps yargs `cmd()` so the handler body is
 * an `Effect` with `InstanceRef` provided and any `AppServices` yieldable.
 *
 * The handler is wrapped in `Effect.ensuring(store.dispose(ctx))` so the loaded
 * InstanceContext is disposed (runDisposers + IPC `server.instance.disposed`)
 * on every Exit — success, typed failure, defect, or interruption. Matches the
 * legacy `bootstrap()` finally-disposal semantics without per-handler boilerplate.
 *
 * Errors propagate to the existing top-level handler in `src/index.ts`; use
 * `fail("...")` for user-visible domain failures (clean exit, formatted message).
 *
 * Handlers are typically `Effect.fn("Cli.<name>")(function*(args) { ... })`,
 * which adds a named tracing span per CLI invocation. Once all commands use
 * `effectCmd`, swapping the underlying `cmd()` factory for effect/cli's
 * `Command.make(...)` won't touch any handler bodies.
 */
/**
 * Run an Effect on AppRuntime with a process signal bridge.
 *
 * Unlike a bare `runPromise`, SIGINT/SIGTERM interrupt the running fiber, so
 * long-lived commands (serve, web) unwind through their `Effect.ensuring`
 * finalizers (server close, container dispose) and the process exits promptly
 * on the first Ctrl-C. Signal listeners are removed when the fiber settles,
 * so short-lived commands keep their default signal behaviour.
 *
 * Interrupted runs resolve with the received signal name instead of throwing,
 * matching how CLI shutdown is a normal exit path rather than a failure.
 */
async function runWithSignalBridge<A, E>(
  effect: Effect.Effect<A, E, AppServices | InstanceStore.Service>,
): Promise<A | E | "SIGINT" | "SIGTERM"> {
  return await new Promise((resolve, reject) => {
    const fiber = AppRuntime.runFork(effect)
    const signals = ["SIGINT", "SIGTERM"] as const
    const onSignal = (signal: NodeJS.Signals) => {
      // Fire the interrupt only; the observer below resolves once the fiber
      // has fully unwound (finalizers included), so callers never exit while
      // dispose work is still in flight.
      fiber.interruptUnsafe()
      void signal
    }
    for (const signal of signals) process.on(signal, onSignal)
    fiber.addObserver((exit) => {
      for (const signal of signals) process.off(signal, onSignal)
      if (exit._tag === "Success") resolve(exit.value)
      else if (Cause.hasInterruptsOnly(exit.cause)) resolve("SIGINT")
      else reject(Cause.squash(exit.cause))
    })
  })
}

export const effectCmd = <Args, A>(opts: EffectCmdOpts<Args, A>) =>
  cmd<{}, Args>({
    command: opts.command,
    aliases: opts.aliases,
    describe: opts.describe,
    builder: opts.builder as never,
    async handler(rawArgs) {
      // yargs typing wraps Args in ArgumentsCamelCase<WithDoubleDash<...>>; cast at the boundary.
      const args = rawArgs as unknown as WithDoubleDash<Args>
      if (opts.light) {
        // No AppRuntime construction at all: run the effect on a bare runtime
        // with no services beyond what the handler's own imports provide.
        // CliError rejection still reaches the top-level formatter in index.ts.
        await Effect.runPromise(opts.handler(args) as Effect.Effect<A, CliError>)
        return
      }
      const useInstance = typeof opts.instance === "function" ? opts.instance(args) : opts.instance !== false
      if (!useInstance) {
        await runWithSignalBridge(opts.handler(args))
        return
      }
      const directory = opts.directory?.(args) ?? process.cwd()
      const { store, ctx } = await AppRuntime.runPromise(
        InstanceStore.Service.use((store) => store.load({ directory }).pipe(Effect.map((ctx) => ({ store, ctx })))),
      )
      try {
        await runWithSignalBridge(opts.handler(args).pipe(Effect.provideService(InstanceRef, ctx)))
      } finally {
        await AppRuntime.runPromise(store.dispose(ctx))
      }
    },
  })
