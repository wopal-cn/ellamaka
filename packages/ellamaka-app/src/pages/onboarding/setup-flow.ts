import type { WopalSpaceSetupInspectResponse } from "@wopal/ellamaka-sdk/v2/client"
import type { SetupActionId, SetupInspect } from "./setup-client"

export type SetupStep = "foundation" | "github" | "ontology" | "space" | "provider" | "done"

export interface SetupSelection {
  readonly ontologyMode: "fork" | "clone"
  readonly provider: boolean
}

export interface SetupErrorView {
  readonly code?: string
  readonly message: string
  readonly suggestion?: string
}

function foundationReady(facts: SetupInspect) {
  return facts.home.foundation.ready && facts.home.writable
}

function ontologyReady(facts: SetupInspect) {
  return (
    facts.ontology.status === "ready" &&
    facts.ontology.items.length > 0 &&
    facts.home.settings.valid &&
    facts.home.settings.ellamaka.valid &&
    facts.home.capabilities.ready
  )
}

export function githubForkReady(facts: SetupInspect): boolean {
  return facts.credentials.github.configured && facts.credentials.github.source === "gh"
}

function stepForFact(facts: SetupInspect): SetupStep {
  if (!foundationReady(facts)) return "foundation"
  if (facts.ontology.status === "missing" && !githubForkReady(facts) && facts.state.steps.github !== "skipped")
    return "github"
  if (!ontologyReady(facts)) return "ontology"
  if (!facts.space.items.some((item) => item.verified)) return "space"
  return "done"
}

/**
 * Choose the visible recovery step. Persisted progress is a hint only; live
 * facts decide whether a step is actually complete.
 */
export function resolveSetupStep(facts: SetupInspect): SetupStep {
  if (!facts.home.binding.locked) return "foundation"
  if (facts.state.completed) return "done"
  const derived = stepForFact(facts)
  const saved = facts.state.currentStep
  if (saved === "provider") {
    return facts.credentials.providers.length > 0 || facts.state.steps.provider === "skipped" ? derived : "provider"
  }
  if (saved === "foundation" && derived === "foundation") return saved
  if (
    saved === "github" &&
    foundationReady(facts) &&
    !ontologyReady(facts) &&
    facts.state.steps.github !== "skipped" &&
    !githubForkReady(facts)
  )
    return saved
  if (saved === "ontology" && derived === "ontology") return saved
  if (
    saved === "space" &&
    foundationReady(facts) &&
    facts.ontology.status === "ready" &&
    !facts.space.items.some((item) => item.verified)
  ) {
    return saved
  }
  return derived
}

/** Goals are user intent. The server still removes facts that are already satisfied. */
export function goalsForSetup(facts: SetupInspect, selection: SetupSelection): SetupActionId[] {
  const goals: SetupActionId[] = ["foundation"]
  if (selection.ontologyMode === "fork" && !githubForkReady(facts)) goals.push("github")
  goals.push("ontology", "space")
  if (selection.provider) goals.push("provider")
  return goals
}

/** Presentation label for one concrete Setup execution intent. */
export function setupActionLabel(
  action: SetupActionId,
  input: Readonly<Record<string, unknown>> | undefined,
  fallback: string,
): string {
  if (input?.skip === true && action === "provider") return "跳过 Provider 配置"
  if (input?.skip === true && action === "github") return "跳过 GitHub 配置，使用 Clone"
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function setupErrorView(error: unknown): SetupErrorView {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : undefined
  const body = cause && isRecord(cause.body) ? cause.body : undefined
  const code = body && typeof body.code === "string" ? body.code : undefined
  const suggestion = body && typeof body.suggestion === "string" ? body.suggestion : undefined
  const message =
    body && typeof body.message === "string"
      ? body.message
      : error instanceof Error && error.message
        ? error.message
        : "Setup failed."
  return { ...(code ? { code } : {}), message, ...(suggestion ? { suggestion } : {}) }
}

/**
 * Ontology failures always refresh live facts before choosing the next visible
 * step. A fork can fail while GitHub identity remains valid (permissions,
 * organization policy, repository conflict), so persisted failure state must
 * never masquerade as an authentication failure.
 */
export function setupFailureRecovery(
  action: SetupActionId,
  error: SetupErrorView,
): { readonly refreshFacts: boolean; readonly deriveStepFromFacts: boolean } {
  return {
    refreshFacts: error.code === "SETUP_PLAN_STALE" || action === "ontology",
    deriveStepFromFacts: action === "ontology",
  }
}

export type InspectFacts = WopalSpaceSetupInspectResponse
