import { describe, expect, test } from "bun:test"
import {
  createStepController,
  getStepMetadata,
  isExplicitActionStep,
  isOptionalStep,
  isRetryActionVisible,
  ONBOARDING_STEPS,
  resolveFeedbackMode,
  resolveForwardMode,
  resolveRestoreTarget,
} from "./step-controller"

describe("step-controller", () => {
  test("ONBOARDING_STEPS contains 6 steps in order", () => {
    expect(ONBOARDING_STEPS.length).toBe(6)
    expect(ONBOARDING_STEPS[0]).toBe("system-check")
    expect(ONBOARDING_STEPS[1]).toBe("install-cli")
    expect(ONBOARDING_STEPS[2]).toBe("ontology-setup")
    expect(ONBOARDING_STEPS[3]).toBe("create-space")
    expect(ONBOARDING_STEPS[4]).toBe("ai-provider")
    expect(ONBOARDING_STEPS[5]).toBe("done")
  })

  test("isOptionalStep correctly identifies optional steps", () => {
    expect(isOptionalStep("ai-provider")).toBe(true)
    expect(isOptionalStep("create-space")).toBe(false)
    expect(isOptionalStep("create-space", { hasExistingSpaces: true })).toBe(true)
    expect(isOptionalStep("system-check")).toBe(false)
    expect(isOptionalStep("install-cli")).toBe(false)
  })

  test("stepController handles next/prev/skip navigation", () => {
    const controller = createStepController("system-check")

    expect(controller.getCurrentStep()).toBe("system-check")
    expect(controller.getProgressPercent()).toBe(25)

    controller.next()
    expect(controller.getCurrentStep()).toBe("install-cli")

    controller.skip() // install-cli is not optional, stays at install-cli
    expect(controller.getCurrentStep()).toBe("install-cli")
  })

  test("stepController walks the six-step journey and returns from done", () => {
    const controller = createStepController("ontology-setup")

    expect(controller.getProgressPercent()).toBe(50)
    controller.next()
    expect(controller.getCurrentStep()).toBe("create-space")
    controller.next()
    expect(controller.getCurrentStep()).toBe("ai-provider")
    controller.next()
    expect(controller.getCurrentStep()).toBe("done")
    expect(controller.getProgressPercent()).toBe(100)

    controller.prev()
    expect(controller.getCurrentStep()).toBe("ai-provider")
  })

  test("getStepMetadata returns valid title and description for steps", () => {
    const meta = getStepMetadata("system-check")
    expect(meta.title).toBeDefined()
    expect(meta.description).toBeDefined()
  })

  test("resolveForwardMode never resubmits a successful step", () => {
    expect(resolveForwardMode({ done: false, working: false, success: undefined })).toBe("submit")
    expect(resolveForwardMode({ done: false, working: false, success: undefined, submitFromNavigation: false })).toBe("disabled")
    expect(resolveForwardMode({ done: false, working: false, success: true })).toBe("advance")
    expect(resolveForwardMode({ done: false, working: false, success: false })).toBe("disabled")
    expect(resolveForwardMode({ done: false, working: true, success: undefined })).toBe("disabled")
    expect(resolveForwardMode({ done: true, working: false, success: true })).toBe("disabled")
  })

  test("credential steps require an explicit action before navigation", () => {
    expect(isExplicitActionStep("ai-provider")).toBe(true)
    expect(isExplicitActionStep("ontology-setup")).toBe(true)
    expect(isExplicitActionStep("create-space")).toBe(true)
    expect(isExplicitActionStep("system-check")).toBe(false)
  })

  test("resolveFeedbackMode hides redundant completion feedback", () => {
    expect(resolveFeedbackMode({ hasError: false, working: false, success: undefined })).toBe("idle")
    expect(resolveFeedbackMode({ hasError: false, working: false, success: undefined, showIdle: false })).toBe("hidden")
    expect(resolveFeedbackMode({ hasError: false, working: true, success: undefined })).toBe("working")
    expect(resolveFeedbackMode({ hasError: true, working: false, success: false })).toBe("error")
    expect(resolveFeedbackMode({ hasError: false, working: false, success: true })).toBe("hidden")
  })

  test("failed CLI installation exposes retry in the bottom action bar", () => {
    expect(isRetryActionVisible("install-cli", { working: false, success: false })).toBe(true)
    expect(isRetryActionVisible("install-cli", { working: true, success: false })).toBe(false)
    expect(isRetryActionVisible("install-cli", { working: false, success: true })).toBe(false)
    expect(isRetryActionVisible("done", { working: false, success: false })).toBe(false)
  })
})

describe("resolveRestoreTarget", () => {
  test("a completed run lands on the done step instead of the first step", () => {
    // The design contract: once `completed === true` the wizard is finished,
    // so re-entering it must not present an empty stage 1 as if nothing had
    // ever run (DESIGN-onboarding.md "completed === true → 进入 Workbench").
    expect(resolveRestoreTarget({ completed: true, currentStep: "done" })).toBe("done")
    expect(resolveRestoreTarget({ completed: true, currentStep: "system-check" })).toBe("done")
  })

  test("an unfinished run resumes at its saved step", () => {
    expect(resolveRestoreTarget({ completed: false, currentStep: "ontology-setup" })).toBe("ontology-setup")
    expect(resolveRestoreTarget({ completed: false, currentStep: "install-cli" })).toBe("install-cli")
  })

  test("done is a legitimate resting place until the health gate passes", () => {
    // The user reached the launch page but has not completed: they must land
    // back on `done` so the launch action is still there to retry from.
    expect(resolveRestoreTarget({ completed: false, currentStep: "done" })).toBe("done")
  })

  test("a fresh run falls back to the first step", () => {
    expect(resolveRestoreTarget({ completed: false, currentStep: "system-check" })).toBe("system-check")
    expect(resolveRestoreTarget(null)).toBe("system-check")
    expect(resolveRestoreTarget(undefined)).toBe("system-check")
    expect(resolveRestoreTarget({ completed: false })).toBe("system-check")
  })

  test("an unrecognised saved step falls back instead of leaking through", () => {
    expect(resolveRestoreTarget({ completed: false, currentStep: "memory-config" })).toBe("system-check")
    expect(resolveRestoreTarget({ completed: false, currentStep: "star-guide" })).toBe("system-check")
  })
})
