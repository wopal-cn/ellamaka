import type {
  OpencodeClient,
  WopalSpaceSetupCancelResponse,
  WopalSpaceSetupCompleteResponse,
  WopalSpaceSetupExecuteData,
  WopalSpaceSetupExecuteResponse,
  WopalSpaceSetupInspectResponse,
  WopalSpaceSetupHomeSelectResponse,
  WopalSpaceSetupPlanResponse,
  WopalSpaceSetupPlanData,
  WopalSpaceSetupProgressResponse,
} from "@wopal/ellamaka-sdk/v2/client"

export type SetupActionId = NonNullable<WopalSpaceSetupExecuteData["body"]>["actionId"]
export type SetupGoal = NonNullable<NonNullable<WopalSpaceSetupPlanData["body"]>["goals"]>[number]
export type SetupInspect = WopalSpaceSetupInspectResponse
export type SetupHomeSelection = WopalSpaceSetupHomeSelectResponse
export type SetupPlan = WopalSpaceSetupPlanResponse
export type SetupRun = WopalSpaceSetupProgressResponse
export type SetupExecuteRun = WopalSpaceSetupExecuteResponse
export type SetupCancelRun = WopalSpaceSetupCancelResponse
export type SetupComplete = WopalSpaceSetupCompleteResponse

export interface SetupEventView {
  readonly sequence: number
  readonly phase: "started" | "progress" | "completed" | "failed" | "cancelled"
  readonly message: string
  readonly error?: { readonly code: string; readonly message: string; readonly suggestion?: string }
}

type SetupSdk = Pick<OpencodeClient, "wopalSpace" | "global">

export interface SetupClientOptions {
  readonly reconnectDelayMs?: number
  readonly sleep?: (milliseconds: number) => Promise<void>
}

function dataOf<T>(response: { data?: T }): T {
  if (response.data === undefined) throw new Error("The Setup API returned no response data")
  return response.data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function eventOf(value: unknown): SetupEventView | undefined {
  if (!isRecord(value)) return undefined
  const sequence = typeof value.sequence === "number" ? value.sequence : Number(value.sequence)
  const phase = value.phase
  const message = value.message
  if (!Number.isFinite(sequence)) return undefined
  if (
    phase !== "started" &&
    phase !== "progress" &&
    phase !== "completed" &&
    phase !== "failed" &&
    phase !== "cancelled"
  ) {
    return undefined
  }
  const error =
    isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string"
      ? {
          code: value.error.code,
          message: value.error.message,
          ...(typeof value.error.suggestion === "string" ? { suggestion: value.error.suggestion } : {}),
        }
      : undefined
  return {
    sequence,
    phase,
    message: typeof message === "string" ? message : "",
    ...(error ? { error } : {}),
  }
}

function terminal(run: { status: string }) {
  return run.status !== "queued" && run.status !== "running"
}

export function setupSequence(value: number | string): number {
  const sequence = typeof value === "number" ? value : Number(value)
  return Number.isFinite(sequence) ? sequence : 0
}

/**
 * App-owned adapter over the generated Public Platform Setup client.
 *
 * This module contains no transport or wire types: every request goes through
 * the generated SDK. It only normalizes the SDK response envelopes and the
 * sequence-based SSE reconnect loop for the renderer.
 */
export function createSetupClient(sdk: SetupSdk, options: SetupClientOptions = {}) {
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const reconnectDelayMs = options.reconnectDelayMs ?? 250

  const follow = async (
    runId: string,
    onEvent: (event: SetupEventView) => void,
    input: { signal?: AbortSignal; after?: number } = {},
  ): Promise<SetupRun> => {
    let after = input.after ?? 0
    for (;;) {
      if (input.signal?.aborted) throw new DOMException("Setup progress was aborted", "AbortError")
      try {
        const response = await sdk.wopalSpace.setup.progress2.events(
          { runId, after: String(after) },
          { signal: input.signal, sseMaxRetryAttempts: 1 },
        )
        for await (const raw of response.stream) {
          const event = eventOf(raw)
          if (!event || event.sequence <= after) continue
          after = event.sequence
          onEvent(event)
          if (event.phase === "completed" || event.phase === "failed" || event.phase === "cancelled") {
            return dataOf(await sdk.wopalSpace.setup.progress({ runId }, { signal: input.signal }))
          }
        }
      } catch (error) {
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error
      }

      const snapshot = dataOf(await sdk.wopalSpace.setup.progress({ runId }, { signal: input.signal }))
      if (terminal(snapshot)) return snapshot
      after = Math.max(after, setupSequence(snapshot.sequence))
      await sleep(reconnectDelayMs)
    }
  }

  return {
    async inspect(): Promise<SetupInspect> {
      return dataOf(await sdk.wopalSpace.setup.inspect())
    },
    async selectHome(path: string): Promise<SetupHomeSelection> {
      return dataOf(await sdk.wopalSpace.setup.home.select({ path }))
    },
    async plan(goals: SetupGoal[]) {
      return dataOf(await sdk.wopalSpace.setup.plan({ goals }))
    },
    async execute(input: {
      planId: string
      actionId: SetupActionId
      input?: Record<string, unknown>
    }): Promise<SetupExecuteRun> {
      return dataOf(await sdk.wopalSpace.setup.execute(input))
    },
    async cancel(runId: string): Promise<SetupCancelRun> {
      return dataOf(await sdk.wopalSpace.setup.cancel({ runId }))
    },
    async complete(planId: string): Promise<SetupComplete> {
      return dataOf(await sdk.wopalSpace.setup.complete({ planId }))
    },
    /**
     * Trigger host Core Preparation. Idempotent on the server: an already
     * READY runtime returns immediately. Onboarding calls this after Space so
     * the closure download is visible instead of happening behind Workbench.
     */
    async prepareRuntime(): Promise<{ status: "ready" | "degraded" | "disabled"; diagnostic?: string }> {
      return dataOf(await sdk.global.runtime.prepare())
    },
    follow,
  }
}

export type SetupClient = ReturnType<typeof createSetupClient>
