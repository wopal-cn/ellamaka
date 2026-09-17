import { describe, expect, test } from "bun:test"
import { AI_SUBSCRIPTION_PLANS } from "./ai-subscription-plans"

describe("AI subscription plans", () => {
  test("offers only OpenCode Go during onboarding", () => {
    expect(AI_SUBSCRIPTION_PLANS).toHaveLength(1)
    expect(AI_SUBSCRIPTION_PLANS[0]).toMatchObject({
      id: "opencode-go",
      providerId: "opencode-go",
      name: "OpenCode Go",
      introductoryPriceUsd: 5,
      monthlyPriceUsd: 10,
    })
  })
})
