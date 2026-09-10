import { describe, expect, test } from "bun:test"
import { resolveServerList, seedStoredServers, ServerConnection } from "./server"

describe("seedStoredServers", () => {
  test("persists a props server that carries credentials", () => {
    const seeded = seedStoredServers({
      stored: [],
      props: [
        {
          type: "http",
          authToken: true,
          http: { url: "http://localhost:4098", username: "ellamaka", password: "123" },
        },
      ],
    })
    expect(seeded).toEqual([
      { type: "http", http: { url: "http://localhost:4098", username: "ellamaka", password: "123" } },
    ])
  })

  test("does not persist a credential-less props server", () => {
    const seeded = seedStoredServers({
      stored: [],
      props: [{ type: "http", http: { url: "http://localhost:4098" } }],
    })
    expect(seeded).toEqual([])
  })

  test("updates an existing stored entry when the seeded credentials differ", () => {
    const seeded = seedStoredServers({
      stored: [{ url: "http://localhost:4098", username: "ellamaka", password: "old" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: { url: "http://localhost:4098", username: "ellamaka", password: "new" },
        },
      ],
    })
    expect(seeded).toEqual([
      { type: "http", http: { url: "http://localhost:4098", username: "ellamaka", password: "new" } },
    ])
  })

  test("keeps unrelated stored entries untouched", () => {
    const seeded = seedStoredServers({
      stored: [{ url: "https://remote.example.test", password: "other" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: { url: "http://localhost:4098", password: "123" },
        },
      ],
    })
    expect(seeded).toEqual([
      { url: "https://remote.example.test", password: "other" },
      { type: "http", http: { url: "http://localhost:4098", password: "123" } },
    ])
  })

  test("round-trips through resolveServerList: a later credential-less prop keeps the stored password", () => {
    const seeded = seedStoredServers({
      stored: [],
      props: [
        {
          type: "http",
          authToken: true,
          http: { url: "http://localhost:4098", username: "ellamaka", password: "123" },
        },
      ],
    })
    // Refresh: entry.tsx builds the server WITHOUT credentials (no auth_token
    // in the URL), the provider seeds from the persisted store — the merged
    // view must still carry the saved password.
    const list = resolveServerList({
      stored: seeded,
      props: [{ type: "http", http: { url: "http://localhost:4098" } }],
    })
    expect(list[0]?.type === "http" ? list[0].http.password : undefined).toBe("123")
  })
})
