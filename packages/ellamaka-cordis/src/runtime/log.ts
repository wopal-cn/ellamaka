import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024
const DEFAULT_BACKUP_COUNT = 3
const DEFAULT_SUPPRESS_FOR_MS = 60_000

/**
 * Minimal structured logger for the Runtime Manager (worktree AGENTS.md
 * "Logging Rules"): fixed verb-phrase messages, structured `extra` carried
 * beside the message, aggregate logs outside loops, and no silent catch.
 *
 * It appends to `logFile` (the caller owns the path). Terminal mirroring is
 * opt-in: a long-lived host must not turn its diagnostic file into a sidecar
 * stderr flood merely because DSH is enabled.
 */

export interface LogBridge {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface DshLoggerOptions {
  readonly logFile?: string
  readonly minLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR"
  /** Mirror lines to stderr, used only by an explicit `--print-logs` request. */
  readonly print?: boolean
}

/**
 * Controlled append sink for the two long-lived DSH diagnostics files.
 *
 * DSH has independent runtime, web and tools producers, including third-party
 * plugins. The sink therefore enforces a small bounded history and collapses
 * bursts of identical records before they can turn a recoverable warning into
 * an unbounded disk-write loop. It deliberately has no timer: a logger must
 * never keep a CLI process alive merely to flush a suppression counter.
 */
export interface DshLogWriterOptions {
  readonly logFile: string
  readonly maxBytes?: number
  readonly backupCount?: number
  readonly suppressForMs?: number
  readonly now?: () => number
}

export type DshLogWriter = (line: string) => void

export function createDshLogWriter(options: DshLogWriterOptions): DshLogWriter {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES
  const backupCount = options.backupCount ?? DEFAULT_BACKUP_COUNT
  const suppressForMs = options.suppressForMs ?? DEFAULT_SUPPRESS_FOR_MS
  const now = options.now ?? Date.now
  let previousRecord: string | undefined
  let previousLevel: keyof typeof LEVEL_PRIORITY = "WARN"
  let previousAt = 0
  let suppressed = 0

  const append = (line: string) => {
    mkdirSync(dirname(options.logFile), { recursive: true })
    const nextBytes = Buffer.byteLength(line)
    const currentBytes = existsSync(options.logFile) ? statSync(options.logFile).size : 0
    if (currentBytes > 0 && currentBytes + nextBytes > maxBytes) {
      for (let index = backupCount - 1; index >= 1; index--) {
        const source = index === 1 ? options.logFile : `${options.logFile}.${index - 1}`
        const target = `${options.logFile}.${index}`
        if (!existsSync(source)) continue
        // Windows does not replace an existing rename target. Remove the old
        // bounded backup first so the same rotation semantics hold on Desktop.
        if (existsSync(target)) rmSync(target, { force: true })
        renameSync(source, target)
      }
    }
    appendFileSync(options.logFile, line)
  }

  const flushSuppressed = () => {
    if (suppressed === 0) return
    append(`${stamp()} [${previousLevel}] [dsh] suppressed ${suppressed} repeated dsh log records\n`)
    suppressed = 0
  }

  return (line) => {
    const at = now()
    const record = recordForSuppression(line)
    if (record === previousRecord && at - previousAt <= suppressForMs) {
      previousAt = at
      suppressed++
      return
    }
    flushSuppressed()
    previousRecord = record
    previousLevel = levelForLine(line)
    previousAt = at
    append(line)
  }
}

const LEVEL_PRIORITY = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const

/**
 * Producers timestamp their own records. Ignore that volatile prefix when
 * finding a repeated diagnostic, otherwise the same log loop looks unique
 * once per second and defeats flood protection.
 */
function recordForSuppression(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/, "")
}

function levelForLine(line: string): keyof typeof LEVEL_PRIORITY {
  switch (recordForSuppression(line).match(/^\[(DEBUG|INFO|WARN|ERROR)\]/)?.[1]) {
    case "DEBUG":
      return "DEBUG"
    case "INFO":
      return "INFO"
    case "ERROR":
      return "ERROR"
    default:
      return "WARN"
  }
}

function stamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function formatExtra(extra?: Record<string, unknown>): string {
  if (!extra) return ""
  const parts: string[] = []
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue
    parts.push(`${key}=${formatExtraValue(value)}`)
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

function formatExtraValue(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "object") return JSON.stringify(value) ?? "[unserializable]"
  if (typeof value === "function") return "[function]"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (typeof value === "symbol") return value.description ?? "[symbol]"
  return "[unserializable]"
}

export function createDshLogger(options: DshLoggerOptions = {}): LogBridge {
  const minLevel = options.minLevel ?? "INFO"
  const write = options.logFile ? createDshLogWriter({ logFile: options.logFile }) : undefined
  let reportedWriteFailure = false
  const emit = (level: keyof typeof LEVEL_PRIORITY, message: string, extra?: Record<string, unknown>) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return
    const line = `${stamp()} [${level}] [dsh] ${message}${formatExtra(extra)}\n`
    if (write) {
      try {
        write(line)
      } catch (error) {
        // The log file is best-effort; never let logging break startup or turn
        // a full/unwritable volume into its own terminal flood.
        if (!reportedWriteFailure) {
          reportedWriteFailure = true
          process.stderr.write(`[dsh] log write failed: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
    }
    if (options.print || !options.logFile) process.stderr.write(line)
  }
  return {
    debug: (message, extra) => emit("DEBUG", message, extra),
    info: (message, extra) => emit("INFO", message, extra),
    warn: (message, extra) => emit("WARN", message, extra),
    error: (message, extra) => emit("ERROR", message, extra),
  }
}
