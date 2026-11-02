import { expect, test } from "bun:test"
import { buildSessionPort, probePtyRequest, type SessionServerSDK } from "./workbench-actions-ports"
import { createSessionProjection } from "./session-store"

const globalClient = {
  global: { session: { get: async () => ({ data: { id: "unused", directory: "", time: { created: 1 } } }) } },
}

test("restores session metadata without activating the stale directory", async () => {
  const projection = createSessionProjection()
  const sdk: SessionServerSDK = {
    client: {
      global: {
        session: { get: async () => ({ data: { id: "s1", directory: "/real/project", time: { created: 1 } } }) },
      },
    },
    bff: { workbench: { createSession: async () => ({ data: { directory: "" } }) } },
    createClient: () => {
      throw new Error("instance client must not be used for restore")
    },
  }
  const port = buildSessionPort(sdk, projection.reader, projection.writer)
  const session = await port.get({
    scope: { kind: "space", name: "A", path: "/alias" },
    sessionID: "s1",
    directory: "/old/project",
  })
  expect(session.directory).toBe("/real/project")
})

test("creates a session when crypto.randomUUID is unavailable (insecure context)", async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")
  const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext")
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} })
  const restore = () => {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor)
    else delete (globalThis as { crypto?: unknown }).crypto
    if (secureDescriptor) Object.defineProperty(globalThis, "isSecureContext", secureDescriptor)
    else delete (globalThis as { isSecureContext?: boolean }).isSecureContext
  }

  try {
    const projection = createSessionProjection()
    const requests: unknown[] = []
    const serverSDK: SessionServerSDK = {
      client: globalClient,
      bff: {
        workbench: {
          createSession: async (input) => {
            requests.push(input)
            return { data: { id: "session-created", directory: "", timeCreated: 1, timeUpdated: 1 } }
          },
        },
      },
      createClient: () => ({
        session: {
          get: async () => ({ data: { id: "unused", directory: "", time: { created: 1 } } }),
          update: async () => {},
          delete: async () => {},
        },
      }),
    }
    const port = buildSessionPort(serverSDK, projection.reader, projection.writer)

    const session = await port.create({
      scope: { kind: "general" },
      panel: { id: "p-1", slotState: "empty", mode: "", directory: "", width: 1 },
      initialView: "chat",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ requestID: expect.any(String) })
    expect(session.id).toBe("session-created")
  } finally {
    restore()
  }
})

test("renaming a session patches the projection without invalidating the tree", async () => {
  const projection = createSessionProjection()
  projection.writer.upsert({
    id: "session-1",
    spaceName: "General",
    projectPath: "",
    type: "chat",
    title: "Before",
    directoryHealth: "healthy",
    createdAt: 1,
    lastActiveAt: 1,
  })
  const updates: Array<{ sessionID: string; title: string }> = []
  const serverSDK: SessionServerSDK = {
    client: globalClient,
    bff: {
      workbench: {
        createSession: async () => ({ data: { id: "unused", directory: "", timeCreated: 1, timeUpdated: 1 } }),
      },
    },
    createClient: () => ({
      session: {
        get: async () => ({ data: { id: "unused", directory: "", time: { created: 1 } } }),
        update: async (input) => {
          updates.push(input)
        },
        delete: async () => {},
      },
    }),
  }
  const port = buildSessionPort(serverSDK, projection.reader, projection.writer)

  await port.rename({
    scope: { kind: "general" },
    sessionID: "session-1",
    directory: "",
    title: "After",
  })

  expect(updates).toEqual([{ sessionID: "session-1", title: "After" }])
  expect(projection.reader.getSession("session-1")?.title).toBe("After")
  expect(projection.reader.refreshKey()).toBe(0)
})

test("creates a Space session with a request ID and canonical relative directory", async () => {
  const projection = createSessionProjection()
  const requests: unknown[] = []
  const serverSDK: SessionServerSDK = {
    client: globalClient,
    bff: {
      workbench: {
        createSession: async (input) => {
          requests.push(input)
          return {
            data: { id: "session-created", directory: "/fixtures/space-a/project", timeCreated: 1, timeUpdated: 1 },
          }
        },
      },
    },
    createClient: () => ({
      session: {
        get: async () => ({ data: { id: "unused", directory: "", time: { created: 1 } } }),
        update: async () => {},
        delete: async () => {},
      },
    }),
  }
  const port = buildSessionPort(serverSDK, projection.reader, projection.writer)

  const session = await port.create({
    scope: { kind: "space", name: "Same name", path: "/alias/space-a" },
    panel: {
      id: "p-1",
      slotState: "empty",
      mode: "",
      directory: "/fixtures/space-a/project",
      width: 1,
    },
    initialView: "tui",
    relativeDirectory: "project",
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    requestID: expect.any(String),
    target: { type: "space", spacePath: "/alias/space-a", directory: "project" },
  })
  expect(session.type).toBe("tui")
})

test("distinguishes a missing PTY from a transient probe transport failure", async () => {
  const results = [
    { response: { status: 404 } },
    new TypeError("Failed to fetch"),
    { response: { status: 200 } },
    { response: { status: 503 } },
  ]
  const request = async () => {
    const result = results.shift()
    if (result instanceof Error) throw result
    if (!result) throw new Error("missing fixture result")
    return result
  }

  expect(await probePtyRequest(request)).toBe("dead")
  expect(await probePtyRequest(request)).toBe("unknown")
  expect(await probePtyRequest(request)).toBe("alive")
  expect(await probePtyRequest(request)).toBe("unknown")
})
