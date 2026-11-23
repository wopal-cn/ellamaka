import { describe, expect, test } from "bun:test"
import { normalizeServerSelection, resolveServerList, resolveStartupServerSelection, ServerConnection } from "./server"

describe("resolveServerList", () => {
  test("lets startup auth_token credentials override a persisted same-url server", () => {
    const list = resolveServerList({
      stored: [{ url: "https://server.example.test" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: {
            url: "https://server.example.test",
            username: "opencode",
            password: "secret",
          },
        },
      ],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "secret",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : false).toBe(true)
    expect(ServerConnection.key(list[0]!) as string).toBe("https://server.example.test")
  })

  test("keeps persisted credentials when startup has no auth_token", () => {
    const list = resolveServerList({
      stored: [
        {
          url: "https://server.example.test",
          username: "opencode",
          password: "saved",
        },
      ],
      props: [{ type: "http", http: { url: "https://server.example.test" } }],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "saved",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : true).toBeUndefined()
  })
})

describe("server selection persistence", () => {
  const fallback = ServerConnection.Key.make("sidecar")
  const local = {
    type: "sidecar" as const,
    variant: "base" as const,
    generation: 4,
    http: { url: "http://127.0.0.1:4096" },
  }
  const spark = {
    type: "http" as const,
    http: { url: "https://spark.example.test" },
  }

  test("restores an available saved remote server", () => {
    const saved = ServerConnection.key(spark)
    expect(resolveStartupServerSelection({ fallback, saved, servers: [local, spark] })).toEqual({
      active: saved,
      restoringSavedSelection: true,
      persistFallback: false,
    })
  })

  test("replaces a missing saved server with the local fallback", () => {
    expect(
      resolveStartupServerSelection({
        fallback,
        saved: ServerConnection.Key.make("https://removed.example.test"),
        servers: [local],
      }),
    ).toEqual({
      active: fallback,
      restoringSavedSelection: false,
      persistFallback: true,
    })
  })

  test("stores the stable sidecar key instead of its generation-specific URL", () => {
    expect(normalizeServerSelection({ fallback, key: ServerConnection.key(local), servers: [local, spark] })).toBe(
      fallback,
    )
  })
})
