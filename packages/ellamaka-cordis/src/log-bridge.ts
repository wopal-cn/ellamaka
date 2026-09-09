import type { Exporter, Message } from "@deepseek-ai/cordis"
import { createPackageDshRuntimeApi, type DshRuntimeApi } from "./runtime/loader.js"

/**
 * ellamaka-side log level names, matching `@wopal/ellamaka-core/util/log`.
 * cordis uses numeric LoggerLevel (ERROR=0, INFO=1, WARN=2, DEBUG=3);
 * this string union is the ellamaka-side vocabulary.
 */
export type EllamakaLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

const ELLAMAKA_PRIORITY: Record<EllamakaLogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

// cordis LoggerLevel.DEBUG = 3 (const enum — use literal to avoid
// ambient-const-enum access under verbatimModuleSyntax)
const CORDIS_LEVEL_DEBUG = 3

/** Map a cordis LoggerType to the ellamaka level name. */
function cordisTypeToLevel(type: Message["type"]): EllamakaLogLevel {
  switch (type) {
    case "error": return "ERROR"
    case "warn": return "WARN"
    case "info": return "INFO"
    case "debug": return "DEBUG"
  }
}

export interface CordisLogExporterDeps {
  /** Absolute path to the plugin log file. */
  readonly logFile: string
  /** Minimum log level; messages below this are dropped. */
  readonly minLevel: EllamakaLogLevel
  /**
   * Sink for a fully formatted log line (including trailing newline).
   * The caller owns file I/O (appendFileSync, rotation, etc.).
   */
  readonly write: (line: string) => void
  /**
   * The DSH runtime handle to resolve `cordis.Logger` from. Production mounts
   * inject the closure-resolved runtime (B-01); when omitted the exporter
   * falls back to the package closure — a dev-only convenience that packaged
   * hosts must never rely on.
   */
  readonly runtime?: DshRuntimeApi
}

/**
 * Build a cordis `Exporter` that routes all plugin `ctx.logger` output to an
 * ellamaka-managed sink, bypassing the ellamaka main log (DESIGN-dsh-poc
 * §6.4).
 *
 * The exporter:
 * - sets `levels.default = DEBUG` so cordis forwards every message here
 * - filters by `deps.minLevel` (the ellamaka process-level threshold)
 * - formats via cordis `Logger.format` (printf-style, same as ConsoleExporter)
 * - calls `deps.write` with `<timestamp> [<LEVEL>] [<plugin>] <message>\n`
 *
 * The exporter is registered on the hub context via `ctx.logger.exporter()`
 * and is auto-disposed with the hub's fiber (zero manual cleanup).
 */
export function createCordisLogExporter(deps: CordisLogExporterDeps): Exporter {
  const exporter: Exporter = {
    colors: false,
    maxLength: 10240,
    levels: { default: CORDIS_LEVEL_DEBUG },
    export(message: Message) {
      const levelName = cordisTypeToLevel(message.type)
      if (ELLAMAKA_PRIORITY[levelName] < ELLAMAKA_PRIORITY[deps.minLevel]) return
      const runtime = deps.runtime ?? createPackageDshRuntimeApi()
      const { Logger } = runtime.cordis
      const body = Logger.format(exporter, message)
      const ts = new Date(message.ts).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T")
      const line = `${ts} [${levelName}] [${message.name}] ${body}\n`
      deps.write(line)
    },
  }
  return exporter
}
