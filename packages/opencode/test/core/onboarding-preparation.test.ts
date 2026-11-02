import { describe, expect, test } from "bun:test"
import { prepareOnboardingRuntime } from "@/core/onboarding-preparation"
import type { DshHostPreparationOptions } from "@/core/preparation"
import { getDshStatus, setDshStatus } from "@/workbench/dsh-status"

describe("onboarding runtime preparation", () => {
  for (const [web, tools] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    test(`respects Web=${web} and Tools=${tools}`, async () => {
      const profiles = [...(web ? (["web"] as const) : []), ...(tools ? (["ellamaka-tools"] as const) : [])]
      let requested: DshHostPreparationOptions["profiles"]
      let storagePrepared = false
      const result = await prepareOnboardingRuntime("/isolated", {
        ensureStorage: async () => {
          storagePrepared = true
          return { databaseCreated: true as const }
        },
        resolveIntent: async () => ({ web, tools, profiles }),
        prepare: async (options) => {
          requested = options.profiles
          return {
            web: { status: web ? "prepared" : "disabled" },
            tools: { status: tools ? "prepared" : "disabled" },
          }
        },
      })
      expect(storagePrepared).toBe(true)
      expect(requested).toEqual(profiles)
      expect(result.status).toBe(web || tools ? "ready" : "disabled")
    })
  }

  test("re-entry preparation has no authority to change active profile state", async () => {
    setDshStatus("web", "ready")
    setDshStatus("tools", "degraded")
    try {
      const result = await prepareOnboardingRuntime("/isolated", {
        ensureStorage: async () => ({ databaseCreated: false as const }),
        resolveIntent: async () => ({ web: true, tools: true, profiles: ["web", "ellamaka-tools"] }),
        prepare: async () => ({
          web: { status: "prepared" },
          tools: { status: "prepared" },
        }),
      })

      expect(result.status).toBe("ready")
      expect(getDshStatus()).toEqual({ web: "ready", tools: "degraded" })
    } finally {
      setDshStatus("web", "disabled")
      setDshStatus("tools", "disabled")
    }
  })
})
