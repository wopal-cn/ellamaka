import path from "path"
import { Context, Effect, Layer, Scope } from "effect"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { InternalHook } from "@/hook/internal-hook"
import type { InstanceContext } from "@/project/instance-context"
import type { LSPClient } from "./client"
import { LSP } from "./lsp"

const OBSERVER_ID = "lsp"
const MAX_PROJECT_DIAGNOSTICS_FILES = 5

type OpKind = "read" | "write" | "none"

/**
 * Classify the operation semantics of an event. `str_replace_editor` is a DSH
 * projected tool: its `command` decides between a view (read class) and an
 * edit (write class).
 */
function classify(event: InternalHook.FileOpEvent): OpKind {
  switch (event.toolId) {
    case "read":
      return "read"
    case "str_replace_editor":
      return event.args["command"] === "view" ? "read" : "write"
    case "write":
    case "edit":
    case "apply_patch":
      return "write"
    default:
      return "none"
  }
}

/** Resolve a possibly-relative path against the instance directory (as the tools did). */
function resolvePath(directory: string, file: string): string {
  const resolved = path.isAbsolute(file) ? file : path.resolve(directory, file)
  return process.platform === "win32" ? AppFileSystem.normalizePath(resolved) : resolved
}

/**
 * Backfill write-class results with LSP diagnostics, mirroring the behavior the
 * four tools previously implemented inline:
 * - write: this-file block first, then up to `MAX_PROJECT_DIAGNOSTICS_FILES`
 *   other files with errors;
 * - edit / str_replace_editor: this-file block only;
 * - apply_patch: one block per touched file, and `title` stays equal to
 *   `output`.
 * Diagnostics are appended after output truncation (they never participate in
 * truncation and never land in `outputPath`); the full diagnostics map always
 * lands in `metadata.diagnostics`.
 */
function backfill(
  event: InternalHook.FileOpEvent,
  diagnostics: Record<string, LSPClient.Diagnostic[]>,
  targets: readonly string[],
  instance: InstanceContext,
): void {
  switch (event.toolId) {
    case "write": {
      const filepath = targets[0]
      let output = event.result.output
      const normalizedFilepath = AppFileSystem.normalizePath(filepath)
      let projectDiagnosticsCount = 0
      for (const [file, issues] of Object.entries(diagnostics)) {
        const current = file === normalizedFilepath
        if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
        const report = LSP.Diagnostic.report(current ? filepath : file, issues)
        if (!report) continue
        if (current) {
          output += `\n\nLSP errors detected in this file, please fix:\n${report}`
          continue
        }
        projectDiagnosticsCount++
        output += `\n\nLSP errors detected in other files:\n${report}`
      }
      event.result.output = output
      event.result.metadata = { ...event.result.metadata, diagnostics }
      return
    }
    case "edit":
    case "str_replace_editor": {
      const filePath = targets[0]
      let output = event.result.output
      const report = LSP.Diagnostic.report(filePath, diagnostics[AppFileSystem.normalizePath(filePath)] ?? [])
      if (report) output += `\n\nLSP errors detected in this file, please fix:\n${report}`
      event.result.output = output
      event.result.metadata = { ...event.result.metadata, diagnostics }
      return
    }
    case "apply_patch": {
      let output = event.result.output
      for (const target of targets) {
        const report = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!report) continue
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${report}`
      }
      event.result.output = output
      event.result.title = output
      event.result.metadata = { ...event.result.metadata, diagnostics }
      return
    }
  }
}

const handleFileOp = (lsp: LSP.Interface, event: InternalHook.FileOpEvent) =>
  Effect.gen(function* () {
    if (event.filePaths.length === 0) return
    const kind = classify(event)
    if (kind === "none") return

    const instance = yield* InstanceState.context
    const targets = event.filePaths.map((file) => resolvePath(instance.directory, file))

    if (kind === "read") {
      // Read class: warm the file without blocking the tool call.
      const scope = yield* Scope.Scope
      yield* Effect.forEach(targets, (target) => lsp.touchFile(target).pipe(Effect.ignore, Effect.forkIn(scope)), {
        discard: true,
      })
      return
    }

    // Write class: block on document diagnostics, then backfill the result.
    for (const target of targets) {
      yield* lsp.touchFile(target, "document")
    }
    const diagnostics = yield* lsp.diagnostics()
    backfill(event, diagnostics, targets, instance)
  })

/** Build the LSP observer for one LSP service instance. */
export function observer(lsp: LSP.Interface): InternalHook.InternalHookObserver {
  return {
    id: OBSERVER_ID,
    onFileOp: (event) => handleFileOp(lsp, event),
  }
}

export interface Interface {
  /** Materialize the observer registration for the current instance. */
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSPObserver") {}

export const layer: Layer.Layer<Service, never, InternalHook.Service | LSP.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hook = yield* InternalHook.Service
    const lsp = yield* LSP.Service
    const config = yield* Config.Service

    // The `lsp` switch is resolved from the merged config, which is per
    // instance; registration is lazy and memoized per instance directory.
    const state = yield* InstanceState.make<void>(
      Effect.fn("LSPObserver.state")(function* () {
        const cfg = yield* config.get()
        if (!cfg.lsp) return
        yield* hook.register(observer(lsp))
      }),
    )

    const init = Effect.fn("LSPObserver.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(InternalHook.defaultLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as LSPObserver from "./lsp-observer"
