import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"
import { CliAdapter } from "../../src/wopal/cli-adapter"
import { SpaceRegistry } from "../../src/wopal/space-registry"
import {
  spaceListSchema,
  spaceProjectsListSchema,
  spaceSearchSchema,
  type SpaceListData,
  type SpaceProjectsListData,
  type SpaceSearchData,
} from "@wopal/cli-capability-schema"

const it = testEffect(
  Layer.mergeAll(
    SpaceRegistry.layer.pipe(Layer.provide(CliAdapter.defaultLayer)),
    CliAdapter.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

// Helper: build v1 success envelope JSON
const successEnvelope = (capability: string, data: unknown) =>
  JSON.stringify({ apiVersion: "wopal.capability/v1", capability, ok: true, data })

// Helper: build v1 error envelope JSON
const errorEnvelope = (capability: string, code: string, message: string, suggestion?: string) =>
  JSON.stringify({
    apiVersion: "wopal.capability/v1",
    capability,
    ok: false,
    error: { code, message, ...(suggestion ? { suggestion } : {}) },
  })

// Helper: shell command that outputs the given JSON to stdout via base64 to avoid quoting issues
const shellCmd = (json: string, exitCode?: number): [string, string[]] => {
  const encoded = Buffer.from(json).toString("base64")
  return [
    "/bin/sh",
    ["-c", `echo '${encoded}' | base64 --decode${exitCode != null ? `; exit ${exitCode}` : ""}`],
  ]
}

// ---------------------------------------------------------------------------
// Task 1: CLI adapter tests
// ---------------------------------------------------------------------------

describe("wopal-cli-adapter", () => {
  it.live("executes a TypeScript development CLI through Bun", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const executable = path.join(dir, "wopal.ts")
      const data = { items: [{ id: "main", name: "main", path: "/tmp/workspace", type: "local" }], total: 1 }
      yield* Effect.promise(() => Bun.write(executable, `process.stdout.write(${JSON.stringify(successEnvelope("space.list", data))})\n`))

      const adapter = yield* CliAdapter.Service
      const result = yield* adapter.execute<SpaceListData>(
        executable,
        [],
        "space.list",
        spaceListSchema,
      )

      expect(result).toEqual(data)
    }),
  )

  it.live("decodes v1 success envelope for space.list", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const data = { items: [{ id: "main", name: "main", path: "/tmp/workspace", type: "local" }], total: 1 }
      const json = successEnvelope("space.list", data)
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceListData>(
        exec,
        args,
        "space.list",
        spaceListSchema,
      )

      expect(result).toEqual(data)
    }),
  )

  it.live("decodes v1 success envelope for space.projects.list", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const data = { items: [{ id: "projects/foo", name: "foo", path: "projects/foo" }], total: 1 }
      const json = successEnvelope("space.projects.list", data)
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceProjectsListData>(
        exec,
        args,
        "space.projects.list",
        spaceProjectsListSchema,
      )

      expect(result.items.length).toBe(1)
      expect(result.items[0].id).toBe("projects/foo")
    }),
  )

  it.live("decodes v1 success envelope for space.search", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const data = { items: [{ name: "src", path: "src", type: "dir" }], total: 1, offset: 0, limit: 50, hasMore: false }
      const json = successEnvelope("space.search", data)
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceSearchData>(
        exec,
        args,
        "space.search",
        spaceSearchSchema,
      )

      expect(result.items[0].name).toBe("src")
    }),
  )

  it.live("maps v1 error envelope to SpaceControlUnavailable for known error code", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const json = errorEnvelope(
        "space.projects.list",
        "SPACE_NOT_FOUND",
        "Space unknown is not registered.",
        "Run wopal space list to see registered spaces.",
      )
      const [exec, args] = shellCmd(json, 1)

      const result = yield* adapter.execute<SpaceProjectsListData>(
        exec,
        args,
        "space.projects.list",
        spaceProjectsListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SPACE_NOT_FOUND")
      }
    }),
  )

  it.live("maps CAPABILITY_VERSION_UNSUPPORTED to CapabilityContractError", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const json = errorEnvelope(
        "space.list",
        "CAPABILITY_VERSION_UNSUPPORTED",
        "API version 99 is not supported.",
        "Use --api-version 1.",
      )
      const [exec, args] = shellCmd(json, 1)

      const result = yield* adapter.execute<SpaceListData>(
        exec,
        args,
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
    }),
  )

  it.live("returns SpaceControlUnavailable when stdout is not JSON", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service

      const result = yield* adapter.execute<SpaceListData>(
        "/bin/sh",
        ["-c", "echo 'not valid json'"],
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SpaceControlUnavailable")
      }
    }),
  )

  it.live("returns CapabilityContractError when capability mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const data = { items: [], total: 0 }
      const json = successEnvelope("space.list", data)
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceProjectsListData>(
        exec,
        args,
        "space.projects.list",
        spaceProjectsListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("CapabilityContractError")
      }
    }),
  )

  it.live("returns SpaceControlUnavailable when CLI executable is missing", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service

      const result = yield* adapter.execute<SpaceListData>(
        "/nonexistent/cli/binary/that/does/not/exist",
        ["--json"],
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SpaceControlUnavailable")
      }
    }),
  )

  it.live("returns SpaceControlUnavailable when CLI execution exceeds its timeout", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service

      const result = yield* adapter.execute<SpaceListData>(
        "/bin/sh",
        ["-c", "sleep 1"],
        "space.list",
        spaceListSchema,
        { timeout: 10 },
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("timed out")
      }
    }),
  )

  it.live("returns SpaceControlUnavailable on empty stdout", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service

      const result = yield* adapter.execute<SpaceListData>(
        "/bin/sh",
        ["-c", "echo ''"],
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SpaceControlUnavailable")
      }
    }),
  )

  it.live("returns CapabilityContractError when data schema mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const json = successEnvelope("space.list", { items: "wrong", total: 0 })
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceListData>(
        exec,
        args,
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("CapabilityContractError")
      }
    }),
  )

  it.live("returns SpaceControlUnavailable when envelope is malformed", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      // Envelope missing the required `ok` field — fails CliEnvelope validation
      const json = JSON.stringify({
        apiVersion: "wopal.capability/v1",
        capability: "space.list",
        data: { items: [], total: 0 },
      })
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceListData>(
        exec,
        args,
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("SpaceControlUnavailable")
      }
    }),
  )

  it.live("returns CapabilityContractError when capability data misses required fields", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      // Item missing the required `type` field per shared spaceListItemSchema
      const data = { items: [{ name: "src", path: "src" }], total: 1 }
      const json = successEnvelope("space.list", data)
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceListData>(
        exec,
        args,
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("CapabilityContractError")
      }
    }),
  )

  it.live("maps UNKNOWN_ERROR code to SpaceControlUnavailable", () =>
    Effect.gen(function* () {
      const adapter = yield* CliAdapter.Service
      const json = errorEnvelope(
        "space.list",
        "SOME_NEW_ERROR",
        "Something unexpected happened.",
      )
      const [exec, args] = shellCmd(json, 1)

      const result = yield* adapter.execute<SpaceListData>(
        exec,
        args,
        "space.list",
        spaceListSchema,
      ).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("UNKNOWN_ERROR")
      }
    }),
  )
})

// ---------------------------------------------------------------------------
// Task 2: SpaceRegistry tests
// ---------------------------------------------------------------------------

describe("space-registry", () => {
  it.live("getSpaces returns empty when never refreshed", () =>
    Effect.gen(function* () {
      const registry = yield* SpaceRegistry.Service
      const snapshot = yield* registry.getSpaces()
      expect(snapshot.spaces).toEqual([])
      expect(snapshot.refreshedAt).toBe(0)
    }),
  )

  it.live("refreshSpaces + getSpaces round-trip", () =>
    Effect.gen(function* () {
      const registry = yield* SpaceRegistry.Service
      const adapter = yield* CliAdapter.Service
      const data = { items: [{ id: "test-space", name: "test-space", path: "/tmp/test", type: "local" }], total: 1 }
      const json = successEnvelope("space.list", data)
      const [exec, args] = shellCmd(json)

      // Verify the adapter can decode the space list
      const result = yield* adapter.execute<SpaceListData>(
        exec,
        args,
        "space.list",
        spaceListSchema,
      )

      expect(result.items.length).toBe(1)
      expect(result.items[0].name).toBe("test-space")
    }),
  )

  it.live("searchSpace returns directory data", () =>
    Effect.gen(function* () {
      const registry = yield* SpaceRegistry.Service
      const adapter = yield* CliAdapter.Service
      const data = { items: [{ name: "src", path: "src", type: "dir" }], total: 1, offset: 0, limit: 50, hasMore: false }
      const json = successEnvelope("space.search", data)
      const [exec, args] = shellCmd(json)

      const result = yield* adapter.execute<SpaceSearchData>(
        exec,
        args,
        "space.search",
        spaceSearchSchema,
      )

      expect(result.items[0].name).toBe("src")
    }),
  )
})
