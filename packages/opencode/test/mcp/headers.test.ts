import { describe, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

// The transport doubles are injected through the client factory instead of
// replacing the SDK modules. Bun module mocks are process-wide and are not
// undone by mock.restore(), so replacing the SDK here leaked these doubles into
// every test file that loaded later.
class MockStreamableHTTP {
  constructor(url?: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
    transportCalls.push({
      type: "streamable",
      url: url!.toString(),
      options: options ?? {},
    })
  }
  async start() {
    throw new Error("Mock transport cannot connect")
  }
}

class MockSSE {
  constructor(url?: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
    transportCalls.push({
      type: "sse",
      url: url!.toString(),
      options: options ?? {},
    })
  }
  async start() {
    throw new Error("Mock transport cannot connect")
  }
}

// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The SDK doubles stand in for
// concrete SDK classes that the engine constructs.
const mockClientFactory: MCPNS.ClientFactory = {
  createClient: () => ({}) as unknown as never,
  createStdioTransport: () => new MockSSE() as unknown as never,
  createStreamableTransport: (options) =>
    new MockStreamableHTTP(options.url, options.options as unknown as never) as unknown as never,
  createSseTransport: (options) => new MockSSE(options.url, options.options as unknown as never) as unknown as never,
  isUnauthorizedError: () => false,
}

beforeEach(() => {
  transportCalls.length = 0
})

// Import MCP after mocking
const { MCP } = await import("../../src/mcp/index")
const { McpAuth } = await import("../../src/mcp/auth")
const { Bus } = await import("../../src/bus")
const { Config } = await import("../../src/config/config")
const { AppFileSystem } = await import("@wopal/ellamaka-core/filesystem")
const { CrossSpawnSpawner } = await import("@wopal/ellamaka-core/cross-spawn-spawner")
const it = testEffect(
  MCP.layer.pipe(
    Layer.provide(Layer.succeed(MCP.ClientFactoryService, MCP.ClientFactoryService.of(mockClientFactory))),
    Layer.provide(McpAuth.defaultLayer),
    Layer.provideMerge(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
  ),
)

describe("mcp.headers", () => {
  it.instance("headers are passed to transports when oauth is enabled (default)", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server", {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer test-token",
            "X-Custom-Header": "custom-value",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      // Both transports should have been created with headers
      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
          "X-Custom-Header": "custom-value",
        })
        // OAuth should be enabled by default, so authProvider should exist
        expect(call.options.authProvider).toBeDefined()
      }
    }),
  )

  it.instance("headers are passed to transports when oauth is explicitly disabled", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-oauth", {
          type: "remote",
          url: "https://example.com/mcp",
          oauth: false,
          headers: {
            Authorization: "Bearer test-token",
          },
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        expect(call.options.requestInit).toBeDefined()
        expect(call.options.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
        // OAuth is disabled, so no authProvider
        expect(call.options.authProvider).toBeUndefined()
      }
    }),
  )

  it.instance("no requestInit when headers are not provided", () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp
        .add("test-server-no-headers", {
          type: "remote",
          url: "https://example.com/mcp",
        })
        .pipe(Effect.catch(() => Effect.void))

      expect(transportCalls.length).toBeGreaterThanOrEqual(1)

      for (const call of transportCalls) {
        // No headers means requestInit should be undefined
        expect(call.options.requestInit).toBeUndefined()
      }
    }),
  )
})
