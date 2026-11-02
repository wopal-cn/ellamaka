import { describe, expect } from "bun:test"
import { realpathSync } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { SessionProvisioner } from "../../src/workbench/session-provisioner"
import { SessionProjection } from "../../src/workbench/session-projection"
import { SessionDirectoryHealth } from "../../src/workbench/session-directory-health"
import { WopalSpaceHostService, type WopalSpaceHost } from "../../src/wopal/wopal-space-host"
import { TestInstance } from "../fixture/fixture"
/** Only the Space queries the provisioner consumes; the rest stay unimplemented. */
function testHost(spaces: Array<{ id: string; name: string; path: string }>, projectPath?: string): WopalSpaceHost {
  return {
    host: { wopalHome: "/unused" },
    rebindHome: () => {},
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the provisioner never queries ontology
    ontology: {} as never,
    findSpace: () => undefined,
    space: {
      list: () => {
        const items = spaces.map((space) => ({
          name: space.id,
          displayName: space.name,
          path: space.path,
          branch: "space/" + space.id,
          type: "local",
          facts: { present: true, snapshot: "ok" as const, worktree: true, mismatch: [] },
        }))
        return { items, total: items.length }
      },
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the provisioner only lists Spaces
      resolve: () => ({}) as never,
      availableTypes: () => [],
      init: () => Promise.reject(new Error("unused")),
      projectsList: () => ({
        items: projectPath ? [{ id: "project", name: "project", path: projectPath, worktrees: [] }] : [],
        total: projectPath ? 1 : 0,
      }),
      filesList: () => ({ items: [], total: 0 }),
      filesRead: () => ({ type: "binary", content: "" }),
      search: () => ({ items: [], total: 0, offset: 0, limit: 50, hasMore: false }),
      scan: () => ({ space: { name: "", path: "" }, repositories: [], agentRules: [] }),
      status: () => Promise.reject(new Error("unused")),
      sync: () => Promise.reject(new Error("unused")),
      capabilityAdd: () => Promise.reject(new Error("unused")),
      capabilityRemove: () => Promise.reject(new Error("unused")),
    },
  } satisfies import("../../src/wopal/wopal-space-host").WopalSpaceHost
}
import { SessionShare } from "../../src/share/session"
import { Session } from "../../src/session/session"
import { InstanceStore } from "../../src/project/instance-store"

const sessionShareLayer = Layer.mock(SessionShare.Service, {
  create: () => Effect.die("SessionShare.create should not run in service wiring tests"),
})

const instanceStoreLayer = Layer.mock(InstanceStore.Service, {
  provide: (_input, effect) => effect,
})

let createInput: { title?: string; agent?: string; metadata?: Record<string, unknown> } | undefined
let createCount = 0

function resetCreateCapture() {
  createInput = undefined
  createCount = 0
}

const provisionerIt = testEffect(
  SessionProvisioner.layer.pipe(
    Layer.provide([
      Layer.mock(SessionDirectoryHealth.Service, {
        check: () => Effect.succeed("healthy" as const),
      }),
      Layer.succeed(WopalSpaceHostService.Service, testHost([{ id: "main", name: "main", path: "/tmp" }])),
      Layer.mock(SessionShare.Service, {
        create: (input) =>
          Effect.tap(Effect.sleep("10 millis"), () =>
            Effect.sync(() => {
              createCount += 1
              createInput = input
            }),
          ).pipe(
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- SessionShare fixture omits unused session fields
            Effect.as({ id: "ses_1", directory: "/tmp", title: "New session - 2026-07-12T00:00:00.000Z" } as never),
          ),
      }),
      Layer.mock(Session.Service, {
        list: () => Effect.succeed([]),
      }),
      instanceStoreLayer,
    ]),
  ),
)

const it = testEffect(
  Layer.mergeAll(
    SessionProvisioner.defaultLayer,
    SessionProjection.defaultLayer,
    SessionDirectoryHealth.defaultLayer,
    WopalSpaceHostService.layer,
  ).pipe(
    Layer.provide([
      sessionShareLayer,
      instanceStoreLayer,
      Layer.mock(Session.Service, { list: () => Effect.succeed([]) }),
    ]),
  ),
)
const isolatedIt = testEffect(Layer.empty)
// Legacy `spaceName` matching must use the stable space id (D-06), not the
// display name. This layer registers a space whose id and name differ so the
// two behaviors are distinguishable.
const legacySpaceNameIt = testEffect(
  SessionProvisioner.layer.pipe(
    Layer.provide([
      Layer.mock(SessionDirectoryHealth.Service, {
        check: () => Effect.succeed("healthy" as const),
      }),
      Layer.succeed(WopalSpaceHostService.Service, testHost([{ id: "main", name: "主空间", path: "/tmp" }])),
      Layer.mock(SessionShare.Service, {
        create: (input) =>
          Effect.tap(Effect.sleep("10 millis"), () =>
            Effect.sync(() => {
              createCount += 1
              createInput = input
            }),
          ).pipe(
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- SessionShare fixture omits unused session fields
            Effect.as({ id: "ses_1", directory: "/tmp", title: "New session - 2026-07-12T00:00:00.000Z" } as never),
          ),
      }),
      Layer.mock(Session.Service, {
        list: () => Effect.succeed([]),
      }),
      instanceStoreLayer,
    ]),
  ),
)

describe("workbench-session-api", () => {
  isolatedIt.instance("creates through an alias at the selected canonical subdirectory", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const root = path.join(instance.directory, "space")
      const alias = path.join(instance.directory, "alias")
      const project = path.join(root, "projects", "one")
      yield* Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        await fs.symlink(root, alias)
      })
      const expected = yield* Effect.promise(() => fs.realpath(project))
      let createdAt: string | undefined
      const layer = SessionProvisioner.layer.pipe(
        Layer.provide([
          Layer.mock(SessionDirectoryHealth.Service, { check: () => Effect.succeed("healthy" as const) }),
          Layer.succeed(WopalSpaceHostService.Service, testHost([{ id: "one", name: "One", path: alias }])),
          Layer.mock(SessionShare.Service, {
            create: () =>
              Effect.sync(() => {
                // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- SessionShare omits unused fields
                return { id: "ses_alias", directory: expected, title: "Alias" } as never
              }),
          }),
          Layer.mock(InstanceStore.Service, {
            provide: (input, effect) =>
              Effect.flatMap(
                Effect.sync(() => {
                  createdAt = input.directory
                }),
                () => effect,
              ),
          }),
        ]),
      )
      const result = yield* SessionProvisioner.Service.use((provisioner) =>
        provisioner.provisionSpace({ spacePath: alias, relativeDirectory: "projects/one" }),
      ).pipe(Effect.provide(layer))
      expect(result.directory).toBe(expected)
      expect(createdAt).toBe(expected)
    }),
  )
  isolatedIt.instance("rejects an ambiguous canonical Space root", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = path.join(instance.directory, "root")
      const alias = path.join(instance.directory, "alias")
      yield* Effect.promise(async () => {
        await fs.mkdir(dir)
        await fs.symlink(dir, alias)
      })
      const layer = SessionProvisioner.layer.pipe(
        Layer.provide([
          Layer.mock(SessionDirectoryHealth.Service, { check: () => Effect.succeed("healthy" as const) }),
          Layer.succeed(
            WopalSpaceHostService.Service,
            testHost([
              { id: "one", name: "One", path: dir },
              { id: "two", name: "Two", path: alias },
            ]),
          ),
          sessionShareLayer,
          instanceStoreLayer,
        ]),
      )
      const error = yield* Effect.gen(function* () {
        const provisioner = yield* SessionProvisioner.Service
        return yield* provisioner.provisionSpace({ spacePath: alias }).pipe(Effect.flip)
      }).pipe(Effect.provide(layer))
      expect(error._tag).toBe("InvalidSpaceTarget")
      if (error._tag === "InvalidSpaceTarget") {
        expect(error.message).toBe("Multiple registered Spaces resolve to the requested path")
        expect(error.detail).toBe(alias)
      }
    }),
  )

  provisionerIt.live("provisioner delegates session creation without assigning a fixed title", () =>
    Effect.gen(function* () {
      resetCreateCapture()
      const provisioner = yield* SessionProvisioner.Service
      const result = yield* provisioner.provisionSpace({ spaceName: "main" })

      expect(createCount).toBe(1)
      expect(createInput).toMatchObject({ title: undefined, agent: undefined })
      expect(createInput?.metadata?.workbench).toMatchObject({
        payload: expect.any(String),
        requestID: expect.any(String),
      })
      expect(result).toMatchObject({
        id: "ses_1",
        directory: "/tmp",
        title: "New session - 2026-07-12T00:00:00.000Z",
      })
    }),
  )

  provisionerIt.live("provisioner records a request ID and canonical payload metadata for idempotent creation", () =>
    Effect.gen(function* () {
      resetCreateCapture()
      const provisioner = yield* SessionProvisioner.Service
      yield* provisioner.provisionSpace({ spacePath: "/tmp", requestID: "request-1" })

      expect(createInput).toEqual({
        title: undefined,
        agent: undefined,
        metadata: {
          workbench: {
            requestID: "request-1",
            payload: JSON.stringify({
              // The provisioner canonicalizes the space path; resolve it the same way
              // so the assertion holds on every platform (/private/tmp on macOS, /tmp on Linux).
              target: { type: "space", spacePath: realpathSync("/tmp"), directory: undefined },
              title: undefined,
              agent: undefined,
            }),
          },
        },
      })
    }),
  )

  provisionerIt.live("coalesces concurrent retries with the same request ID", () =>
    Effect.gen(function* () {
      resetCreateCapture()
      const provisioner = yield* SessionProvisioner.Service
      const [first, second] = yield* Effect.all(
        [
          provisioner.provisionSpace({ spacePath: "/tmp", requestID: "request-coalesced" }),
          provisioner.provisionSpace({ spacePath: "/tmp", requestID: "request-coalesced" }),
        ],
        { concurrency: 2 },
      )

      expect(first.id).toBe("ses_1")
      expect(second.id).toBe("ses_1")
      expect(createCount).toBe(1)
    }),
  )

  legacySpaceNameIt.live("legacy spaceName matches the stable space id, not the display name", () =>
    Effect.gen(function* () {
      resetCreateCapture()
      const provisioner = yield* SessionProvisioner.Service
      const result = yield* provisioner.provisionSpace({ spaceName: "main" })

      expect(createCount).toBe(1)
      expect(result.id).toBe("ses_1")
    }),
  )

  legacySpaceNameIt.live("legacy spaceName rejects the display name as an unknown space", () =>
    Effect.gen(function* () {
      resetCreateCapture()
      const provisioner = yield* SessionProvisioner.Service
      const result = yield* provisioner.provisionSpace({ spaceName: "主空间" }).pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.cause.toString()).toContain("InvalidSpaceTarget")
      }
      expect(createCount).toBe(0)
    }),
  )

  it.live("SessionProvisioner service is available", () =>
    Effect.gen(function* () {
      const provisioner = yield* SessionProvisioner.Service
      expect(provisioner).toBeDefined()
      expect(provisioner.provisionGeneral).toBeDefined()
      expect(provisioner.provisionSpace).toBeDefined()
    }),
  )

  it.live("SessionProjection service is available", () =>
    Effect.gen(function* () {
      const projection = yield* SessionProjection.Service
      expect(projection).toBeDefined()
      expect(projection.getSessionGroups).toBeDefined()
    }),
  )

  it.live("SessionDirectoryHealth service is available", () =>
    Effect.gen(function* () {
      const health = yield* SessionDirectoryHealth.Service
      expect(health).toBeDefined()
      expect(health.check).toBeDefined()
    }),
  )

  it.live("directory health check returns healthy for existing directory", () =>
    Effect.gen(function* () {
      const health = yield* SessionDirectoryHealth.Service
      const result = yield* health.check("/tmp")
      expect(result).toBe("healthy")
    }),
  )

  it.live("directory health check returns missing for nonexistent directory", () =>
    Effect.gen(function* () {
      const health = yield* SessionDirectoryHealth.Service
      const result = yield* health.check("/nonexistent/path/12345")
      expect(result).toBe("missing")
    }),
  )
})
