import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { SessionProjection, resolveSpaceRootPath } from "../../src/workbench/session-projection"
import { SessionDirectoryHealth } from "../../src/workbench/session-directory-health"
import { SpaceRegistry } from "../../src/wopal/space-registry"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { Identifier } from "../../src/id/id"
import { Slug } from "@wopal/ellamaka-core/util/slug"
import { InstallationVersion } from "@wopal/ellamaka-core/installation/version"
import { SpaceControlUnavailable, type SpaceEntry, type ProjectEntry } from "../../src/wopal/cli-schema"
import { eq } from "drizzle-orm"
import path from "path"
import { realpath } from "fs/promises"

const it = testEffect(
  SessionProjection.layer.pipe(
    Layer.provide(SessionDirectoryHealth.defaultLayer),
    Layer.provide(Layer.succeed(SpaceRegistry.Service, {
      getSpaces: () => Effect.succeed({ spaces: [], refreshedAt: 0 }),
      refreshSpaces: () => Effect.succeed({ spaces: [], refreshedAt: 0 }),
      refreshProjects: () => Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
      searchSpace: () => Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
    })),
  ),
)

function projectionLayer(spaces: SpaceEntry[], projects: ProjectEntry[] = []) {
  return SessionProjection.layer.pipe(
    Layer.provide(SessionDirectoryHealth.defaultLayer),
    Layer.provide(Layer.succeed(SpaceRegistry.Service, {
      getSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
      refreshSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
      refreshProjects: () => Effect.succeed({ items: projects, total: projects.length, refreshedAt: 0 }),
      searchSpace: () => Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
    })),
  )
}

/** Cold-start layer: getSpaces returns empty, refreshSpaces returns the given spaces. */
function coldStartLayer(spaces: SpaceEntry[]) {
  return SessionProjection.layer.pipe(
    Layer.provide(SessionDirectoryHealth.defaultLayer),
    Layer.provide(Layer.succeed(SpaceRegistry.Service, {
      getSpaces: () => Effect.succeed({ spaces: [] as SpaceEntry[], refreshedAt: 0 }),
      refreshSpaces: () => Effect.succeed({ spaces, refreshedAt: Date.now() }),
      refreshProjects: () => Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
      searchSpace: () => Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
    })),
  )
}

function unavailableSpacesLayer() {
  let refreshes = 0
  const dependencies = Layer.mergeAll(
    SessionDirectoryHealth.defaultLayer,
    Layer.succeed(SpaceRegistry.Service, {
      getSpaces: () => Effect.succeed({ spaces: [] as SpaceEntry[], refreshedAt: 0 }),
      refreshSpaces: () => {
        refreshes += 1
        return Effect.fail(new SpaceControlUnavailable({ message: "Wopal CLI unavailable" }))
      },
      refreshProjects: () => Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
      searchSpace: () => Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
    }),
  )
  return {
    get refreshes() {
      return refreshes
    },
    layer: Layer.fresh(SessionProjection.layer.pipe(Layer.provide(dependencies))),
  }
}

function ensureGlobalProject() {
  Database.use((db) => {
    if (db.select({ id: ProjectTable.id }).from(ProjectTable).where(eq(ProjectTable.id, ProjectID.global)).get()) return
    db.insert(ProjectTable).values({ id: ProjectID.global, worktree: "/", sandboxes: [], time_created: Date.now(), time_updated: Date.now() } as never).run()
  })
}

function insertSession(directory: string, title: string, options?: { parentID?: string; timeArchived?: number }): string {
  const id = Identifier.ascending("session")
  Database.use((db) =>
    db.insert(SessionTable).values({
      id: id as never,
      project_id: ProjectID.global,
      parent_id: options?.parentID as never,
      slug: Slug.create(),
      directory,
      title,
      version: InstallationVersion,
      agent: null,
      time_created: Date.now(),
      time_updated: Date.now(),
      time_archived: options?.timeArchived,
    }).run(),
  )
  return id
}

function deleteSession(id: string) {
  Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, id as never)).run())
}

/** Run projection query + session lifecycle in a fresh runtime with the mock. */
function queryProjection(spaces: SpaceEntry[], sessionDir: string, subDir?: string) {
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

/** Run projection with a cold-start registry (getSpaces returns empty, refreshSpaces provides data). */
function queryProjectionColdStart(spaces: SpaceEntry[], sessionDir: string, subDir?: string) {
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
    }).pipe(Effect.scoped, Effect.provide(coldStartLayer(spaces))),
  )
}

describe("session-projection-group-resolution", () => {
  it.instance("keeps General sessions available when space discovery is unavailable", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.sync(() => {
        ensureGlobalProject()
        insertSession(instance.directory, "General survives")
      })
      const unavailable = unavailableSpacesLayer()
      const services = yield* Layer.build(unavailable.layer)
      const groups = yield* Context.get(services, SessionProjection.Service).getSessionGroups()

      expect(unavailable.refreshes).toBe(1)
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

      const spaces: SpaceEntry[] = [{ id: "test-space", name: "测试空间", path: dir, type: "local" }]
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

      const spaces: SpaceEntry[] = [{ id: "test-space", name: "测试空间", path: path.join(dir, "nonexistent"), type: "local" }]
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

      const spaces: SpaceEntry[] = [{ id: "test-space", name: "测试空间", path: missingDir, type: "local" }]
      const groups = yield* Effect.promise(() => queryProjection(spaces, missingDir))

      const spaceGroup = groups.find((g) => g.type === "space" && g.id === "test-space")
      expect(spaceGroup).toBeDefined()
      expect(spaceGroup!.title).toBe("测试空间")
      expect(spaceGroup!.sessions.length).toBeGreaterThanOrEqual(1)
      expect(spaceGroup!.sessions[0].directoryHealth).toBe("missing")
    }),
  )

  it.instance("cold-start: classifies space session after empty-cache refresh", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = instance.directory
      const subDir = path.join(dir, "subdir")
      yield* Effect.sync(() => require("fs").mkdirSync(subDir, { recursive: true }))

      const spaces: SpaceEntry[] = [{ id: "test-space", name: "测试空间", path: dir, type: "local" }]
      const groups = yield* Effect.promise(() => queryProjectionColdStart(spaces, dir, subDir))

      const spaceGroup = groups.find((g) => g.type === "space" && g.id === "test-space")
      expect(spaceGroup).toBeDefined()
      expect(spaceGroup!.title).toBe("测试空间")
      expect(spaceGroup!.sessions.length).toBeGreaterThanOrEqual(2)
    }),
  )

  it.instance("cold-start: Space-root session becomes type=space with id=space.name after refresh", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = instance.directory

      const spaces: SpaceEntry[] = [{ id: "my-space", name: "我的空间", path: dir, type: "local" }]
      const groups = yield* Effect.promise(() => queryProjectionColdStart(spaces, dir))

      const spaceGroup = groups.find((g) => g.type === "space")
      expect(spaceGroup).toBeDefined()
      expect(spaceGroup!.id).toBe("my-space")
      expect(spaceGroup!.title).toBe("我的空间")
      expect(spaceGroup!.type).toBe("space")
      expect(spaceGroup!.sessions.length).toBeGreaterThanOrEqual(1)
      expect(spaceGroup!.sessions[0].directory).toBe(dir)
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

      const spaces: SpaceEntry[] = [{ id: "my-space", name: "我的空间", path: dir, type: "local" }]
      const projects: ProjectEntry[] = [
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

      // Run in a fresh runtime so the custom SpaceRegistry mock (with spaces
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
      const spaces: SpaceEntry[] = [
        { id: "broken", name: "broken", path: brokenDir, type: "local" },
        { id: "healthy", name: "healthy", path: healthyDir, type: "local" },
      ]
      const layer = SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(
          Layer.succeed(SpaceRegistry.Service, {
            getSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
            refreshSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
            refreshProjects: (_executable, spaceName) =>
              spaceName === "broken"
                ? Effect.fail(new SpaceControlUnavailable({ message: "broken space" }))
                : Effect.succeed({ items: [], total: 0, refreshedAt: 1 }),
            searchSpace: () => Effect.succeed({ items: [], total: 0, refreshedAt: 1 }),
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

      const spaces: SpaceEntry[] = [{ id: "my-space", name: "我的空间", path: dir, type: "local" }]
      const projects: ProjectEntry[] = [
        { id: "p1", name: "my-project", path: "projects/my-project", worktrees: [] },
      ]
      const cliArgs: string[] = []
      const layer = SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(
          Layer.succeed(SpaceRegistry.Service, {
            getSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
            refreshSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
            refreshProjects: (_executable, spaceName) => {
              cliArgs.push(spaceName ?? "")
              return Effect.succeed({ items: projects, total: projects.length, refreshedAt: 1 })
            },
            searchSpace: () => Effect.succeed({ items: [], total: 0, refreshedAt: 1 }),
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

      // The CLI --space argument must be the stable id, never the Chinese display name.
      expect(cliArgs).toContain("my-space")
      expect(cliArgs).not.toContain("我的空间")
    }),
  )

  it.instance("getLocations passes the space id (not display name) to searchSpace", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const dir = yield* Effect.tryPromise(() => realpath(instance.directory))

      const spaces: SpaceEntry[] = [{ id: "my-space", name: "我的空间", path: dir, type: "local" }]
      const searchArgs: string[] = []
      const layer = SessionProjection.layer.pipe(
        Layer.provide(SessionDirectoryHealth.defaultLayer),
        Layer.provide(
          Layer.succeed(SpaceRegistry.Service, {
            getSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
            refreshSpaces: () => Effect.succeed({ spaces, refreshedAt: 1 }),
            refreshProjects: () => Effect.succeed({ items: [], total: 0, refreshedAt: 1 }),
            searchSpace: (_executable, query, spaceName) => {
              searchArgs.push(query, spaceName ?? "")
              return Effect.succeed({ items: [], total: 0, refreshedAt: 1 })
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

      // The CLI --space argument must be the stable id, never the Chinese display name.
      expect(searchArgs).toContain("my-space")
      expect(searchArgs).not.toContain("我的空间")
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
