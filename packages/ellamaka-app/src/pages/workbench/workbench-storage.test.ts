import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  LEGACY_WORKBENCH_STORAGE_NAME,
  WORKBENCH_STORAGE_MIGRATION_NAME,
  prepareWorkbenchStorage,
  workbenchStorageName,
} from "./workbench-storage"

class MemoryStorage implements Storage {
  private data = new Map<string, string>()

  get length() {
    return this.data.size
  }

  clear() {
    this.data.clear()
  }

  getItem(key: string) {
    return this.data.get(key) ?? null
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.data.delete(key)
  }

  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}

const http = (url: string): ServerConnection.Http => ({ type: "http", http: { url } })

describe("workbench server storage", () => {
  test("isolates HTTP servers while preserving a sidecar across generations", () => {
    expect(workbenchStorageName(http("http://ellamac:4096"))).not.toBe(workbenchStorageName(http("http://spark:4096")))

    const first: ServerConnection.Sidecar = {
      type: "sidecar",
      variant: "base",
      generation: 1,
      http: { url: "http://127.0.0.1:51001" },
    }
    const restarted: ServerConnection.Sidecar = {
      ...first,
      generation: 2,
      http: { url: "http://127.0.0.1:51002" },
    }
    expect(workbenchStorageName(first)).toBe(workbenchStorageName(restarted))
  })

  test("uses the SSH host instead of its changing HTTP proxy", () => {
    const first: ServerConnection.Ssh = {
      type: "ssh",
      host: "spark",
      http: { url: "http://127.0.0.1:52001" },
    }
    const reconnected: ServerConnection.Ssh = {
      ...first,
      http: { url: "http://127.0.0.1:52002" },
    }
    expect(workbenchStorageName(first)).toBe(workbenchStorageName(reconnected))
  })

  test("migrates the legacy layout to only the first server", () => {
    const storage = new MemoryStorage()
    const legacy = JSON.stringify({ schemaVersion: 2, tabs: ["legacy"] })
    storage.setItem(LEGACY_WORKBENCH_STORAGE_NAME, legacy)

    const ellamac = prepareWorkbenchStorage(storage, http("http://ellamac:4096"))
    const spark = prepareWorkbenchStorage(storage, http("http://spark:4096"))

    expect(storage.getItem(ellamac)).toBe(legacy)
    expect(storage.getItem(spark)).toBeNull()
    expect(storage.getItem(WORKBENCH_STORAGE_MIGRATION_NAME)).toBe(ellamac)
    expect(storage.getItem(LEGACY_WORKBENCH_STORAGE_NAME)).toBe(legacy)
  })

  test("does not overwrite an existing server layout during migration", () => {
    const storage = new MemoryStorage()
    const server = http("http://ellamac:4096")
    const name = workbenchStorageName(server)
    storage.setItem(LEGACY_WORKBENCH_STORAGE_NAME, "legacy")
    storage.setItem(name, "current")

    prepareWorkbenchStorage(storage, server)

    expect(storage.getItem(name)).toBe("current")
    expect(storage.getItem(WORKBENCH_STORAGE_MIGRATION_NAME)).toBe(name)
  })
})
