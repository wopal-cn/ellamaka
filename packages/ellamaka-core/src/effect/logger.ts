import { Cause, Effect, Logger, References } from "effect"
import * as Log from "../util/log"

type Fields = Record<string, unknown>

const normalizeKey = (key: string) => (key === "sessionID" ? "session.id" : key)

export interface Handle {
  readonly debug: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly info: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly warn: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly error: (msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly trace: (category: Log.TraceCategory, msg?: unknown, extra?: Fields) => Effect.Effect<void>
  readonly with: (extra: Fields) => Handle
}

/**
 * Effect has no category concept, so a trace call carries its category through
 * a reserved annotation. It is stripped before the record is written, where the
 * category becomes a first-class field like it is for direct `Log.trace` calls.
 */
const TRACE_CATEGORY_ANNOTATION = "log.trace.category"

const clean = (input?: Fields): Fields =>
  Object.fromEntries(
    Object.entries(input ?? {})
      .filter((entry) => entry[1] !== undefined && entry[1] !== null)
      .map(([key, value]) => [normalizeKey(key), value]),
  )

const text = (input: unknown): string => {
  // oxlint-disable-next-line no-base-to-string
  if (Array.isArray(input)) return input.map((item) => String(item)).join(" ")
  // oxlint-disable-next-line no-base-to-string
  return input === undefined ? "" : String(input)
}

const call = (run: (msg?: unknown) => Effect.Effect<void>, base: Fields, msg?: unknown, extra?: Fields) => {
  const ann = clean({ ...base, ...extra })
  const fx = run(msg)
  return Object.keys(ann).length ? Effect.annotateLogs(fx, ann) : fx
}

export const logger = Logger.make((opts) => {
  const extra = clean(opts.fiber.getRef(References.CurrentLogAnnotations))
  const now = opts.date.getTime()
  for (const [key, start] of opts.fiber.getRef(References.CurrentLogSpans)) {
    extra[`logSpan.${key}`] = `${now - start}ms`
  }
  if (opts.cause.reasons.length > 0) {
    extra.cause = Cause.pretty(opts.cause)
  }

  const svc = typeof extra.service === "string" ? extra.service : undefined
  if (svc) delete extra.service
  const log = svc ? Log.create({ service: svc }) : Log.Default
  const msg = text(opts.message)

  const category = extra[TRACE_CATEGORY_ANNOTATION]
  delete extra[TRACE_CATEGORY_ANNOTATION]

  // A trace call is routed before the level switch: the annotation says this
  // record belongs to the opt-in TRACE level, where `Log.trace` applies the
  // category gate. The Effect level carrying it is an implementation detail,
  // because Effect filters sub-Info levels before any logger sees them.
  if (typeof category === "string" && Log.isTraceCategory(category)) {
    return log.trace(category, msg, extra)
  }

  switch (opts.logLevel) {
    case "Trace":
    case "Debug":
      return log.debug(msg, extra)
    case "Warn":
      return log.warn(msg, extra)
    case "Error":
    case "Fatal":
      return log.error(msg, extra)
    default:
      return log.info(msg, extra)
  }
})

export const layer = Logger.layer([logger], { mergeWithExisting: false })

export const create = (base: Fields = {}): Handle => ({
  debug: (msg, extra) => call((item) => Effect.logDebug(item), base, msg, extra),
  info: (msg, extra) => call((item) => Effect.logInfo(item), base, msg, extra),
  warn: (msg, extra) => call((item) => Effect.logWarning(item), base, msg, extra),
  error: (msg, extra) => call((item) => Effect.logError(item), base, msg, extra),
  // `Effect.logInfo` is the transport, not the severity: the annotation marks
  // the record as TRACE so the bridge routes it to the opt-in category gate.
  // Using a sub-Info Effect level here would be dropped before the bridge.
  trace: (category, msg, extra) =>
    call((item) => Effect.logInfo(item), base, msg, { ...extra, [TRACE_CATEGORY_ANNOTATION]: category }),
  with: (extra) => create({ ...base, ...extra }),
})
