import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import type { NormalizedProviderListResponse } from "@wopal/ui/context"
import type { State } from "./types"
import type { QueryOptionsApi } from "../server-sync"

let createChildStoreManager: typeof import("./child-store").createChildStoreManager
const queryGroups: Array<() => { queries: Array<{ enabled?: boolean }> }> = []
const mcpQueries: Array<() => { enabled?: boolean }> = []

const child = () => createStore({} as State)
const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

const queryOptionsApi = {
  globalConfig: () => ({ queryKey: ["globalConfig"], queryFn: async () => ({}) }),
  projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  providers: (directory: string | null) => ({ queryKey: [directory, "providers"], queryFn: async () => provider }),
  path: (directory: string | null) => ({
    queryKey: [directory, "path"],
    queryFn: async () => ({
      state: "",
      config: "",
      worktree: "",
      directory: directory ?? "",
      home: "",
    }),
  }),
  agents: (directory: string) => ({ queryKey: [directory, "agents"], queryFn: async () => [] }),
  mcp: (directory: string) => ({ queryKey: [directory, "mcp"], queryFn: async () => ({}) }),
  lsp: (directory: string) => ({ queryKey: [directory, "lsp"], queryFn: async () => [] }),
  sessions: (directory: string) => ({ queryKey: [directory, "loadSessions"] as const }),
} as unknown as QueryOptionsApi

function createOwner(callback: (owner: Owner) => void) {
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    callback(owner)

    return dispose
  })
}

beforeAll(async () => {
  mock.module("@/utils/persist", () => ({
    Persist: {
      workspace: (...parts: string[]) => parts.join(":"),
    },
    persisted: (_target: string, store: unknown[]) => [store[0], store[1], null, () => true],
  }))
  mock.module("@tanstack/solid-query", () => ({
    useQueries: (options: () => { queries: Array<{ enabled?: boolean }> }) => {
      queryGroups.push(options)
      return [
        { isLoading: false, data: { state: "", config: "", worktree: "", directory: "", home: "" } },
        { isLoading: false, data: [] },
        { isLoading: false, data: provider },
      ]
    },
    useQuery: (options: () => { enabled?: boolean }) => {
      mcpQueries.push(options)
      return { isLoading: false, data: {} }
    },
  }))

  createChildStoreManager = (await import("./child-store")).createChildStoreManager
})

describe("child store provider catalog", () => {
  test("a fresh child store exposes provider_ready as false until bootstrap publishes the catalog", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store] = manager.child("/project", { bootstrap: false })

      // Before the Workbench lazy-instances change, provider_ready was derived
      // from the query observer (!isLoading) which reports true for a disabled
      // query that never fetched — consumers then read an EMPTY catalog and
      // showed "no models" even after bootstrap filled the cache. The store
      // must start cold and only flip ready when bootstrap publishes data.
      expect(store.provider_ready).toBe(false)
      expect(store.provider.all.size).toBe(0)
    } finally {
      dispose()
    }
  })
})
