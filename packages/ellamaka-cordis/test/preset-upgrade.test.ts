import { describe, expect, test } from "bun:test"
import { upgradePresetPlugins } from "../src/plugins/preset-import"

describe("legacy preset compatibility", () => {
  test("retains persona and permissions while upgrading owned service isolation and workflow", () => {
    const original = [
      { id: "persona", name: "@deepseek-ai/dsh-persona", config: { text: "Original persona" } },
      {
        id: "planning",
        name: "cordis:group",
        group: true,
        config: [{ id: "plan-mode", name: "@deepseek-ai/dsh-plan-mode" }],
      },
      {
        id: "delegation",
        name: "cordis:group",
        group: true,
        config: [
          {
            id: "workflow-worker-thread",
            name: "@deepseek-ai/dsh-workflow-worker-thread",
            config: { provider: "spawn" },
          },
          { id: "child", name: "@deepseek-ai/dsh-tool-subagent", config: { toolFilter: { allow: ["read"] } } },
        ],
      },
    ]
    const result = upgradePresetPlugins(original)
    expect(result[0]).toEqual({ ...original[0], config: { prefix: "Original persona" } })
    expect(result[1]).toMatchObject({ isolate: { planMode: true } })
    expect(result[2]).toMatchObject({
      isolate: { workflowEngine: true },
      config: [
        { id: "workflow-ptc", name: "@deepseek-ai/dsh-workflow-ptc", config: { provider: "spawn" } },
        original[2].config![1],
      ],
    })
    expect(original[2].config![0]?.name).toBe("@deepseek-ai/dsh-workflow-worker-thread")
  })
})
