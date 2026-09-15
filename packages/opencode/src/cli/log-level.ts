import * as Log from "@wopal/ellamaka-core/util/log"

export interface LogLevelInput {
  readonly isLocal: boolean
  readonly role: "serve" | "tui"
  readonly requested?: Log.Level
  /**
   * Raw `--trace` selector (comma-separated). A nonempty selector opts into the
   * TRACE level so the selected categories actually emit, unless an explicit
   * `--log-level` already named a level.
   */
  readonly trace?: string | readonly string[]
}

function hasTraceSelection(trace: LogLevelInput["trace"]): boolean {
  if (trace === undefined) return false
  const tokens = typeof trace === "string" ? trace.split(",") : trace
  return tokens.some((token) => token.trim().length > 0)
}

/**
 * Server logs are persistent operational records, so local `serve` should be
 * no noisier than a release server. Local TUI keeps DEBUG for interactive
 * diagnostics. `--log-level` remains the explicit escape hatch for either, and
 * wins over the implicit promotion performed by `--trace`.
 */
export function resolveLogLevel(input: LogLevelInput): Log.Level {
  if (input.requested) return input.requested
  if (hasTraceSelection(input.trace)) return "TRACE"
  return input.isLocal && input.role === "tui" ? "DEBUG" : "INFO"
}

export interface TraceInput {
  readonly requested?: Log.Level
  /** `true` when `--trace` was given with no value (a discovery request). */
  readonly trace?: string | boolean
}

export type TraceResolution =
  | { readonly kind: "ok"; readonly level?: Log.Level; readonly categories?: string }
  | { readonly kind: "list" }
  | { readonly kind: "error"; readonly message: string }

function helpMessage(): string {
  return `Available categories: ${Log.traceCategories().join(", ")} (or "all"). Run \`--trace\` alone to list them.`
}

/**
 * TRACE is opt-in per category, never a blanket level. A bare `--log-level
 * TRACE` is rejected because "trace everything" is exactly the flood the level
 * was introduced to remove; `--trace all` remains the explicit escape hatch.
 *
 * A value-less `--trace` is a discovery request: the caller wants to know what
 * can be selected, so it resolves to the category list rather than an error.
 */
export function resolveTrace(input: TraceInput): TraceResolution {
  if (input.trace === true) return { kind: "list" }

  if (typeof input.trace === "string") {
    const tokens = input.trace
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0)
    if (tokens.length === 0) return { kind: "list" }

    const unknown = tokens.filter((token) => token !== "all" && token !== "*" && !Log.isTraceCategory(token))
    if (unknown.length > 0) {
      return { kind: "error", message: `Unknown trace category: ${unknown.join(", ")}. ${helpMessage()}` }
    }
    return { kind: "ok", level: "TRACE", categories: tokens.join(",") }
  }

  // No --trace: a bare TRACE level is a configuration error.
  if (input.requested === "TRACE") {
    return { kind: "error", message: `--log-level TRACE requires --trace <categories>. ${helpMessage()}` }
  }
  return { kind: "ok" }
}
