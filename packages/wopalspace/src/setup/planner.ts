import { createHash } from "node:crypto"
import { SETUP_GOALS, isSetupGoal, type SetupAction, type SetupFacts, type SetupGoal } from "./types"

/**
 * Goal satisfaction is decided only from live application facts. Setup
 * completion never consults Runtime readiness, DSH state or product inventory.
 */
export function goalSatisfied(goal: SetupGoal, facts: SetupFacts): boolean {
  switch (goal) {
    case "foundation":
      return facts.home.foundation.ready && facts.home.writable
    case "ontology":
      return (
        facts.ontology.status === "ready" &&
        facts.ontology.items.length > 0 &&
        facts.home.settings.valid &&
        facts.home.settings.ellamaka.valid &&
        facts.home.capabilities.ready
      )
    case "space":
      return facts.space.items.some((item) => item.verified)
    case "github":
      return (
        facts.credentials.github.configured &&
        (facts.credentials.github.source === "gh" || facts.state.steps.github === "done")
      )
    case "provider":
      return facts.credentials.providers.length > 0
    default:
      return false
  }
}

export function satisfiedGoals(facts: SetupFacts): SetupGoal[] {
  return SETUP_GOALS.filter((goal) => goalSatisfied(goal, facts))
}

const DEPENDENCIES: Readonly<Record<SetupGoal, readonly SetupGoal[]>> = {
  foundation: [],
  ontology: ["foundation", "github"],
  space: ["ontology"],
  github: ["foundation"],
  provider: ["foundation"],
}

/** Goals whose execution needs a user decision or a secret. */
const NEEDS_INPUT: Readonly<Record<SetupGoal, boolean>> = {
  foundation: false,
  ontology: false,
  space: true,
  github: true,
  provider: true,
}

/**
 * Build the ordered action list for the requested goals. Only goals that the
 * live facts do not already satisfy appear, in canonical order.
 */
export function planSetup(input: { goals: readonly SetupGoal[]; facts: SetupFacts }): SetupAction[] {
  const requested = new Set(input.goals)
  return SETUP_GOALS.filter((goal) => requested.has(goal) && !goalSatisfied(goal, input.facts)).map((goal) => ({
    actionId: goal,
    goal,
    requiresInput: NEEDS_INPUT[goal],
    dependsOn: DEPENDENCIES[goal],
  }))
}

export function assertGoals(value: unknown): SetupGoal[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SetupGoalError("At least one setup goal is required")
  }
  const goals: SetupGoal[] = []
  for (const entry of value) {
    if (!isSetupGoal(entry)) throw new SetupGoalError("Unknown setup goal: " + String(entry))
    if (!goals.includes(entry)) goals.push(entry)
  }
  return goals
}

export class SetupGoalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SetupGoalError"
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) record[key] = entry
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(record[key]))
      .join(",") +
    "}"
  )
}

/**
 * Fingerprint of the facts a plan depends on. Diagnostics, timestamps and
 * other presentation detail are excluded so an unchanged machine keeps the
 * same fingerprint.
 */
export function fingerprintOf(facts: SetupFacts): string {
  const critical = {
    home: {
      path: facts.home.path,
      writable: facts.home.writable,
      foundation: facts.home.foundation.ready,
      missing: [...facts.home.foundation.missing].sort(),
      settings: facts.home.settings,
      capabilities: facts.home.capabilities,
    },
    ontology: {
      status: facts.ontology.status,
      items: [...facts.ontology.items].map((item) => item.name + "=" + item.path + "=" + item.mode).sort(),
    },
    space: {
      status: facts.space.status,
      items: [...facts.space.items].map((item) => item.name + "=" + item.path + "=" + item.verified).sort(),
    },
    github: facts.credentials.github.configured,
    providers: [...facts.credentials.providers].sort(),
    state: {
      status: facts.state.status,
      completed: facts.state.completed,
      currentStep: facts.state.currentStep,
      steps: facts.state.status === "ok" ? facts.state.steps : {},
    },
  }
  return createHash("sha256").update(canonical(critical)).digest("hex").slice(0, 16)
}
