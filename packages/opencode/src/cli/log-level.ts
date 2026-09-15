import type * as Log from "@wopal/ellamaka-core/util/log"

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
