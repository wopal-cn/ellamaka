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
} from "./step-controller"

describe("step-controller", () => {
  test("ONBOARDING_STEPS contains 7 steps in order", () => {
    expect(ONBOARDING_STEPS.length).toBe(7)
    expect(ONBOARDING_STEPS[0]).toBe("system-check")
    expect(ONBOARDING_STEPS[1]).toBe("install-cli")
    expect(ONBOARDING_STEPS[2]).toBe("ontology-setup")
    expect(ONBOARDING_STEPS[3]).toBe("create-space")
    expect(ONBOARDING_STEPS[4]).toBe("ai-provider")
    expect(ONBOARDING_STEPS[5]).toBe("memory-config")
    expect(ONBOARDING_STEPS[6]).toBe("done")
  })

  test("isOptionalStep correctly identifies optional steps", () => {
    expect(isOptionalStep("ai-provider")).toBe(true)
    expect(isOptionalStep("memory-config")).toBe(true)
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
    expect(isExplicitActionStep("memory-config")).toBe(true)
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
