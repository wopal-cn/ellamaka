import { zhCN, type StepContent } from "./content/zh-CN"

/** The canonical wizard steps, in order (mirrors the server contract). */
export const ONBOARDING_STEPS = [
  "system-check",
  "install-cli",
  "ontology-setup",
  "create-space",
  "ai-provider",
  "done",
] as const

export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number]

export const OPTIONAL_STEPS: Set<OnboardingStepName> = new Set([
  "ai-provider",
])

export interface StepContext {
  hasExistingSpaces?: boolean
}

export function isOptionalStep(step: OnboardingStepName, context?: StepContext): boolean {
  if (step === "create-space") {
    return Boolean(context?.hasExistingSpaces)
  }
  return OPTIONAL_STEPS.has(step)
}

export interface PhaseConfig {
  phase: 1 | 2 | 3 | 4
  title: string
  steps: (OnboardingStepName | "done")[]
  autoAdvanceSteps: Set<OnboardingStepName>
}

export const PHASE_CONFIGS: PhaseConfig[] = [
  {
    phase: 1,
    title: "引擎准备",
    steps: ["system-check", "install-cli"],
    autoAdvanceSteps: new Set([]),
  },
  {
    phase: 2,
    title: "预备能力",
    steps: ["ontology-setup"], // github-auth is integrated into ontology-setup
    autoAdvanceSteps: new Set([]),
  },
  {
    phase: 3,
    title: "空间与模型",
    steps: ["create-space", "ai-provider"],
    autoAdvanceSteps: new Set([]),
  },
  {
    phase: 4,
    title: "启动",
    steps: ["done"],
    autoAdvanceSteps: new Set([]),
  },
]

export function getPhaseForStep(step: OnboardingStepName | "done" | string): PhaseConfig {
  if (step === "star-guide") {
    return PHASE_CONFIGS[3] // Phase 4
  }
  if (step === "install-wopal-cli" || step === "install-ellamaka-cli") {
    return PHASE_CONFIGS[0] // Phase 1
  }
  for (const config of PHASE_CONFIGS) {
    if (config.steps.includes(step as any)) {
      return config
    }
  }
  return PHASE_CONFIGS[0]
}

export interface StepMetadata {
  title: string
  description: string
  optional: boolean
  content?: StepContent
}

export const STEP_METADATA: Record<OnboardingStepName | "done" | string, StepMetadata> = {
  "system-check": {
    title: zhCN.steps["system-check"].title,
    description: zhCN.steps["system-check"].goal,
    optional: false,
    content: zhCN.steps["system-check"],
  },
  "install-cli": {
    title: zhCN.steps["install-cli"].title,
    description: zhCN.steps["install-cli"].goal,
    optional: false,
    content: zhCN.steps["install-cli"],
  },
  "install-wopal-cli": {
    title: zhCN.steps["install-wopal-cli"].title,
    description: zhCN.steps["install-wopal-cli"].goal,
    optional: false,
    content: zhCN.steps["install-wopal-cli"],
  },
  "install-ellamaka-cli": {
    title: zhCN.steps["install-ellamaka-cli"].title,
    description: zhCN.steps["install-ellamaka-cli"].goal,
    optional: false,
    content: zhCN.steps["install-ellamaka-cli"],
  },
  "ai-provider": {
    title: zhCN.steps["ai-provider"].title,
    description: zhCN.steps["ai-provider"].goal,
    optional: true,
    content: zhCN.steps["ai-provider"],
  },
  "ontology-setup": {
    title: zhCN.steps["ontology-setup"].title,
    description: zhCN.steps["ontology-setup"].goal,
    optional: false,
    content: zhCN.steps["ontology-setup"],
  },
  "create-space": {
    title: zhCN.steps["create-space"].title,
    description: zhCN.steps["create-space"].goal,
    optional: false,
    content: zhCN.steps["create-space"],
  },
  "star-guide": {
    title: zhCN.steps["star-guide"].title,
    description: zhCN.steps["star-guide"].goal,
    optional: true,
    content: zhCN.steps["star-guide"],
  },
  done: {
    title: zhCN.steps.done.title,
    description: zhCN.steps.done.goal,
    optional: false,
    content: zhCN.steps.done,
  },
}

export function getStepMetadata(step: OnboardingStepName | "done" | string): StepMetadata {
  return STEP_METADATA[step] ?? { title: String(step), description: "", optional: false }
}

export function getStepContent(step: OnboardingStepName | "done" | string): StepContent | undefined {
  return STEP_METADATA[step]?.content
}

export type ForwardMode = "submit" | "advance" | "disabled"
export type FeedbackMode = "idle" | "working" | "error" | "hidden"

const EXPLICIT_ACTION_STEPS = new Set<OnboardingStepName>([
  "ai-provider",
  "ontology-setup",
  "create-space",
])

export function isExplicitActionStep(step: OnboardingStepName | "done" | string): boolean {
  return step !== "done" && EXPLICIT_ACTION_STEPS.has(step as any)
}

export function resolveFeedbackMode(input: {
  hasError: boolean
  working: boolean
  success: boolean | undefined
  showIdle?: boolean
}): FeedbackMode {
  if (input.hasError) return "error"
  if (input.working) return "working"
  if (input.success !== undefined) return "hidden"
  if (input.showIdle === false) return "hidden"
  return "idle"
}

export function resolveForwardMode(input: {
  done: boolean
  working: boolean
  success: boolean | undefined
  submitFromNavigation?: boolean
}): ForwardMode {
  if (input.done || input.working || input.success === false) return "disabled"
  if (input.success) return "advance"
  return input.submitFromNavigation === false ? "disabled" : "submit"
}

export function isRetryActionVisible(
  step: OnboardingStepName | "done",
  input: { working: boolean; success: boolean | undefined },
): boolean {
  return step !== "done" && !input.working && input.success === false
}

/**
 * Decide which step to open when the wizard mounts against a server state.
 *
 * A run that already reached `completed: true` is finished: the design
 * contract hands such a user to the Workbench, so re-entering `/onboarding`
 * must land on `done` (which carries the health-gated launch action) rather
 * than rendering an empty stage 1 that looks like nothing ever happened.
 *
 * Otherwise the saved step is resumed as-is — including `done`, which is a
 * legitimate resting place while `completed` is still false (the user reached
 * the launch page but has not passed the health gate yet). A missing or
 * unrecognised step starts a fresh run at `system-check`.
 */
export function resolveRestoreTarget(
  state: { completed?: boolean; currentStep?: string } | null | undefined,
): OnboardingStepName | "done" {
  if (state?.completed) return "done"
  const saved = state?.currentStep
  if (!saved) return "system-check"
  return ONBOARDING_STEPS.find((step) => step === saved) ?? "system-check"
}

export function createStepController(initialStep: OnboardingStepName | "done" | string = "system-check") {
  let currentStep: OnboardingStepName | "done" = (initialStep === "star-guide" ? "done" : initialStep === "install-wopal-cli" || initialStep === "install-ellamaka-cli" ? "install-cli" : initialStep) as OnboardingStepName | "done"

  return {
    getCurrentStep: () => currentStep,
    setCurrentStep: (step: OnboardingStepName | "done" | string) => {
      const normalized = step === "star-guide" ? "done" : (step === "install-wopal-cli" || step === "install-ellamaka-cli" ? "install-cli" : step)
      currentStep = normalized as OnboardingStepName | "done"
    },
    getProgressPercent: () => {
      if (currentStep === "done") return 100
      const phase = getPhaseForStep(currentStep)
      return Math.round((phase.phase / 4) * 100)
    },
    next: () => {
      if (currentStep === "done") return
      const idx = ONBOARDING_STEPS.indexOf(currentStep as OnboardingStepName)
      if (idx !== -1 && idx < ONBOARDING_STEPS.length - 1) {
        currentStep = ONBOARDING_STEPS[idx + 1]
      } else {
        currentStep = "done"
      }
    },
    prev: () => {
      if (currentStep === "done") {
        currentStep = "ai-provider"
        return
      }
      const idx = ONBOARDING_STEPS.indexOf(currentStep as OnboardingStepName)
      if (idx > 0) {
        currentStep = ONBOARDING_STEPS[idx - 1]
      }
    },
    skip: (context?: StepContext) => {
      if (currentStep !== "done" && isOptionalStep(currentStep as OnboardingStepName, context)) {
        const idx = ONBOARDING_STEPS.indexOf(currentStep as OnboardingStepName)
        if (idx !== -1 && idx < ONBOARDING_STEPS.length - 1) {
          let nextStep = ONBOARDING_STEPS[idx + 1]
          currentStep = nextStep
        } else {
          currentStep = "done"
        }
      }
    },
  }
}
