import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@/plugin"
import { MessageID, SessionID } from "@/session/schema"
import { LLMRequestPrep } from "@/session/llm/request"
import { ProviderTest } from "../fake/provider"
import { it } from "../lib/effect"

describe("LLM request tool permissions", () => {
  it.effect("keeps tool visibility based on the agent plus session permission", () =>
    Effect.gen(function* () {
      const model = ProviderTest.model()
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the request test only needs the fields consumed by permission filtering
      const base = {
        user: {
          id: MessageID.make("msg_permission"),
          role: "user",
          model: { providerID: model.providerID, modelID: model.id },
          sessionID: SessionID.make("ses_permission"),
          agent: "build",
          time: { created: Date.now() },
          parts: [],
        },
        sessionID: SessionID.make("ses_permission"),
        model,
        agent: {
          name: "build",
          mode: "primary",
          permission: [
            { permission: "read", pattern: "*", action: "deny" },
            { permission: "edit", pattern: "*", action: "deny" },
          ],
          options: {},
        },
        system: [],
        messages: [],
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tool values are unused; only visibility keys are under test
        tools: { read: {} as never, edit: {} as never },
        provider: ProviderTest.info({}, model),
        auth: undefined,
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the request path only uses trigger, stubbed as a pass-through
        plugin: {
          trigger: (_name, _input, output) => Effect.succeed(output),
        } as Plugin.Interface,
        flags: { outputTokenMax: 10_000, client: "test" },
        isWorkflow: false,
      } as unknown as Parameters<typeof LLMRequestPrep.prepare>[0]

      const sessionA = yield* LLMRequestPrep.prepare({
        ...base,
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
      })
      const sessionB = yield* LLMRequestPrep.prepare({
        ...base,
        permission: [{ permission: "edit", pattern: "*", action: "allow" }],
      })
      const noOverlay = yield* LLMRequestPrep.prepare(base)

      expect(Object.keys(sessionA.tools)).toEqual(["read"])
      expect(Object.keys(sessionB.tools)).toEqual(["edit"])
      expect(Object.keys(noOverlay.tools)).toEqual([])
    }),
  )
})
