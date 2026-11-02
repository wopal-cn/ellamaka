import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { SessionProjection, resolveSpaceRootPath } from "../../src/workbench/session-projection"
import { SessionDirectoryHealth } from "../../src/workbench/session-directory-health"
import { WopalSpaceHostService } from "../../src/wopal/wopal-space-host"
import type { RegisteredSpace, SpaceListResult, SpaceSearchResult } from "@wopal/wopalspace"
import { SpaceServiceError } from "@wopal/wopalspace"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { Identifier } from "../../src/id/id"
import { Slug } from "@wopal/ellamaka-core/util/slug"
import { InstallationVersion } from "@wopal/ellamaka-core/installation/version"
import type { SpaceProject } from "@wopal/wopalspace"
import { eq } from "drizzle-orm"
import path from "path"
import { realpath } from "fs/promises"

type TestSpace = { id: string; name: string; path: string }

/** Test shorthand -> the registered Space facts the private service exposes. */
function registered(space: TestSpace): RegisteredSpace {
  return {
    name: space.id,
    displayName: space.name,
    path: space.path,
    branch: "space/" + space.id,
    type: "local",
  }
}

type HostOverrides = {
  projects?: (name: string) => SpaceProject[]
  search?: (name: string, query?: string) => SpaceSearchResult
  list?: () => SpaceListResult
}

/** Only the Space queries SessionProjection consumes; the rest stay unimplemented. */
function hostLayer(spaces: TestSpace[], overrides: HostOverrides = {}) {
  return Layer.succeed(WopalSpaceHostService.Service, {
    host: { wopalHome: "/unused" },
    rebindHome: () => {},
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- WopalSpace host double omits methods not used by projection
    ontology: {} as never,
    findSpace: () => undefined,
    space: {
      resolve: () => {
        throw new Error("unused")
      },
      list:
        overrides.list ??
        (() => {
          const items = spaces.map((space) => ({
            ...registered(space),
            facts: { present: true, snapshot: "ok" as const, worktree: true, mismatch: [] },
          }))
          return { items, total: items.length }
        }),
      availableTypes: () => [],
      init: () => Promise.reject(new Error("unused")),
      projectsList: (name: string) => {
        const items = overrides.projects?.(name) ?? []
        return { items, total: items.length }
      },
      filesList: () => {
        throw new Error("unused")
      },
      filesRead: () => {
        throw new Error("unused")
      },
      search: (name: string, input?: { query?: string }) =>
        overrides.search?.(name, input?.query) ?? { items: [], total: 0, offset: 0, limit: 50, hasMore: false },
      scan: () => {
        throw new Error("unused")
      },
      status: () => Promise.reject(new Error("unused")),
      sync: () => Promise.reject(new Error("unused")),
      capabilityAdd: () => Promise.reject(new Error("unused")),
      capabilityRemove: () => Promise.reject(new Error("unused")),
    },
  })
}

const it = testEffect(
  SessionProjection.layer.pipe(Layer.provide(SessionDirectoryHealth.defaultLayer), Layer.provide(hostLayer([]))),
)
const isolatedIt = testEffect(Layer.empty)

function projectionLayer(spaces: TestSpace[], projects: Array<SpaceProject & { id: string }> = []) {
  return SessionProjection.layer.pipe(
    Layer.provide(SessionDirectoryHealth.defaultLayer),
    Layer.provide(
      hostLayer(spaces, {
        projects: () => projects.map(({ name, path, worktrees }) => ({ id: name, name, path, worktrees })),
      }),
    ),
  )
}

/** The Space registry itself fails: General sessions must still render. */
function unavailableSpacesLayer() {
  let queries = 0
  return {
    get queries() {
      return queries
    },
    layer: Layer.fresh(
      SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(
          hostLayer([], {
            list: () => {
              queries += 1
              throw new SpaceServiceError({
                code: "SPACE_REGISTRY_INVALID",
                message: "Space registry is not readable",
              })
            },
          }),
        ),
      ),
    ),
  }
}

function ensureGlobalProject() {
  Database.use((db) => {
    if (db.select({ id: ProjectTable.id }).from(ProjectTable).where(eq(ProjectTable.id, ProjectID.global)).get()) return
    db.insert(ProjectTable)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- legacy fixture supplies the canonical project row shape
      .values({
        id: ProjectID.global,
        worktree: "/",
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      } as never)
      .run()
  })
}

function insertSession(
  directory: string,
  title: string,
  options?: { parentID?: SessionID; timeArchived?: number; agent?: string },
): SessionID {
  const id = Identifier.ascending("session")
  Database.use((db) =>
    db
      .insert(SessionTable)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- legacy fixture supplies branded IDs through its own decoder
      .values({
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- legacy fixture supplies branded IDs through its own decoder
        id: id as never,
        project_id: ProjectID.global,
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- optional fixture parent is branded by the caller
        parent_id: options?.parentID as never,
        slug: Slug.create(),
        directory,
        title,
        version: InstallationVersion,
        agent: options?.agent ?? null,
        time_created: Date.now(),
        time_updated: Date.now(),
        time_archived: options?.timeArchived,
      })
      .run(),
  )
  return SessionID.make(id)
}

/** Run projection query + session lifecycle in a fresh runtime with the mock. */
function queryProjection(spaces: TestSpace[], sessionDir: string, subDir?: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        ensureGlobalProject()
        insertSession(sessionDir, "root")
        if (subDir) insertSession(subDir, "sub")
      })
      const projection = yield* SessionProjection.Service
      const groups = yield* projection.getSessionGroups()
      return groups
    }).pipe(Effect.scoped, Effect.provide(projectionLayer(spaces))),
  )
}

describe("session-projection-group-resolution", () => {
  it.instance("keeps General sessions available when the Space registry is unreadable", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.sync(() => {
        ensureGlobalProject()
        insertSession(instance.directory, "General survives")
      })
      const unavailable = unavailableSpacesLayer()
      const services = yield* Layer.build(unavailable.layer)
      const groups = yield* Context.get(services, SessionProjection.Service).getSessionGroups()

      expect(unavailable.queries).toBe(1)
      expect(groups).toMatchObject([
        {
          type: "general",
          sessions: [{ title: "General survives" }],
        },
      ])
    }),
  )

  it.instance("returns only active root sessions to the Workbench list", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const rootID = yield* Effect.sync(() => {
        ensureGlobalProject()
        const id = insertSession(instance.directory, "active root")
        insertSession(instance.directory, "archived root", { timeArchived: Date.now() })
        insertSession(instance.directory, "child session", { parentID: id })
        return id
      })

      const projection = yield* SessionProjection.Service
      const groups = yield* projection.getSessionGroups()
      const group = groups.find((item) => item.type === "general" && item.id === instance.directory)

      expect(group?.sessionCount).toBe(1)
      expect(group?.sessions.map((session) => ({ id: session.id, title: session.title }))).toEqual([
        { id: rootID, title: "active root" },
      ])
    }),
  )

  it.instance("returns space group for sessions under a registered space path", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = instance.directory
      const subDir = path.join(dir, "subdir")
      yield* Effect.sync(() => require("fs").mkdirSync(subDir, { recursive: true }))

      const spaces: TestSpace[] = [{ id: "test-space", name: "测试空间", path: dir }]
      const groups = yield* Effect.promise(() => queryProjection(spaces, dir, subDir))

      const spaceGroup = groups.find((g) => g.type === "space" && g.id === "test-space")
      expect(spaceGroup).toBeDefined()
      expect(spaceGroup!.title).toBe("测试空间")
      expect(spaceGroup!.sessions.length).toBeGreaterThanOrEqual(2)
      expect(spaceGroup!.sessions.every((s) => s.directoryHealth === "healthy")).toBe(true)
    }),
  )

  it.instance("returns general group for sessions outside any space", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = instance.directory
      const generalDir = path.join(dir, "general")
      yield* Effect.sync(() => require("fs").mkdirSync(generalDir, { recursive: true }))

      const spaces: TestSpace[] = [{ id: "test-space", name: "测试空间", path: path.join(dir, "nonexistent") }]
      const groups = yield* Effect.promise(() => queryProjection(spaces, generalDir))

      const spaceGroup = groups.find((g) => g.type === "space")
      expect(spaceGroup).toBeUndefined()
      const generalGroup = groups.find((g) => g.type === "general")
      expect(generalGroup).toBeDefined()
      expect(generalGroup!.sessions.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.instance("retains space association for sessions with missing directory", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = instance.directory
      const missingDir = path.join(dir, "missing")

      const spaces: TestSpace[] = [{ id: "test-space", name: "测试空间", path: missingDir }]
      const groups = yield* Effect.promise(() => queryProjection(spaces, missingDir))

      const spaceGroup = groups.find((g) => g.type === "space" && g.id === "test-space")
      expect(spaceGroup).toBeDefined()
      expect(spaceGroup!.title).toBe("测试空间")
      expect(spaceGroup!.sessions.length).toBeGreaterThanOrEqual(1)
      expect(spaceGroup!.sessions[0].directoryHealth).toBe("missing")
    }),
  )

  it.instance("getSessionTree maps worktrees returned by CLI projects list v2", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      // canonicalSpaces resolves space paths through realpath; session directories
      // stored in the DB use the raw path. On macOS /var → /private/var, so the
      // space path and session directory won't match unless we pre-resolve.
      const dir = yield* Effect.tryPromise(() => realpath(instance.directory))
      const projDir = path.join(dir, "projects/my-project")
      const wtDir = path.join(dir, "projects/my-project/.worktrees/my-wt")
      yield* Effect.sync(() => {
        require("fs").mkdirSync(projDir, { recursive: true })
        require("fs").mkdirSync(wtDir, { recursive: true })
      })

      const spaces: TestSpace[] = [{ id: "my-space", name: "我的空间", path: dir }]
      const projects: Array<SpaceProject & { id: string }> = [
        {
          id: "p1",
          name: "my-project",
          path: "projects/my-project",
          worktrees: [{ path: "projects/my-project/.worktrees/my-wt", branch: "feat/wt" }],
        },
      ]

      // Insert a session in the worktree directory
      yield* Effect.sync(() => {
        ensureGlobalProject()
        insertSession(wtDir, "wt-session")
      })

      // Run in a fresh runtime so the custom WopalSpace host mock (with spaces
      // and projects) is wired through SessionProjection.layer from scratch,
      // matching the queryProjection pattern used in earlier tests.
      const tree = yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const projection = yield* SessionProjection.Service
            return yield* projection.getSessionTree()
          }).pipe(Effect.scoped, Effect.provide(projectionLayer(spaces, projects))),
        ),
      )

      const scope = tree.scopes.find((s) => s.name === "我的空间")
      expect(scope).toBeDefined()
      const location = scope!.locations.find((l) => l.name === "my-project")
      expect(location).toBeDefined()
      expect(location!.sessions.length).toBe(1)
      expect(location!.sessions[0].marker).toBe("worktree")
      expect(location!.sessions[0].branch).toBe("feat/wt")
    }),
  )

  it.instance("getSessionTree keeps all scopes when one project refresh fails", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const brokenDir = path.join(instance.directory, "broken-space")
      const healthyDir = path.join(instance.directory, "healthy-space")
      yield* Effect.sync(() => {
        require("fs").mkdirSync(brokenDir, { recursive: true })
        require("fs").mkdirSync(healthyDir, { recursive: true })
      })
      const spaces: TestSpace[] = [
        { id: "broken", name: "broken", path: brokenDir },
        { id: "healthy", name: "healthy", path: healthyDir },
      ]
      const layer = SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(
          hostLayer(spaces, {
            projects: (name) => {
              if (name === "broken") {
                throw new SpaceServiceError({ code: "SPACE_OPERATION_FAILED", message: "broken space" })
              }
              return []
            },
          }),
        ),
      )

      const tree = yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const projection = yield* SessionProjection.Service
            return yield* projection.getSessionTree()
          }).pipe(Effect.scoped, Effect.provide(layer)),
        ),
      )

      const names = tree.scopes.map((scope) => scope.name)
      expect(names).toContain("broken")
      expect(names).toContain("healthy")
    }),
  )

  it.instance("getSessionTree passes the space id (not display name) to refreshProjects", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = yield* Effect.tryPromise(() => realpath(instance.directory))
      const projDir = path.join(dir, "projects/my-project")
      yield* Effect.sync(() => require("fs").mkdirSync(projDir, { recursive: true }))

      const spaces: TestSpace[] = [{ id: "my-space", name: "我的空间", path: dir }]
      const projects: SpaceProject[] = [{ id: "p1", name: "my-project", path: "projects/my-project", worktrees: [] }]
      const selected: string[] = []
      const layer = SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(
          hostLayer(spaces, {
            projects: (name) => {
              selected.push(name)
              return projects
            },
          }),
        ),
      )

      yield* Effect.sync(() => {
        ensureGlobalProject()
        insertSession(projDir, "proj-session")
      })

      yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const projection = yield* SessionProjection.Service
            return yield* projection.getSessionTree()
          }).pipe(Effect.scoped, Effect.provide(layer)),
        ),
      )

      // The stable registry key selects the Space; the display name never does.
      expect(selected).toContain("my-space")
      expect(selected).not.toContain("我的空间")
    }),
  )

  it.instance("getLocations passes the space id (not display name) to searchSpace", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = yield* Effect.tryPromise(() => realpath(instance.directory))

      const spaces: TestSpace[] = [{ id: "my-space", name: "我的空间", path: dir }]
      const searched: string[] = []
      const layer = SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(
          hostLayer(spaces, {
            search: (name, query) => {
              searched.push(name, query ?? "")
              return { items: [], total: 0, offset: 0, limit: 50, hasMore: false }
            },
          }),
        ),
      )

      yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const projection = yield* SessionProjection.Service
            return yield* projection.getLocations({ spacePath: dir, query: "foo" })
          }).pipe(Effect.scoped, Effect.provide(layer)),
        ),
      )

      // The stable registry key selects the Space; the display name never does.
      expect(searched).toContain("my-space")
      expect(searched).not.toContain("我的空间")
    }),
  )

  it.instance("getLocations resolves a Space path through a symbolic-link alias", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const fixture = yield* Effect.tryPromise(() => realpath(instance.directory))
      const dir = path.join(fixture, "space")
      const alias = path.join(fixture, "space-alias")
      yield* Effect.tryPromise(() => require("fs/promises").mkdir(dir))
      yield* Effect.tryPromise(() => require("fs/promises").symlink(dir, alias))

      const spaces: TestSpace[] = [{ id: "aliased-space", name: "Aliased Space", path: dir }]
      const layer = SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(hostLayer(spaces)),
      )

      const locations = yield* Effect.promise(() =>
        Effect.runPromise(
          Effect.gen(function* () {
            const projection = yield* SessionProjection.Service
            return yield* projection.getLocations({ spacePath: alias })
          }).pipe(Effect.scoped, Effect.provide(layer)),
        ),
      )

      expect(locations.scopePath).toBe(dir)
      expect(locations.items[0]?.path).toBe(dir)
    }),
  )

  isolatedIt.instance("getLocations rejects distinct registered Spaces with the same real root", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = path.join(instance.directory, "space")
      const alias = path.join(instance.directory, "space-alias")
      yield* Effect.promise(async () => {
        await require("fs/promises").mkdir(dir)
        await require("fs/promises").symlink(dir, alias)
      })
      const layer = projectionLayer([
        { id: "one", name: "One", path: dir },
        { id: "two", name: "Two", path: alias },
      ])
      const result = yield* Effect.gen(function* () {
        const projection = yield* SessionProjection.Service
        return yield* projection.getLocations({ spacePath: alias }).pipe(Effect.flip)
      }).pipe(Effect.provide(layer))
      expect(result._tag).toBe("WorkbenchSpaceQueryFailed")
      if (result._tag === "WorkbenchSpaceQueryFailed") expect(result.code).toBe("SPACE_PATH_AMBIGUOUS")
    }),
  )

  isolatedIt.instance("getSessionTree rejects distinct registered Spaces with the same real root", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = path.join(instance.directory, "space")
      const alias = path.join(instance.directory, "space-alias")
      yield* Effect.promise(async () => {
        await require("fs/promises").mkdir(dir)
        await require("fs/promises").symlink(dir, alias)
      })
      const layer = projectionLayer([
        { id: "one", name: "One", path: dir },
        { id: "two", name: "Two", path: alias },
      ])
      const result = yield* Effect.gen(function* () {
        const projection = yield* SessionProjection.Service
        return yield* projection.getSessionTree().pipe(Effect.flip)
      }).pipe(Effect.provide(layer))
      expect(result._tag).toBe("WorkbenchSpaceQueryFailed")
      if (result._tag === "WorkbenchSpaceQueryFailed") expect(result.code).toBe("SPACE_PATH_AMBIGUOUS")
    }),
  )
})

describe("resolveSpaceRootPath", () => {
  test("joins relative path onto WopalSpace root", () => {
    expect(resolveSpaceRootPath("/Volumes/.../wopal-workspace", "projects/ellamaka")).toBe(
      "/Volumes/.../wopal-workspace/projects/ellamaka",
    )
  })

  test("passes absolute path through unchanged", () => {
    expect(resolveSpaceRootPath("/Volumes/.../wopal-workspace", "/Users/sam/tests/WopalSpace")).toBe(
      "/Users/sam/tests/WopalSpace",
    )
  })

  test("handles empty string as no-op when root missing", () => {
    expect(resolveSpaceRootPath("", "projects/ellamaka")).toBe("projects/ellamaka")
  })
})
