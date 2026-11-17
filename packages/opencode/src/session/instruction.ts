import path from "path"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@wopal/ellamaka-core/global"
import { AbortedError, type MessageV2 } from "./message-v2"

const files = (disableClaudeCodePrompt: boolean) => [
  "AGENTS.md",
  ...(disableClaudeCodePrompt ? [] : ["CLAUDE.md"]),
  "CONTEXT.md", // deprecated
]

export type ResolutionStatus = "none" | "attach" | "visible" | "mixed" | "error"

export interface DirectoryInstruction {
  readonly filepath: string
  readonly content: string
  readonly formatted: string
  readonly reminder: string
  readonly state: "attach" | "visible"
}

export interface DirectoryInstructionError {
  readonly filepath: string
  readonly message: string
}

export interface Resolution {
  readonly target: string
  readonly files: DirectoryInstruction[]
  readonly attach: DirectoryInstruction[]
  readonly visible: string[]
  readonly errors: DirectoryInstructionError[]
  readonly status: ResolutionStatus
}

export interface VisibilityText {
  readonly text: string
  readonly loaded: readonly string[]
}

export interface BaselineStatus {
  readonly loaded: readonly string[]
  readonly errors: readonly DirectoryInstructionError[]
}

export interface SystemInstructions {
  readonly text: string[]
  readonly baseline: BaselineStatus
}

export interface Visibility {
  readonly text: readonly (string | VisibilityText)[]
  readonly baseline?: BaselineStatus
}

export interface VisibilityOptions {
  readonly toolOutputMaxChars?: number
  readonly baseline?: BaselineStatus
}

export type InspectOperation = "read" | "modify"

export interface InspectInput {
  readonly filepath: string
  readonly directory?: string
  readonly messages?: MessageV2.WithParts[]
  readonly visibility?: Visibility
  readonly toolOutputMaxChars?: number
  // Reads may return their own rule file; modifications must check it first.
  readonly operation?: InspectOperation
}

function loadedPaths(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.["loaded"]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function visibleText(messages: MessageV2.WithParts[], options: VisibilityOptions = {}) {
  const text: VisibilityText[] = []
  const output = (value: string) => {
    if (!options.toolOutputMaxChars || value.length <= options.toolOutputMaxChars) return value
    return value.slice(0, options.toolOutputMaxChars)
  }
  const push = (value: string, metadata: Record<string, unknown> | undefined) => {
    if (value === "") return
    const loaded = loadedPaths(metadata)
    if (loaded.length > 0) text.push({ text: value, loaded })
  }

  for (const message of messages) {
    if (message.info.role === "user") {
      for (const part of message.parts) {
        if (part.type !== "text" || part.ignored) continue
        push(part.text, part.metadata)
      }
      continue
    }

    if (
      message.info.error &&
      !(
        AbortedError.isInstance(message.info.error) &&
        message.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
      )
    )
      continue
    for (const part of message.parts) {
      if (part.type === "text") {
        push(part.text, part.metadata)
        continue
      }
      if (part.type !== "tool") continue
      if (part.state.status === "completed") {
        if (part.state.time.compacted) continue
        push(output(part.state.output), part.state.metadata)
        continue
      }
      if (
        part.state.status === "error" &&
        part.state.metadata?.interrupted === true &&
        typeof part.state.metadata.output === "string"
      ) {
        push(output(part.state.metadata.output), part.state.metadata)
      }
    }
  }
  return text
}

export function snapshot(messages: MessageV2.WithParts[], options?: VisibilityOptions): Visibility {
  return { text: visibleText(messages, options), ...(options?.baseline ? { baseline: options.baseline } : {}) }
}

// A closing tag proves that the recorded wrapper ended; with path-only history
// metadata it cannot prove that a later transform did not truncate and re-close
// the body. Do not compare current disk content to guess, because rule files
// may legitimately change during a session without reloading.
function instructionBody(text: string, filepath: string) {
  const header = `Instructions from: ${filepath}\n`
  let offset = 0
  while (offset < text.length) {
    const at = text.indexOf(header, offset)
    if (at < 0) return undefined
    if (at === 0 || text[at - 1] === "\n") {
      const start = at + header.length
      const close = text.indexOf("\n</system-reminder>", start)
      const next = text.indexOf("\n\nInstructions from: ", start)
      const ends = [close, next].filter((item) => item >= 0)
      if (ends.length > 0) {
        const body = text.slice(start, Math.min(...ends))
        if (body !== "") return body
      }
    }
    offset = at + header.length
  }
  return undefined
}

export function containsInstruction(text: string, filepath: string) {
  return instructionBody(text, filepath) !== undefined
}

function visibleSources(visibility: Visibility) {
  return visibility.text.filter((item): item is VisibilityText => typeof item !== "string")
}

export interface Interface {
  readonly systemPaths: () => Effect.Effect<Set<string>, AppFileSystem.Error>
  readonly systemResult: () => Effect.Effect<SystemInstructions, AppFileSystem.Error>
  readonly system: () => Effect.Effect<string[], AppFileSystem.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, AppFileSystem.Error>
  readonly snapshot: (messages: MessageV2.WithParts[], options?: VisibilityOptions) => Visibility
  readonly inspect: (input: InspectInput) => Effect.Effect<Resolution, AppFileSystem.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(function* () {
        const disableClaudeCodePrompt = flags.disableClaudeCodePrompt || (yield* cfg.isWopalSpace())
        return {
          globalFiles: [
            path.join(global.config, "AGENTS.md"),
            ...(!disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
          ],
          instructionFiles: files(disableClaudeCodePrompt),
        }
      }),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const readRule = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(
        Effect.map((content) => ({ content })),
        Effect.catch((error) => Effect.succeed({ error })),
      )
    })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const paths = new Set<string>()

      for (const file of s.globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of s.instructionFiles) {
          const matches = yield* fs
            .findUp(file, ctx.directory, ctx.worktree)
            .pipe(Effect.catch(() => Effect.succeed([])))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* (
            path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      return paths
    })

    const systemResult = Effect.fn("Instruction.systemResult")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const local = yield* Effect.forEach(Array.from(paths), readRule, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })
      const baseline: BaselineStatus = {
        loaded: Array.from(paths).flatMap((filepath, i) => {
          const item = local[i]
          return !("error" in item) && item.content !== "" ? [filepath] : []
        }),
        errors: Array.from(paths).flatMap((filepath, i) => {
          const item = local[i]
          if (!("error" in item)) return []
          return [
            {
              filepath,
              message: item.error instanceof Error ? item.error.message : String(item.error),
            },
          ]
        }),
      }

      return {
        text: [
          ...Array.from(paths).flatMap((item, i) => {
            const file = local[i]
            return "error" in file || file.content === "" ? [] : [`Instructions from: ${item}\n${file.content}`]
          }),
          ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
        ],
        baseline,
      }
    })

    const system = Effect.fn("Instruction.system")(function* () {
      return (yield* systemResult()).text
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      const s = yield* InstanceState.get(state)
      for (const file of s.instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.isFile(filepath)) return filepath
      }
      return undefined
    })

    const actualTarget = Effect.fnUntraced(function* (target: string) {
      let current = target
      const missing: string[] = []
      while (!(yield* fs.existsSafe(current))) {
        const parent = path.dirname(current)
        if (parent === current) return undefined
        missing.unshift(path.basename(current))
        current = parent
      }
      const base = yield* fs.realPath(current).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!base) return undefined
      return path.join(base, ...missing)
    })

    const inspect = Effect.fn("Instruction.inspect")(function* (input: InspectInput) {
      const operation = input.operation ?? "read"
      const root = path.resolve(input.directory ?? (yield* InstanceState.directory))
      const canonicalRoot = (yield* fs.realPath(root).pipe(Effect.catch(() => Effect.succeed(undefined)))) ?? root
      const requested = path.resolve(root, input.filepath)
      const target = (yield* actualTarget(requested)) ?? requested
      const visible =
        input.visibility ?? snapshot(input.messages ?? [], { toolOutputMaxChars: input.toolOutputMaxChars })
      const files: DirectoryInstruction[] = []
      const errors: DirectoryInstructionError[] = []

      if (!AppFileSystem.contains(canonicalRoot, target)) {
        return { target, files, attach: [], visible: [], errors, status: "none" as const }
      }

      const sys = yield* systemPaths()
      if (operation === "modify") {
        if (visible.baseline) {
          errors.push(...visible.baseline.errors)
        } else {
          // Direct callers may not have a request-time baseline snapshot. They
          // still recover the older fail-closed behavior where possible.
          for (const filepath of sys) {
            const loaded = yield* readRule(filepath)
            if ("error" in loaded) {
              errors.push({
                filepath,
                message: loaded.error instanceof Error ? loaded.error.message : String(loaded.error),
              })
            }
          }
        }
      }

      let current = path.dirname(target)
      while (current !== canonicalRoot && AppFileSystem.contains(canonicalRoot, current)) {
        const found = yield* find(current)
        const self = found ? path.resolve(found) === target : false
        if (found && (operation === "modify" || !self) && !sys.has(path.resolve(found))) {
          const loaded = yield* readRule(found)
          if ("error" in loaded) {
            errors.push({
              filepath: found,
              message: loaded.error instanceof Error ? loaded.error.message : String(loaded.error),
            })
          } else if (loaded.content !== "") {
            const formatted = `Instructions from: ${found}\n${loaded.content}`
            const state = visibleSources(visible).some(
              (source) => source.loaded.includes(found) && containsInstruction(source.text, found),
            )
              ? "visible"
              : "attach"
            files.push({
              filepath: found,
              content: loaded.content,
              formatted,
              reminder: `<system-reminder>\n${formatted}\n</system-reminder>`,
              state,
            })
          }
        }
        current = path.dirname(current)
      }

      const attach = files.filter((item) => item.state === "attach")
      const alreadyVisible = files.filter((item) => item.state === "visible").map((item) => item.filepath)
      const status: ResolutionStatus =
        errors.length > 0
          ? files.length > 0
            ? "mixed"
            : "error"
          : attach.length > 0 && alreadyVisible.length > 0
            ? "mixed"
            : attach.length > 0
              ? "attach"
              : alreadyVisible.length > 0
                ? "visible"
                : "none"
      return { target, files, attach, visible: alreadyVisible, errors, status }
    })

    return Service.of({ systemPaths, systemResult, system, find, snapshot, inspect })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as Instruction from "./instruction"
