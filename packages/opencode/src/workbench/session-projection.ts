import { Context, Effect, Layer, Schema } from "effect"
import { realpath } from "fs/promises"
import path from "path"
import { Database } from "@/storage/db"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { SessionDirectoryHealth } from "./session-directory-health"
import { SpaceRegistry } from "@/wopal/space-registry"
import { CliContract } from "@/wopal/cli-contract"
import type { SpaceEntry } from "@/wopal/cli-schema"
import { SpaceControlUnavailable, CapabilityContractError } from "@/wopal/cli-schema"
import { and, eq, isNull } from "drizzle-orm"
import {
  buildWorkbenchSessionTree,
  isPathWithin,
  normalizeWorkbenchPath,
  type WorkbenchDirectoryHealth,
  type WorkbenchSessionTree,
} from "./session-tree"

export interface SessionGroup {
  id: string
  title: string
  type: "space" | "general"
  sessionCount: number
  sessions: SessionSummary[]
}

export interface SessionSummary {
  id: string
  title: string
  directory: string
  directoryHealth: WorkbenchDirectoryHealth
  agent?: string
  timeCreated: number
  timeUpdated: number
  timeArchived?: number
}

export interface WorkbenchSessionSummary {
  id: SessionID
  title: string
  directory: string
  parentID?: SessionID
  agent?: string
}

export type WorkbenchLocation = {
  key: string
  kind: "space-root" | "project" | "recent" | "search"
  name: string
  path: string
  relativeDirectory: string
  lastUsedAt?: number
}

export class WorkbenchSpaceNotFound extends Schema.TaggedErrorClass<WorkbenchSpaceNotFound>()(
  "WorkbenchSpaceNotFound",
  { message: Schema.String, spacePath: Schema.String },
) {}

export interface SessionProjection {
  readonly getSessionGroups: () => Effect.Effect<SessionGroup[], SpaceControlUnavailable | CapabilityContractError>
  readonly getSessionSummary: (input: { sessionID: SessionID }) => Effect.Effect<WorkbenchSessionSummary | null>
  readonly getSessionTree: (input?: {
    limitPerScope?: number
  }) => Effect.Effect<WorkbenchSessionTree, SpaceControlUnavailable | CapabilityContractError>
  readonly getLocations: (input: {
    spacePath: string
    query?: string
  }) => Effect.Effect<
    { scopePath: string; items: WorkbenchLocation[] },
    WorkbenchSpaceNotFound | SpaceControlUnavailable | CapabilityContractError
  >
}

export class Service extends Context.Service<Service, SessionProjection>()("@opencode/SessionProjection") {}

interface RawSessionRow {
  id: string
  title: string
  directory: string
  agent: string | null
  parent_id: string | null
  time_created: number | null
  time_updated: number | null
  time_archived: number | null
}

const MAX_LIMIT_PER_SCOPE = 500

/**
 * Resolve a CLI-returned path against a space root.
 *
 * `wopal space projects list` / `wopal space directories search` (when invoked
 * with `--space <name>`) return paths relative to that space's root
 * (e.g. `projects/ellamaka`), not absolute. Session directories are always
 * absolute, so without resolution `isPathWithin(relative, absolute)` never
 * matches and every Space session collapses into the `space-root` location —
 * the `project` location never appears.
 *
 * Absolute paths pass through unchanged. An empty root leaves relative paths
 * as-is.
 */
export function resolveSpaceRootPath(root: string, value: string): string {
  if (!root) return value
  if (path.isAbsolute(value)) return value
  return path.join(root, value)
}

const make = Effect.gen(function* () {
  const health = yield* SessionDirectoryHealth.Service
  const registry = yield* SpaceRegistry.Service

  const activeRows = () =>
    Effect.sync(() =>
      Database.use(
        (db) =>
          db
            .select({
              id: SessionTable.id,
              title: SessionTable.title,
              directory: SessionTable.directory,
              agent: SessionTable.agent,
              parent_id: SessionTable.parent_id,
              time_created: SessionTable.time_created,
              time_updated: SessionTable.time_updated,
              time_archived: SessionTable.time_archived,
            })
            .from(SessionTable)
            .where(and(isNull(SessionTable.parent_id), isNull(SessionTable.time_archived)))
            .all() as RawSessionRow[],
      ),
    )

  const getSessionSummary = Effect.fn("SessionProjection.getSessionSummary")(function* (input: {
    sessionID: SessionID
  }) {
    return yield* Effect.sync(() => {
      const row = Database.use((db) =>
        db
          .select({
            id: SessionTable.id,
            title: SessionTable.title,
            directory: SessionTable.directory,
            parentID: SessionTable.parent_id,
            agent: SessionTable.agent,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get(),
      )
      if (!row) return null
      return {
        id: SessionID.make(row.id),
        title: row.title,
        directory: row.directory,
        parentID: row.parentID ? SessionID.make(row.parentID) : undefined,
        agent: row.agent ?? undefined,
      }
    })
  })

  const spaces = () =>
    Effect.gen(function* () {
      const snapshot = yield* registry.getSpaces()
      if (snapshot.spaces.length > 0) return snapshot.spaces
      return (yield* registry.refreshSpaces(CliContract.executablePath())).spaces
    })

  const spacesOrEmpty = () =>
    spaces().pipe(
      Effect.catchTag("SpaceControlUnavailable", () => Effect.succeed([])),
      Effect.catchTag("CapabilityContractError", () => Effect.succeed([])),
    )

  const getSessionGroups = (): Effect.Effect<SessionGroup[], SpaceControlUnavailable | CapabilityContractError> =>
    Effect.gen(function* () {
      const [rows, registeredSpaces] = yield* Effect.all([activeRows(), spacesOrEmpty()])
      const normalizedSpaces = registeredSpaces
        .map((space) => ({ ...space, path: normalizeWorkbenchPath(space.path) }))
        .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path))
      const grouped = new Map<string, { title: string; rows: RawSessionRow[] }>()
      const general = new Map<string, RawSessionRow[]>()

      for (const row of rows) {
        const match = normalizedSpaces.find((space) => isPathWithin(space.path, row.directory))
        if (match) {
          const bucket = grouped.get(match.id) ?? { title: match.name, rows: [] }
          bucket.rows.push(row)
          grouped.set(match.id, bucket)
          continue
        }
        const bucket = general.get(row.directory) ?? []
        bucket.push(row)
        general.set(row.directory, bucket)
      }

      const output: SessionGroup[] = []
      for (const [id, bucket] of grouped) {
        output.push({
          id,
          title: bucket.title,
          type: "space",
          sessionCount: bucket.rows.length,
          sessions: yield* summaries(bucket.rows, health),
        })
      }
      for (const [directory, bucket] of general) {
        output.push({
          id: directory,
          title: path.basename(directory) || directory,
          type: "general",
          sessionCount: bucket.length,
          sessions: yield* summaries(bucket, health),
        })
      }
      return output
    })

  const getSessionTree = (input?: { limitPerScope?: number }) =>
    Effect.gen(function* () {
      const [rows, registeredSpaces] = yield* Effect.all([activeRows(), spacesOrEmpty()], { concurrency: 2 })
      const resolvedSpaces = yield* canonicalSpaces(registeredSpaces)
      // Fetch projects per space. `wopal space projects list --space <name>`
      // returns paths relative to that space's root; resolve them to absolute
      // against the owning space's root before passing to the tree builder.
      // A single global fetch would only cover whichever space the serve CWD
      // happens to sit in, missing every other (dynamically created) space.
      const cli = CliContract.executablePath()
      const projectsPerSpace = yield* Effect.all(
        resolvedSpaces.map((space) =>
          registry.refreshProjects(cli, space.id).pipe(
            Effect.map((snapshot) =>
              snapshot.items.map((project) => {
                const absoluteProjectPath = resolveSpaceRootPath(space.path, project.path)
                const projectWorktrees = (project.worktrees ?? []).map((wt) => ({
                  projectPath: absoluteProjectPath,
                  path: resolveSpaceRootPath(space.path, wt.path),
                  branch: wt.branch,
                }))
                return {
                  name: project.name,
                  path: absoluteProjectPath,
                  worktrees: projectWorktrees,
                }
              }),
            ),
            Effect.catch((_cause) => Effect.succeed([])),
          ),
        ),
        { concurrency: 4 },
      )
      const rawProjects = projectsPerSpace.flat()
      const rawWorktrees = rawProjects.flatMap((p) => p.worktrees)
      const [resolvedProjects, worktrees] = yield* Effect.all(
        [canonicalProjects(rawProjects), canonicalWorktrees(rawWorktrees)],
        { concurrency: 2 },
      )
      const enriched = yield* Effect.all(
        rows.map((row) =>
          health.check(row.directory).pipe(
            Effect.map((directoryHealth) => ({
              id: row.id,
              title: row.title,
              directory: row.directory,
              timeCreated: row.time_created ?? 0,
              timeUpdated: row.time_updated ?? 0,
              directoryHealth,
            })),
          ),
        ),
        { concurrency: 16 },
      )
      return buildWorkbenchSessionTree({
        spaces: resolvedSpaces,
        projects: resolvedProjects,
        worktrees,
        sessions: enriched,
        limitPerScope: Math.min(Math.max(input?.limitPerScope ?? 200, 1), MAX_LIMIT_PER_SCOPE),
      })
    })

  const getLocations = (input: { spacePath: string; query?: string }) =>
    Effect.gen(function* () {
      const registeredSpaces = yield* spaces()
      const canonical = yield* canonicalSpaces(registeredSpaces)
      const requested = normalizeWorkbenchPath(input.spacePath)
      const space = canonical.find((item) => item.path === requested)
      if (!space) {
        return yield* new WorkbenchSpaceNotFound({
          message: `Registered Space not found: ${input.spacePath}`,
          spacePath: input.spacePath,
        })
      }
      const cli = CliContract.executablePath()
      const [projects, rows, searched] = yield* Effect.all(
        [
          registry.refreshProjects(cli, space.id),
          activeRows(),
          input.query?.trim()
            ? registry.searchSpace(cli, input.query.trim(), space.id, "dir")
            : Effect.succeed({ items: [], total: 0, refreshedAt: 0 }),
        ],
        { concurrency: 3 },
      )
      const candidates: Array<{ kind: WorkbenchLocation["kind"]; name: string; path: string; lastUsedAt?: number }> = [
        { kind: "space-root" as const, name: space.name, path: space.path },
        ...projects.items.map((item) => ({ kind: "project" as const, name: item.name, path: item.path })),
        ...rows.map((row) => ({
          kind: "recent" as const,
          name: path.basename(row.directory) || row.directory,
          path: row.directory,
          lastUsedAt: row.time_updated ?? 0,
        })),
        ...searched.items.map((item) => ({ kind: "search" as const, name: item.name, path: item.path })),
      ]
      const resolved = yield* Effect.all(
        candidates.map((candidate) =>
          canonicalLocation(space.path, candidate.path).pipe(
            Effect.map((resolvedPath) => (resolvedPath ? { ...candidate, path: resolvedPath } : undefined)),
          ),
        ),
        { concurrency: 16 },
      )
      const rank = { "space-root": 0, project: 1, recent: 2, search: 3 }
      const seen = new Set<string>()
      const items = resolved
        .filter((item): item is Exclude<typeof item, undefined> => item !== undefined)
        .sort(
          (a, b) =>
            rank[a.kind] - rank[b.kind] ||
            (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
            a.name.localeCompare(b.name) ||
            a.path.localeCompare(b.path),
        )
        .filter((item) => {
          if (seen.has(item.path)) return false
          seen.add(item.path)
          return true
        })
        .map((item) => ({
          key: `${item.kind}:${item.path}`,
          kind: item.kind,
          name: item.name,
          path: item.path,
          relativeDirectory: relativeDirectory(space.path, item.path),
          lastUsedAt: item.lastUsedAt || undefined,
        }))
      const recent = items.filter((item) => item.kind === "recent").slice(0, 20)
      return { scopePath: space.path, items: [...items.filter((item) => item.kind !== "recent"), ...recent] }
    })

  return Service.of({ getSessionGroups, getSessionSummary, getSessionTree, getLocations })
})

function summaries(rows: RawSessionRow[], health: SessionDirectoryHealth) {
  return Effect.all(
    rows.map((row) =>
      health.check(row.directory).pipe(
        Effect.map((directoryHealth) => ({
          id: row.id,
          title: row.title,
          directory: row.directory,
          directoryHealth,
          agent: row.agent ?? undefined,
          timeCreated: row.time_created ?? 0,
          timeUpdated: row.time_updated ?? 0,
          timeArchived: row.time_archived ?? undefined,
        })),
      ),
    ),
    { concurrency: 16 },
  )
}

function canonicalSpaces(spaces: SpaceEntry[]) {
  return Effect.all(
    spaces.map((space) =>
      canonicalPath(space.path).pipe(Effect.map((resolved) => ({ id: space.id, name: space.name, path: resolved }))),
    ),
    { concurrency: 16 },
  )
}

function canonicalProjects(projects: Array<{ name: string; path: string }>) {
  return Effect.all(
    projects.map((project) =>
      canonicalPath(project.path).pipe(Effect.map((resolved) => ({ name: project.name, path: resolved }))),
    ),
    { concurrency: 16 },
  )
}

function canonicalPath(value: string) {
  return Effect.tryPromise(() => realpath(value)).pipe(
    Effect.catch(() => Effect.succeed(value)),
    Effect.map(normalizeWorkbenchPath),
  )
}

function canonicalLocation(root: string, value: string) {
  // `value` may be relative to the requesting space's root (project / search
  // candidates from `--space`-scoped CLI calls). Resolve it against `root`
  // before realpath + containment check.
  return canonicalPath(resolveSpaceRootPath(root, value)).pipe(
    Effect.map((candidate) => (isPathWithin(root, candidate) ? candidate : undefined)),
  )
}

function relativeDirectory(root: string, target: string) {
  const value = path.relative(root, target).replaceAll("\\", "/")
  return value === "" ? "" : value
}

function canonicalWorktrees(worktrees: Array<{ projectPath: string; path: string; branch?: string }>) {
  return Effect.all(
    worktrees.map((wt) =>
      Effect.all([canonicalPath(wt.projectPath), canonicalPath(wt.path)]).pipe(
        Effect.map(([canonicalProj, canonicalWt]) => ({
          projectPath: canonicalProj,
          path: canonicalWt,
          branch: wt.branch,
        })),
      ),
    ),
    { concurrency: 16 },
  )
}

export const layer = Layer.effect(Service, make)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionDirectoryHealth.defaultLayer),
  Layer.provide(SpaceRegistry.defaultLayer),
)

export * as SessionProjection from "./session-projection"
