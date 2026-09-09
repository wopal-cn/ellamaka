import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Value } from "@sinclair/typebox/value"
import type { TSchema } from "@sinclair/typebox"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import {
  CliEnvelope,
  CapabilityContractError,
  SpaceControlUnavailable,
  StableErrorCode,
  type CliEnvelopeError,
  type CliEnvelopeSuccess,
} from "./cli-schema"

const defaultTimeout = 15_000

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface Interface {
  /** Execute a capability and return the decoded data */
  readonly execute: <T>(
    executablePath: string,
    args: string[],
    expectedCapability: string,
    dataSchema: TSchema,
    opts?: { timeout?: number },
  ) => Effect.Effect<T, SpaceControlUnavailable | CapabilityContractError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CliAdapter") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const execute = <T>(
    executablePath: string,
    args: string[],
    expectedCapability: string,
    dataSchema: TSchema,
    opts?: { timeout?: number },
  ): Effect.Effect<T, SpaceControlUnavailable | CapabilityContractError> =>
    // Effect.suspend defers the spawner.spawn call; the spawner is captured from
    // the closure so the returned Effect has no requirements.
    Effect.suspend((): Effect.Effect<T, SpaceControlUnavailable | CapabilityContractError> => {
      const timeout = opts?.timeout ?? defaultTimeout
      const isTs = executablePath.endsWith(".ts")
      const execCmd = isTs ? "bun" : executablePath
      const execArgs = isTs ? [executablePath, ...args] : args
      return spawner
        .spawn(ChildProcess.make(execCmd, execArgs, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }))
        .pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new SpaceControlUnavailable({ message: "Failed to spawn CLI process", reason: String(cause) }),
            ),
          ),
          Effect.flatMap((raw) =>
            Effect.all([
              Stream.mkString(Stream.decodeText(raw.stdout)).pipe(
                Effect.catch((cause) =>
                  Effect.fail(
                    new SpaceControlUnavailable({ message: "Failed to read CLI stdout", reason: String(cause) }),
                  ),
                ),
              ),
              raw.exitCode.pipe(
                Effect.catch((cause) =>
                  Effect.fail(
                    new SpaceControlUnavailable({ message: "Failed to get CLI exit code", reason: String(cause) }),
                  ),
                ),
              ),
            ]).pipe(
              Effect.flatMap(([stdout, exitCode]) => {
                const body =
                  exitCode !== 0
                    ? parseEnvelope(stdout, expectedCapability).pipe(
                        Effect.catchTag("SpaceControlUnavailable", (error) =>
                          Effect.fail(
                            new SpaceControlUnavailable({
                              message: "CLI exited with non-zero code and non-JSON stdout",
                              reason: `exit code ${exitCode}: ${error.reason}`,
                            }),
                          ),
                        ),
                        Effect.flatMap((envelope) =>
                          envelope.ok ? decodeData(envelope.data, dataSchema, expectedCapability) : mapError(envelope),
                        ),
                      )
                    : parseEnvelope(stdout, expectedCapability).pipe(
                        Effect.flatMap((envelope) =>
                          envelope.ok ? decodeData(envelope.data, dataSchema, expectedCapability) : mapError(envelope),
                        ),
                      )
                return body
              }),
            ),
          ),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new SpaceControlUnavailable({
                  message: "CLI process timed out",
                  reason: `execution exceeded ${timeout}ms`,
                }),
              ),
          }),
        ) as Effect.Effect<T, SpaceControlUnavailable | CapabilityContractError>
    })

  return Service.of({ execute }) as unknown as Interface
})

export const layer = Layer.effect(Service, make)

export const defaultLayer = layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseEnvelope = Effect.fnUntraced(function* (
  stdout: string,
  expectedCapability: string,
) {
  let raw: unknown
  try {
    raw = JSON.parse(stdout.trim() || "{}")
  } catch {
    return yield* Effect.fail(
      new SpaceControlUnavailable({ message: "CLI stdout is not valid JSON", reason: stdout.slice(0, 200) }),
    )
  }

  if (!Value.Check(CliEnvelope, raw)) {
    const detail = [...Value.Errors(CliEnvelope, raw)]
      .slice(0, 3)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ")
    return yield* Effect.fail(
      new SpaceControlUnavailable({
        message: "CLI stdout does not match capability envelope",
        reason: detail || "unknown shape",
      }),
    )
  }

  const envelope = raw as CliEnvelopeSuccess | CliEnvelopeError

  if (envelope.capability !== expectedCapability) {
    return yield* Effect.fail(
      new CapabilityContractError({
        message: `Capability mismatch: expected ${expectedCapability}, got ${envelope.capability}`,
        capability: expectedCapability,
        detail: envelope.capability,
      }),
    )
  }

  return envelope
})

const decodeData = Effect.fnUntraced(function* <T>(
  data: unknown,
  dataSchema: TSchema,
  expectedCapability: string,
) {
  if (!Value.Check(dataSchema, data)) {
    const detail = [...Value.Errors(dataSchema, data)]
      .slice(0, 3)
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ")
    return yield* Effect.fail(
      new CapabilityContractError({
        message: `Capability data schema mismatch for ${expectedCapability}`,
        capability: expectedCapability,
        detail: detail || "unknown shape",
      }),
    )
  }
  return data as T
})

const mapError = Effect.fnUntraced(function* (envelope: CliEnvelopeError) {
  const code = envelope.error.code
  const isKnown = Schema.is(StableErrorCode)(code)

  if (code === "CAPABILITY_VERSION_UNSUPPORTED") {
    return yield* Effect.fail(
      new CapabilityContractError({
        message: envelope.error.message,
        capability: envelope.capability,
        detail: envelope.error.suggestion,
      }),
    )
  }

  if (isKnown) {
    return yield* Effect.fail(
      new SpaceControlUnavailable({
        message: `[${code}] ${envelope.error.message}`,
        reason: envelope.error.suggestion,
      }),
    )
  }

  return yield* Effect.fail(
    new SpaceControlUnavailable({
      message: `[UNKNOWN_ERROR:${code}] ${envelope.error.message}`,
      reason: envelope.error.suggestion,
    }),
  )
})

export * as CliAdapter from "./cli-adapter"
