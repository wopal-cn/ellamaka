/**
 * Shared contracts for the Ellamaka onboarding server.
 *
 * These types are the wire + persistence contract shared by the onboarding
 * service, the HTTP/SSE router, and (through the HTTP API) every frontend.
 * They are deliberately dependency-free: only `node:*` types may leak in, so
 * the package can be mounted into any host that speaks the same structural
 * interfaces.
 *
 * @module @wopal/ellamaka-onboarding/types
 */

/** The canonical wizard steps, in order. */
export const ONBOARDING_STEPS = [
  "system-check",
  "install-cli",
  "ontology-setup",
  "create-space",
  "ai-provider",
  "memory-config",
  "done",
] as const

export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number]

/**
 * Steps the executor accepts. `github-auth` and `inspect` are pseudo steps:
 * they are executable operations that never appear in the wizard step map.
 */
export type OnboardingExecutableStep = OnboardingStepName | "inspect" | "github-auth"

export type OnboardingStepStatus = "pending" | "in-progress" | "done" | "skipped" | "failed"

/** The `onboarding.json` file shape (persistence contract). */
export interface OnboardingState {
  version: 1
  currentStep: OnboardingStepName | "done"
  steps: Record<OnboardingStepName, OnboardingStepStatus>
  errors: Partial<Record<OnboardingStepName, string>>
  completed: boolean
  startedAt: string | null
  updatedAt: string | null
  warnings?: string[]
}

/** The read-only view served by `GET /state`. */
export interface OnboardingStateView {
  completed: boolean
  currentStep: OnboardingStepName | "done"
  completedSteps: OnboardingStepName[]
}

/** The result of executing one step. */
export interface OnboardingStepResult {
  status: "completed" | "reused" | "skipped" | "failed"
  result?: Record<string, unknown>
  error?: {
    code?: string
    message?: string
    suggestion?: string
    details?: string
  }
}

/** Progress payload pushed over SSE and to the executor's progress callback. */
export interface OnboardingProgress {
  step?: string
  phase?: string
  percent?: number
  message?: string
  suggestion?: string
  details?: string
}

/** An SSE event envelope. `type` discriminates the stream. */
export type OnboardingEvent =
  | ({ type: "progress" } & OnboardingProgress)
  | { type: "log"; step?: string; message: string }
  | { type: "error"; step?: string; code?: string; message: string; details?: string }
  | { type: "complete"; completed: true }

/** The stable error code reported when an operation is already running. */
export const ONBOARDING_OPERATION_BUSY = "ONBOARDING_OPERATION_BUSY"

/** A probe result: operation-specific shape, or `{ error }` for unknown kinds. */
export type OnboardingProbeResult = Record<string, unknown>

/** Progress callback handed to a step executor. */
export type OnboardingProgressCallback = (progress: OnboardingProgress) => void

/** A step executor: the injected orchestration seam (defaults to the real one). */
export type OnboardingStepExecutor = (
  step: OnboardingExecutableStep,
  input?: unknown,
  onProgress?: OnboardingProgressCallback,
  abortSignal?: AbortSignal,
) => Promise<OnboardingStepResult>

/** Authentication policies a mounted route may declare (mirrors the host). */
export type NodeRouteAuth = "self" | "public"

/**
 * A mounted route: a prefix plus request/upgrade handlers. Structurally
 * compatible with `@opencode-ai/server`'s `NodeRouteMount`, declared locally so
 * this package never depends on the host's module graph.
 */
export interface NodeRouteMount {
  /** The pathname prefix to match (e.g. `/api/onboarding`). */
  readonly prefix: string
  /** Declared authentication policy; the mount brings its own auth → `"self"`. */
  readonly auth: NodeRouteAuth
  /** Handle a matched request; `req.url` is stripped of the prefix. */
  request(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void | Promise<void>
  /** Handle a matched upgrade; `req.url` is stripped of the prefix. */
  upgrade?(
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void | Promise<void>
}
