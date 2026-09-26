import type { Exporter, Message } from "@deepseek-ai/cordis"
import { createPackageDshRuntimeApi, type DshRuntimeApi } from "./runtime/loader.js"
import type { DshLogLevel } from "./runtime/log.js"

/**
 * ellamaka-side log level names, matching `@wopal/ellamaka-core/util/log`.
 * cordis uses numeric LoggerLevel (ERROR=0, INFO=1, WARN=2, DEBUG=3);
 * this string union is the ellamaka-side vocabulary. It is the same four-level
 * set DSH understands (`DshLogLevel`), defined once in `runtime/log.ts`.
 */
export type EllamakaLogLevel = DshLogLevel

const ELLAMAKA_PRIORITY: Record<EllamakaLogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

// cordis LoggerLevel.DEBUG = 3 (const enum — use literal to avoid
// ambient-const-enum access under verbatimModuleSyntax)
const CORDIS_LEVEL_DEBUG = 3

export interface CordisPluginLogInput {
  readonly name: string
  readonly level: EllamakaLogLevel
  readonly body: string
}

export interface CordisPluginLogOutput {
  readonly level: EllamakaLogLevel
  readonly body: string
}

/** Map a cordis LoggerType to the ellamaka level name. */
function cordisTypeToLevel(type: Message["type"]): EllamakaLogLevel {
  switch (type) {
    case "error":
      return "ERROR"
    case "warn":
      return "WARN"
    case "info":
      return "INFO"
    case "debug":
      return "DEBUG"
  }

  // Keep the boundary fail-closed if a future Cordis version adds a message
  // type before this adapter learns its semantics.
  return "ERROR"
}

/**
 * A DSH tool result is already delivered to the calling agent. Logging each
 * expected rejection as a plugin ERROR both duplicates that result and makes
 * normal policy enforcement look like a broken host. Keep an intentionally
 * small, explicit classifier at the host boundary: unknown plugin failures
 * remain visible, while known policy outcomes become redacted DEBUG records.
 */
export function classifyCordisPluginLog(input: CordisPluginLogInput): CordisPluginLogOutput {
  const toolFailure = toolFailureDetails(input)
  if (toolFailure) {
    const reason = expectedToolOutcomeReason(toolFailure.error)
    if (reason) {
      return {
        level: "DEBUG",
        body: `tool outcome rejected tool=${toolFailure.tool} reason=${reason}`,
      }
    }
    return {
      // The call itself failed, but the server and the plugin stayed alive.
      // The tool result is the authority for the detail; do not copy its raw
      // error, session ID, call ID, or paths into a long-lived host log.
      level: "WARN",
      body: `tool execution failed tool=${toolFailure.tool} reason=unexpected`,
    }
  }

  const policyReason = expectedToolOutcomeReason(input.body)
  if (policyReason && isDshPlugin(input.name)) {
    return {
      level: "DEBUG",
      body: `policy outcome rejected reason=${policyReason}`,
    }
  }

  if (isRecovering(input.body) && isDshPlugin(input.name)) {
    return {
      level: "DEBUG",
      body: "plugin recovery in progress",
    }
  }

  const unavailableReason = capabilityUnavailableReason(input.body)
  if (unavailableReason && isDshPlugin(input.name)) {
    return { level: "ERROR", body: `plugin capability unavailable reason=${unavailableReason}` }
  }

  return { level: input.level, body: input.body }
}

function toolFailureDetails(input: CordisPluginLogInput): { tool: string; error: string } | undefined {
  if (input.name !== "dsh-adapter" || !input.body.startsWith("tool call failed")) return undefined
  const json = input.body.slice("tool call failed".length).trim()
  if (!json) return { tool: "unknown", error: "" }
  try {
    const value: unknown = JSON.parse(json)
    if (!isRecord(value)) return { tool: "unknown", error: "" }
    return {
      tool: safeToolName(value.tool),
      error: typeof value.error === "string" ? value.error : "",
    }
  } catch {
    return { tool: "unknown", error: "" }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string") return "unknown"
  return /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : "unknown"
}

function expectedToolOutcomeReason(value: string): string | undefined {
  if (/requires reading .* first|FS_NOT_OBSERVED/i.test(value)) return "read-required"
  if (/FS_NOT_FOUND|cannot edit .*not found|target .*not found/i.test(value)) return "target-missing"
  if (/stale (?:read|observation|version)|changed since (?:it was )?read/i.test(value)) return "stale-observation"
  if (
    /\b(?:sandbox|permission|approval)\b.*\b(?:denied|rejected|unavailable)\b|outside (?:the )?workspace|read-only mode/i.test(
      value,
    )
  ) {
    return "permission-denied"
  }
  if (/\b(?:tool call|operation)\b.*\b(?:cancelled|canceled|aborted)\b/i.test(value)) return "cancelled"
  return undefined
}

function isRecovering(value: string): boolean {
  return /\b(?:reconnecting|retrying|will retry|connection attempt failed|temporarily unavailable)\b/i.test(value)
}

function capabilityUnavailableReason(value: string): string | undefined {
  if (/\b(?:no tools registered|tools unregistered)\b/i.test(value)) return "tools-unregistered"
  if (/\b(?:giving up after|reconnect stopped)\b/i.test(value)) return "recovery-exhausted"
  if (/\bfailed generation did not close\b/i.test(value)) return "generation-stalled"
  return undefined
}

function isDshPlugin(name: string): boolean {
  return name.startsWith("dsh-")
}

export interface CordisLogExporterDeps {
  /** Absolute path to the plugin log file. */
  readonly logFile: string
  /**
   * Minimum log level; messages below this are dropped. A getter keeps a
   * Desktop debug-toggle effective for already-mounted DSH containers.
   */
  readonly minLevel: EllamakaLogLevel | (() => EllamakaLogLevel)
  /**
   * Profile tag rendered into every line. Two containers (web, ellamaka-tools)
   * are independent cordis fibers that may share one dsh-plugins log file;
   * without the tag their entries are indistinguishable.
   */
  readonly profile?: string
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
 * ellamaka-managed sink, bypassing the ellamaka main log (DESIGN-dsh-base.md
 * §6.4).
 *
 * The exporter:
 * - sets `levels.default = DEBUG` so cordis forwards every message here
 * - filters by `deps.minLevel` (the ellamaka process-level threshold, read
 *   per record when the host supplies a live getter)
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
      const runtime = deps.runtime ?? createPackageDshRuntimeApi()
      const { Logger } = runtime.cordis
      const body = Logger.format(exporter, message)
      const classified = classifyCordisPluginLog({ name: message.name, level: levelName, body })
      const minLevel = typeof deps.minLevel === "function" ? deps.minLevel() : deps.minLevel
      if (ELLAMAKA_PRIORITY[classified.level] < ELLAMAKA_PRIORITY[minLevel]) return
      const ts = new Date(message.ts).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T")
      const profileTag = deps.profile ? ` [${deps.profile}]` : ""
      const line = `${ts} [${classified.level}]${profileTag} [${message.name}] ${classified.body}\n`
      deps.write(line)
    },
  }
  return exporter
}
