import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Effect, Context, Layer, Schema } from "effect"
import ignore from "ignore"
import path from "path"
import { File, readFileContent } from "@/file"
import { CliContract } from "@/wopal/cli-contract"
import { CapabilityContractError, SpaceControlUnavailable, type SpaceEntry } from "@/wopal/cli-schema"
import { SpaceRegistry } from "@/wopal/space-registry"
import { isPathWithin, normalizeWorkbenchPath } from "./session-tree"

export class SpaceFilesSpaceNotFound extends Schema.TaggedErrorClass<SpaceFilesSpaceNotFound>()(
  "SpaceFilesSpaceNotFound",
  { message: Schema.String, spacePath: Schema.String },
) {}

export class SpaceFilesAccessDenied extends Schema.TaggedErrorClass<SpaceFilesAccessDenied>()(
  "SpaceFilesAccessDenied",
  { message: Schema.String, path: Schema.String },
) {}

export class SpaceFilesNotFound extends Schema.TaggedErrorClass<SpaceFilesNotFound>()("SpaceFilesNotFound", {
  message: Schema.String,
  path: Schema.String,
}) {}

export type SpaceFilesError =
  | SpaceFilesSpaceNotFound
  | SpaceFilesAccessDenied
  | SpaceFilesNotFound
  | SpaceControlUnavailable
  | CapabilityContractError

export interface SpaceFiles {
  readonly list: (input: { spacePath: string; path?: string }) => Effect.Effect<File.Node[], SpaceFilesError>
  readonly read: (input: { spacePath: string; path: string }) => Effect.Effect<File.Content, SpaceFilesError>
}

export class Service extends Context.Service<Service, SpaceFiles>()("@opencode/WorkbenchSpaceFiles") {}

type ResolvedPath = {
  root: string
  target: string
  relative: string
}

const excluded = new Set([".git", ".DS_Store"])

const make = Effect.gen(function* () {
  const fs = yield* AppFileSystem.Service
  const registry = yield* SpaceRegistry.Service

  const resolveRegisteredRoot = (spacePath: string) =>
    Effect.gen(function* () {
      if (!path.isAbsolute(spacePath) || hasParentSegment(spacePath)) {
        return yield* new SpaceFilesAccessDenied({
          message: "Space path must be an absolute registered Space root",
          path: spacePath,
        })
      }

      const requested = normalizeWorkbenchPath(spacePath)
      const cached = yield* registry.getSpaces()
      const initial =
        cached.spaces.length > 0 ? cached.spaces : (yield* registry.refreshSpaces(CliContract.executablePath())).spaces
      let space = yield* findRegisteredSpace(initial, requested, fs)
      // A Workspace renderer can observe a newly registered Space before its
      // process-wide registry cache has been refreshed. Retrying only a miss
      // keeps the common path cheap while preserving the root-only boundary.
      if (!space && cached.spaces.length > 0) {
        const refreshed = (yield* registry.refreshSpaces(CliContract.executablePath())).spaces
        space = yield* findRegisteredSpace(refreshed, requested, fs)
      }
      if (!space) {
        return yield* new SpaceFilesSpaceNotFound({
          message: `Registered Space not found: ${spacePath}`,
          spacePath,
        })
      }

      return yield* fs.realPath(space.path).pipe(
        Effect.map(normalizeWorkbenchPath),
        Effect.catch(() =>
          Effect.fail(
            new SpaceFilesSpaceNotFound({
              message: `Registered Space is unavailable: ${space.path}`,
              spacePath,
            }),
          ),
        ),
      )
    })

  const resolve = (input: { spacePath: string; path?: string }) =>
    Effect.gen(function* () {
      const root = yield* resolveRegisteredRoot(input.spacePath)
      const relative = yield* relativePath(input.path)
      const lexical = path.resolve(root, relative || ".")
      if (!isPathWithin(root, lexical)) {
        return yield* new SpaceFilesAccessDenied({
          message: "Path escapes the registered Space root",
          path: input.path ?? "",
        })
      }
      const target = yield* fs.realPath(lexical).pipe(
        Effect.map(normalizeWorkbenchPath),
        Effect.catch(() =>
          Effect.fail(
            new SpaceFilesNotFound({
              message: `Space path not found: ${input.path ?? ""}`,
              path: input.path ?? "",
            }),
          ),
        ),
      )
      if (!isPathWithin(root, target)) {
        return yield* new SpaceFilesAccessDenied({
          message: "Resolved path escapes the registered Space root",
          path: input.path ?? "",
        })
      }
      return { root, target, relative } satisfies ResolvedPath
    })

  const list: SpaceFiles["list"] = Effect.fn("WorkbenchSpaceFiles.list")(function* (input) {
    const resolved = yield* resolve(input)
    if (!(yield* fs.isDir(resolved.target))) {
      return yield* new SpaceFilesNotFound({
        message: `Space path is not a directory: ${input.path ?? ""}`,
        path: input.path ?? "",
      })
    }

    const ignored = yield* ignoredPaths(resolved.root, fs)
    const entries = yield* fs.readDirectoryEntries(resolved.target).pipe(
      Effect.catch(() =>
        Effect.fail(
          new SpaceFilesNotFound({
            message: `Space directory not found: ${input.path ?? ""}`,
            path: input.path ?? "",
          }),
        ),
      ),
    )
    const nodes: File.Node[] = []
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue
      const absolute = path.join(resolved.target, entry.name)
      if (entry.type === "symlink" && !(yield* symlinkRemainsInRoot(absolute, resolved.root, fs))) continue
      const relative = path.relative(resolved.root, absolute).replaceAll("\\", "/")
      const isDirectory = entry.type === "directory" || (entry.type === "symlink" && (yield* fs.isDir(absolute)))
      nodes.push({
        name: entry.name,
        path: relative,
        absolute,
        type: isDirectory ? "directory" : "file",
        ignored: ignored(isDirectory ? `${relative}/` : relative),
      })
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  })

  const read: SpaceFiles["read"] = Effect.fn("WorkbenchSpaceFiles.read")(function* (input) {
    const resolved = yield* resolve(input)
    if (!(yield* fs.isFile(resolved.target))) {
      return yield* new SpaceFilesNotFound({
        message: `Space file not found: ${input.path}`,
        path: input.path,
      })
    }
    return yield* readFileContent(fs, resolved.relative, resolved.target)
  })

  return Service.of({ list, read })
})

function findRegisteredSpace(spaces: SpaceEntry[], requested: string, fs: AppFileSystem.Interface) {
  const direct = spaces.find((space) => normalizeWorkbenchPath(space.path) === requested)
  if (direct) return Effect.succeed(direct)
  return Effect.all(
    spaces.map((space) =>
      fs.realPath(space.path).pipe(
        Effect.map((value) => ({ space, path: normalizeWorkbenchPath(value) })),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ),
  ).pipe(Effect.map((items) => items.find((item) => item?.path === requested)?.space))
}

function relativePath(value: string | undefined): Effect.Effect<string, SpaceFilesAccessDenied> {
  const original = value ?? ""
  const normalized = original.replaceAll("\\", "/")
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(original) || hasParentSegment(normalized)) {
    return Effect.fail(
      new SpaceFilesAccessDenied({
        message: "Path must be relative to the registered Space root without parent traversal",
        path: original,
      }),
    )
  }
  return Effect.succeed(
    normalized
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/"),
  )
}

function hasParentSegment(value: string) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => part === "..")
}

function symlinkRemainsInRoot(target: string, root: string, fs: AppFileSystem.Interface) {
  return fs.realPath(target).pipe(
    Effect.map((resolved) => isPathWithin(root, normalizeWorkbenchPath(resolved))),
    // File.list classifies dangling links as files. Preserve that visible-node
    // convention while direct traversal still requires a successful real path.
    Effect.catch(() => Effect.succeed(true)),
  )
}

function ignoredPaths(root: string, fs: AppFileSystem.Interface) {
  return Effect.gen(function* () {
    const isGit = yield* fs.exists(path.join(root, ".git")).pipe(Effect.catch(() => Effect.succeed(false)))
    if (!isGit) return (_path: string) => false

    const matcher = ignore()
    for (const name of [".gitignore", ".ignore"]) {
      const content = yield* fs.readFileString(path.join(root, name)).pipe(Effect.catch(() => Effect.succeed("")))
      if (content) matcher.add(content)
    }
    return matcher.ignores.bind(matcher)
  })
}

export const layer = Layer.effect(Service, make)

export * as SpaceFiles from "./space-files"
