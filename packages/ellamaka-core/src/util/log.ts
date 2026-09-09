export * as Log from "./log"

import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import * as Global from "../global"
import { Schema } from "effect"
import { Glob } from "./glob"

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
const initializedRunID = "OPENCODE_LOG_INITIALIZED_RUN_ID"

let level: Level = "INFO"

export function setLevel(next: Level) {
  level = next
}

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
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

function localStamp() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function dir(options: Options) {
  if (!options.dev) return Global.Path.log
  if (process.env.WOPAL_DEBUG_LOG_DIR) return process.env.WOPAL_DEBUG_LOG_DIR
  const spaceRoot = process.env.WOPAL_SPACE_ROOT
  if (spaceRoot) return path.join(spaceRoot, ".wopal-space", "logs")
  // Outside any WopalSpace (e.g. `ellamaka dsh` from an arbitrary cwd) the
  // machine command still runs: fall back to the global log directory
  // instead of throwing — space-scoped logs are an optimization, not a
  // precondition.
  return Global.Path.log
}

export async function init(next: Options) {
  if (next.level) level = next.level
  if (next.print) return
  options = next
  // Re-init (e.g. between tests or after a failed first write) must start a
  // fresh generation so a stale in-flight stream is never reused.
  generation++
  initialized = false
  initializing = null
  // The log file is created lazily on the first actual write, so read-only
  // machine commands (e.g. `debug release-info`) never leave empty log files.
  logpath = path.join(
    dir(next),
    next.dev
      ? next.devFile ?? "dev.log"
      : (next.role ? `${next.role}-${localStamp()}.log` : `${localStamp()}.log`),
  )
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
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    const ts = next.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T")
    return [ts, "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
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
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
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
