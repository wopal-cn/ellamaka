export * as Log from "./log"

import path from "path"
import fs from "fs/promises"
import { createWriteStream, readFileSync } from "fs"
import * as Global from "../global"
import { Schema } from "effect"
import { parse as parseJsonc } from "jsonc-parser"
import { Glob } from "./glob"

export const Level = Schema.Literals(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  TRACE: -1,
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
const initializedRunID = "OPENCODE_LOG_INITIALIZED_RUN_ID"
const maxLogValueLength = 4096
const maxLogLineLength = 16 * 1024
const truncationMarker = "…[truncated]"

/**
 * TRACE categories are a closed registry. Each one names a diagnostic area
 * that used to flood the operator log, so `--trace` must name the areas it
 * wants instead of the level implying "everything".
 *
 * Adding a category is a deliberate act: it must have at least one call site
 * and a place in the operator documentation.
 */
export const TraceCategory = {
  Bus: "bus",
  Permission: "permission",
  Session: "session",
  Llm: "llm",
  Plugin: "plugin",
  Io: "io",
} as const

export type TraceCategory = (typeof TraceCategory)[keyof typeof TraceCategory]

const traceCategoryList: readonly TraceCategory[] = Object.values(TraceCategory)

/** Selects every registered category in one token. */
export const ALL_TRACE_CATEGORIES = "all"

/** The categories accepted by `--trace` and by `Log.trace`. */
export function traceCategories(): readonly TraceCategory[] {
  return traceCategoryList
}

export function isTraceCategory(value: string): value is TraceCategory {
  return (traceCategoryList as readonly string[]).includes(value)
}

let level: Level = "INFO"
let selectedTraceCategories: Set<string> = new Set()

/**
 * Turns a raw selector into a set of category tokens. Unknown tokens are kept
 * out of the set so a typo can never widen what is emitted; `*` and `all`
 * become the explicit all-category token.
 */
export function normalizeTraceCategories(input?: string | readonly string[]): Set<string> {
  if (input === undefined) return new Set()
  const raw = typeof input === "string" ? input.split(",") : input
  const result = new Set<string>()
  for (const token of raw) {
    const category = token.trim().toLowerCase()
    if (category.length === 0) continue
    if (category === "*" || category === ALL_TRACE_CATEGORIES) {
      result.add(ALL_TRACE_CATEGORIES)
      continue
    }
    if (!isTraceCategory(category)) continue
    result.add(category)
  }
  return result
}

/**
 * Sets the effective level and, when provided, the trace category selector.
 * Passing an explicit level other than TRACE clears the selector: a caller who
 * drops back to DEBUG must not keep a stale trace filter that silently
 * re-activates on a later TRACE.
 */
export function setLevel(next: Level, categories?: string | readonly string[]) {
  level = next
  if (categories !== undefined) {
    selectedTraceCategories = normalizeTraceCategories(categories)
    return
  }
  if (next !== "TRACE") selectedTraceCategories = new Set()
}

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

function parseLevel(value: unknown, options: { allowTrace?: boolean } = {}): Level | undefined {
  if (value === "TRACE") return options.allowTrace === false ? undefined : "TRACE"
  if (value === "DEBUG" || value === "INFO" || value === "WARN" || value === "ERROR") return value
  return undefined
}

export interface ResolveLevelOptions {
  /** Explicit level (e.g. `--log-level`); wins over every persisted source. */
  requested?: Level
  /** Environment map; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Settings file; defaults to `$WOPAL_HOME/config/settings.jsonc`. */
  configFile?: string
}

/**
 * Resolve the unified effective level (DESIGN-config-settings.md "Logging
 * Level"): `requested` > `ELLAMAKA_LOG_LEVEL` > `wopal.logging.level` > INFO.
 * Each source is tried in order; an invalid value is not a hit and the next
 * source is consulted. TRACE is legal only as an explicit or environment value
 * (it must pair with `--trace`), never as a persistent config value. Reading
 * the config is best-effort: an unreadable or malformed file falls back to
 * INFO and never blocks startup.
 *
 * Callers are process entries: they resolve once, write the result back to
 * `ELLAMAKA_LOG_LEVEL` for the process tree, and pass it to `Log.init`.
 */
export function resolveEffectiveLevel(options: ResolveLevelOptions = {}): Level {
  if (options.requested) return options.requested
  const env = options.env ?? process.env
  const fromEnv = parseLevel(env.ELLAMAKA_LOG_LEVEL)
  if (fromEnv) return fromEnv
  const configFile = options.configFile ?? path.join(Global.Path.config, "settings.jsonc")
  return readConfiguredLevel(configFile) ?? "INFO"
}

/**
 * The single replacement point for the persisted level read: when
 * `wopal config get` lands, only this function changes. v1 reads the global
 * layer only (`$WOPAL_HOME/config/settings.jsonc`).
 */
function readConfiguredLevel(configFile: string): Level | undefined {
  try {
    // jsonc-parser is fault-tolerant: invalid input still yields a recoverable
    // tree, so a syntactically broken document must be rejected via the error
    // array — a level inside it is not a configured level.
    const errors: import("jsonc-parser").ParseError[] = []
    const parsed: unknown = parseJsonc(readFileSync(configFile, "utf8"), errors)
    if (errors.length > 0) return undefined
    if (!isRecord(parsed)) return undefined
    const wopal = parsed.wopal
    if (!isRecord(wopal)) return undefined
    const logging = wopal.logging
    if (!isRecord(logging)) return undefined
    // TRACE is a command-line mechanism (`--trace`), not a config value.
    return parseLevel(logging.level, { allowTrace: false })
  } catch {
    return undefined
  }
}

/**
 * A trace record emits only when TRACE is the effective level AND a category
 * was explicitly selected. The level alone emits nothing: `--log-level TRACE`
 * without `--trace` is an error at the CLI, and this guard keeps a stray
 * programmatic `setLevel("TRACE")` from opening every area.
 */
function shouldTrace(category: string): boolean {
  if (level !== "TRACE") return false
  if (selectedTraceCategories.size === 0) return false
  if (selectedTraceCategories.has(ALL_TRACE_CATEGORIES)) return true
  return selectedTraceCategories.has(category.trim().toLowerCase())
}

/**
 * Bounds a category to a single short token so a malformed or hostile category
 * can never smuggle a multi-line value or payload into the structured record.
 */
function normalizeCategory(category: string): string {
  const normalized = singleLine(category).trim().toLowerCase()
  return truncate(normalized.length === 0 ? "unknown" : normalized, 32)
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  trace(category: TraceCategory, message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
    logLevel?: "DEBUG" | "INFO",
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  devFile?: string
  level?: Level
  /** Trace category selector; only meaningful when `level` is TRACE. */
  trace?: string | readonly string[]
  role?: "serve" | "tui" | "sidecar"
}

let logpath = ""
export function file() {
  return logpath
}
let write: Write = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}
type Write = (msg: any) => any

let options: Options | null = null
let initialized = false
let initializing: Promise<void> | null = null
let generation = 0
let processWarningHandlerInstalled = false

type ProcessWarning = Error & {
  type?: unknown
  count?: unknown
  emitter?: { constructor?: { name?: unknown } }
}

/**
 * Runtime warnings (notably MaxListenersExceededWarning) otherwise bypass the
 * application logger and are printed by Bun/Node directly to stderr. Install
 * one process-wide handler so normal hosts retain the diagnostic in their
 * rotating structured log instead of leaking a minified runtime object and
 * stack into the terminal or Desktop sidecar stderr relay.
 */
function installProcessWarningHandler() {
  if (processWarningHandlerInstalled) return
  processWarningHandlerInstalled = true
  process.on("warning", (warning: ProcessWarning) => {
    const emitterName = warning.emitter?.constructor?.name
    create({ service: "runtime" }).warn("runtime warning", {
      name: warning.name,
      message: warning.message,
      type: warning.type,
      count: warning.count,
      emitter: typeof emitterName === "string" ? emitterName : undefined,
      // The stack stays a single structured field in the log rather than
      // becoming unprefixed terminal lines. It is retained for diagnosis.
      stack: warning.stack ? { trace: warning.stack } : undefined,
    })
  })
}

function localStamp() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Directory routing (DESIGN-logging.md "角色分域"), in priority order:
 * 1. `WOPAL_DEBUG_LOG_DIR` — the dev-toolchain override, honored only in the
 *    dev channel and winning for every role.
 * 2. Machine roles (`serve`, `sidecar`) are global-domain services: they
 *    serve multiple spaces per process, so their records belong to
 *    `$WOPAL_HOME/logs` even when launched inside a space.
 * 3. Interactive roles (`tui`, including the role-less default) are
 *    space-aware: a process started inside a WopalSpace writes to that
 *    space's `.wopal-space/logs` (`WOPAL_SPACE_ROOT`, written by the CLI
 *    entry's single detection point — the logger never re-detects).
 * 4. Outside any WopalSpace (e.g. `ellamaka dsh` from an arbitrary cwd) the
 *    machine command still runs: fall back to the global log directory
 *    instead of throwing — space-scoped logs are an optimization, not a
 *    precondition.
 */
function dir(options: Options) {
  if (options.dev && process.env.WOPAL_DEBUG_LOG_DIR) return process.env.WOPAL_DEBUG_LOG_DIR
  if (options.role === "serve" || options.role === "sidecar") return Global.Path.log
  const spaceRoot = process.env.WOPAL_SPACE_ROOT
  if (spaceRoot) return path.join(spaceRoot, ".wopal-space", "logs")
  return Global.Path.log
}

export async function init(next: Options) {
  // A re-init starts a fresh generation. The trace selector must reset with it
  // so a prior run's filter never silently narrows (or widens) the new one.
  setLevel(next.level ?? level, next.trace ?? [])
  installProcessWarningHandler()
  if (next.print) return
  options = next
  // Re-init (e.g. between tests or after a failed first write) must start a
  // fresh generation so a stale in-flight stream is never reused.
  generation++
  initialized = false
  initializing = null
  // The log file is created lazily on the first actual write, so read-only
  // machine commands (e.g. `debug release-info`) never leave empty log files.
  logpath = path.join(dir(next), fileName(next))
}

/**
 * The file name inside the routed directory (DESIGN-logging.md "Log Files"):
 * - dev channel: the stable role-prefixed name `ellamaka-dev-<role>.log`, so
 *   same-role processes share one trackable file. An explicit `devFile`
 *   (dev tooling and tests) stays authoritative.
 * - regular channel: the per-process `<role>-<timestamp>.log` (or bare
 *   `<timestamp>.log` without a role).
 */
function fileName(next: Options) {
  if (next.dev) return next.devFile ?? `ellamaka-dev${next.role ? `-${next.role}` : ""}.log`
  return next.role ? `${next.role}-${localStamp()}.log` : `${localStamp()}.log`
}

// Ensure the log file and write stream exist exactly once per process. On
// failure the stderr fallback keeps working so log output is never lost.
async function ensureFile(): Promise<void> {
  if (initialized) return
  if (initializing) return initializing
  const opts = options
  const gen = generation
  if (!opts) return
  initializing = (async () => {
    const logdir = path.dirname(logpath)
    await fs.mkdir(logdir, { recursive: true })
    void cleanup(logdir)
    const runID = process.env.OPENCODE_RUN_ID
    const shouldTruncate = !opts.dev || !runID || process.env[initializedRunID] !== runID
    if (shouldTruncate) await fs.truncate(logpath).catch(() => {})
    if (opts.dev && runID) process.env[initializedRunID] = runID
    const stream = createWriteStream(logpath, { flags: "a" })
    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve())
      stream.once("error", reject)
    })
    write = (msg: any) => {
      return new Promise((resolve, reject) => {
        stream.write(msg, (err) => {
          if (err) reject(err)
          else resolve(msg.length)
        })
      })
    }
    if (gen === generation) initialized = true
  })().catch(() => {})
  try {
    await initializing
  } finally {
    initializing = null
  }
}

function emit(msg: string) {
  void ensureFile().then(() => write(msg))
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("*????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

type LogRecord = Record<string, unknown>

function isRecord(value: unknown): value is LogRecord {
  return typeof value === "object" && value !== null
}

function truncate(value: string, limit = maxLogValueLength): string {
  if (value.length <= limit) return value
  return value.slice(0, Math.max(0, limit - truncationMarker.length)) + truncationMarker
}

function singleLine(value: string): string {
  return value.replaceAll("\n", "\\n").replaceAll("\r", "\\r")
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string") return truncate(value, 512)
  if (typeof value === "number" || typeof value === "boolean") return value
  return undefined
}

function stripURLQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const index = value.search(/[?#]/)
  return truncate(index === -1 ? value : value.slice(0, index), 512)
}

/**
 * SDK transport errors can contain `requestBodyValues` (including every model
 * message) and raw provider response bodies. They are useful to classify by
 * status/retryability, but are not safe or useful to persist verbatim.
 */
function isTransportError(value: unknown): value is LogRecord {
  if (!isRecord(value)) return false
  return "requestBodyValues" in value || "requestBody" in value || "responseBody" in value
}

function summarizeTransportError(value: LogRecord): LogRecord {
  const data = isRecord(value.data) ? value.data : undefined
  const providerError = data && isRecord(data.error) ? data.error : undefined
  const result: LogRecord = {}

  const name = scalar(value.name)
  const code = scalar(value.code) ?? scalar(providerError?.code)
  const type = scalar(value.type) ?? scalar(providerError?.type)
  const statusCode = scalar(value.statusCode)
  const isRetryable = scalar(value.isRetryable)
  const url = stripURLQuery(value.url)

  if (name !== undefined) result.name = name
  if (code !== undefined) result.code = code
  if (type !== undefined) result.type = type
  if (statusCode !== undefined) result.statusCode = statusCode
  if (isRetryable !== undefined) result.isRetryable = isRetryable
  if (url !== undefined) result.url = url
  return result
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase()
  return (
    normalized === "requestbody" ||
    normalized === "requestbodyvalues" ||
    normalized === "responsebody" ||
    normalized === "messages" ||
    normalized === "prompt" ||
    normalized === "system" ||
    normalized === "authorization" ||
    normalized === "apikey" ||
    normalized === "token" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "cookie"
  )
}

function stringify(value: object): string {
  const seen = new WeakSet<object>()
  try {
    const result = JSON.stringify(value, function (key, item) {
      if (isSensitiveKey(key)) return "[redacted]"
      if (typeof item === "bigint") return `${item}n`
      if (typeof item === "object" && item !== null && isTransportError(item)) return summarizeTransportError(item)
      if (item instanceof Error) return { name: item.name, message: truncate(formatError(item), 512) }
      if (!isRecord(item)) return item
      if (seen.has(item)) return "[circular]"
      seen.add(item)
      return item
    })
    return result ?? "[unserializable]"
  } catch {
    return "[unserializable]"
  }
}

/**
 * Formats one structured log value for a single line. The limit is applied to
 * every value, not just the whole record, so a single SDK error can never turn
 * a normal serve log into a multi-megabyte request transcript.
 */
export function formatLogValue(value: unknown): string {
  if (isTransportError(value)) return truncate(stringify(summarizeTransportError(value)))
  if (value instanceof Error) return truncate(singleLine(formatError(value)))
  if (isRecord(value)) return truncate(stringify(value))
  return truncate(singleLine(String(value)))
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        return prefix + formatLogValue(value)
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    const ts = next.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T")
    const formattedMessage = message === undefined || message === null ? undefined : formatLogValue(message)
    const line = [ts, "+" + diff + "ms", prefix, formattedMessage].filter(Boolean).join(" ")
    return truncate(line, maxLogLineLength) + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        emit("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        emit("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        emit("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        emit("WARN  " + build(message, extra))
      }
    },
    trace(category: TraceCategory, message?: any, extra?: Record<string, any>) {
      const normalized = normalizeCategory(category)
      if (shouldTrace(normalized)) {
        emit("TRACE " + build(message, { category: normalized, ...extra }))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>, logLevel: "DEBUG" | "INFO" = "INFO") {
      const now = Date.now()
      const writeTime = (msg: any, data: Record<string, any>) => {
        if (logLevel === "DEBUG") result.debug(msg, data)
        else result.info(msg, data)
      }
      writeTime(message, { status: "started", ...extra })
      function stop() {
        writeTime(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}
