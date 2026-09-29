import { Context, Effect, Layer, Scope } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { Tool } from "@/tool/tool"

/**
 * Pipeline file-operation event. The pipeline publishes this after a tool has
 * executed successfully; observers decide what to do from `toolId` / `args` /
 * `filePaths` alone. Write-class events allow the observer to augment
 * `result` (diagnostic backfill); the pipeline emits before building the final
 * tool output, so augmentations flow into it.
 */
export interface FileOpEvent {
  /** Executed tool id, e.g. "read", "write", "edit", "apply_patch", "str_replace_editor" */
  toolId: string
  /** Raw tool-call arguments (observers read operation semantics from these, e.g. str_replace_editor's command) */
  args: Readonly<Record<string, unknown>>
  /** Touched file paths (the pipeline extracts these; empty array when none apply) */
  filePaths: readonly string[]
  /** Tool execution result (Tool.ExecuteResult) */
  result: Tool.ExecuteResult
  /** Session id */
  sessionID: string
}

/**
 * Internal hook observer. Each observer subscribes to the events it cares
 * about.
 */
export interface InternalHookObserver {
  /** Observer id (used for deduplication and logging) */
  readonly id: string
  /**
   * Handle a file-operation event. The returned Effect is scheduled by the
   * registry:
   * - The observer itself decides whether to fork (non-blocking) or to `yield*`
   *   directly (blocking).
   * - `emit()` awaits every observer's returned Effect.
   * - Write-class operations may augment `event.result` (append diagnostics to
   *   `output` / `metadata`; apply_patch keeps `title` equal to `output` after
   *   backfill). The pipeline calls `emit` before building the final tool
   *   output, so the augmentation flows into it. Read-class operations must
   *   not modify `result`.
   *
   * Observers receive the registry's own long-lived scope, so fire-and-forget
   * work (e.g. LSP warm-up) survives the tool call that triggered it.
   */
  onFileOp(event: FileOpEvent): Effect.Effect<void, never, Scope.Scope>
}

/**
 * Internal hook registry service. The pipeline yields this service and calls
 * `emit(event)`; it imports no observer module.
 */
export interface Interface {
  /** Register an observer (idempotent; the same id is never registered twice) */
  readonly register: (observer: InternalHookObserver) => Effect.Effect<void>
  /** Publish a file-operation event to every registered observer */
  readonly emit: (event: FileOpEvent) => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InternalHook") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // The registry's own scope: observers fork fire-and-forget work into it,
    // so it outlives the emit call (and the request that triggered it).
    const scope = yield* Scope.Scope

    // Per-instance registries: config (and therefore which observers are
    // registered) is resolved per instance directory.
    const state = yield* InstanceState.make<Map<string, InternalHookObserver>>(
      Effect.fn("InternalHook.state")(function* () {
        return new Map<string, InternalHookObserver>()
      }),
    )

    const register = Effect.fn("InternalHook.register")(function* (observer: InternalHookObserver) {
      const observers = yield* InstanceState.get(state)
      if (observers.has(observer.id)) return
      observers.set(observer.id, observer)
    })

    const emit = Effect.fn("InternalHook.emit")(function* (event: FileOpEvent) {
      const observers = yield* InstanceState.get(state)
      yield* Effect.forEach(
        Array.from(observers.values()),
        (observer) => observer.onFileOp(event).pipe(Effect.provideService(Scope.Scope, scope)),
        { discard: true },
      )
    })

    return Service.of({ register, emit })
  }),
)

export const defaultLayer = layer

export * as InternalHook from "./internal-hook"
