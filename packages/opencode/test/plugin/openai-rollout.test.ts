import { describe, expect, test } from "bun:test"
import { experimentalWebSocketsEnabled } from "../../src/plugin"

describe("plugin.openai.websocket rollout", () => {
  test("enables websockets by default only on development channels", () => {
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "local" })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "main" })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "beta" })).toBe(false)
    expect(experimentalWebSocketsEnabled({ enabled: false, channel: "stable" })).toBe(false)
  })

  test("allows releases to opt in through the experimental flag", () => {
    expect(experimentalWebSocketsEnabled({ enabled: true, channel: "stable" })).toBe(true)
    expect(experimentalWebSocketsEnabled({ enabled: true, channel: "beta" })).toBe(true)
  })
})
