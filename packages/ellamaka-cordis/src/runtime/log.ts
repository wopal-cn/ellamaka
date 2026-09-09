import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Minimal structured logger for the Runtime Manager (worktree AGENTS.md
 * "Logging Rules"): fixed verb-phrase messages, structured `extra` carried
 * beside the message, aggregate logs outside loops, and no silent catch.
 *
 * It appends to `logFile` (the caller owns the path) and always emits to
 * stderr so operator feedback is visible even before logging is configured.
 * This keeps the manager dependency-free and deterministic for tests.
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
}

const LEVEL_PRIORITY = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const

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
    const text =
      value instanceof Error
        ? value.message
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value)
    parts.push(`${key}=${text}`)
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

export function createDshLogger(options: DshLoggerOptions = {}): LogBridge {
  const minLevel = options.minLevel ?? "INFO"
  const emit = (level: keyof typeof LEVEL_PRIORITY, message: string, extra?: Record<string, unknown>) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return
    const line = `${stamp()} [${level}] [dsh] ${message}${formatExtra(extra)}\n`
    process.stderr.write(line)
    if (options.logFile) {
      try {
        mkdirSync(dirname(options.logFile), { recursive: true })
        appendFileSync(options.logFile, line)
      } catch (error) {
        // The log file is best-effort; never let logging break startup.
        process.stderr.write(`[dsh] log write failed: ${(error as Error).message}\n`)
      }
    }
  }
  return {
    debug: (message, extra) => emit("DEBUG", message, extra),
    info: (message, extra) => emit("INFO", message, extra),
    warn: (message, extra) => emit("WARN", message, extra),
    error: (message, extra) => emit("ERROR", message, extra),
  }
}
