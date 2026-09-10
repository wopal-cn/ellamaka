import { NodeHttpServer } from "@effect/platform-node"
import { mkdir, symlink } from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { SessionDirectoryHealth } from "../../src/workbench/session-directory-health"
import { SessionProjection } from "../../src/workbench/session-projection"
import { SessionStatus } from "../../src/session/status"
import { SpaceFiles } from "../../src/workbench/space-files"
import { layer as workbenchDshUrlLayer } from "../../src/workbench/dsh-url"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
import { CliContract } from "../../src/wopal/cli-contract"
import { SpaceRegistry } from "../../src/wopal/space-registry"
import type { SpaceEntry } from "../../src/wopal/cli-schema"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { WorkbenchPaths } from "../../src/server/routes/instance/httpapi/groups/workbench"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { wopalSpaceHandlers } from "../../src/server/routes/instance/httpapi/handlers/wopal-space"
import { workbenchHandlers } from "../../src/server/routes/instance/httpapi/handlers/workbench"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let spaces: SpaceEntry[] = []
let emptySpaceCache = false
let cachedSpaces: SpaceEntry[] = []
let refreshes = 0

const registryLayer = Layer.succeed(SpaceRegistry.Service, {
  getSpaces: () => Effect.sync(() => ({ spaces: emptySpaceCache ? [] : cachedSpaces, refreshedAt: 1 })),
  refreshSpaces: () =>
    Effect.sync(() => {
      refreshes += 1
      return { spaces, refreshedAt: 1 }
    }),
  refreshProjects: () => Effect.succeed({ items: [], total: 0, refreshedAt: 1 }),
  searchSpace: () => Effect.succeed({ items: [], total: 0, refreshedAt: 1 }),
})

const routes = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, globalHandlers, wopalSpaceHandlers, workbenchHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(CliContract.defaultLayer),
  Layer.provide(SessionProjection.layer),
  Layer.provide(SessionDirectoryHealth.defaultLayer),
  Layer.provide(SpaceFiles.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(registryLayer),
  Layer.provide(workbenchDshUrlLayer),
  // Raw HttpApi routes expose an opaque handler context at the web boundary.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Layer.provide(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
)

const workbenchRoutes = routes.pipe(Layer.provideMerge(SessionStatus.defaultLayer))
const it = testEffect(
  workbenchRoutes.pipe(
    Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
    Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
  ),
)

function registerSpace(directory: string, options?: { coldStart?: boolean; cachedSpaces?: SpaceEntry[] }) {
  spaces = [{ id: "space", name: "space", path: directory, type: "local" }]
  cachedSpaces = options?.cachedSpaces ?? spaces
  emptySpaceCache = options?.coldStart ?? false
  refreshes = 0
  return Effect.addFinalizer(() =>
    Effect.sync(() => {
      spaces = []
      cachedSpaces = []
      emptySpaceCache = false
      refreshes = 0
    }),
  )
}

function files(directory: string, relative?: string) {
  const query = new URLSearchParams({ spacePath: directory })
  if (relative !== undefined) query.set("path", relative)
  return HttpClient.get(`${WorkbenchPaths.files}?${query}`)
}

function fileContent(directory: string, relative: string) {
  const query = new URLSearchParams({ spacePath: directory, path: relative })
  return HttpClient.get(`${WorkbenchPaths.fileContent}?${query}`)
}

describe("workbench space files", () => {
  it.live("lists a registered Space child without a directory header or instance bootstrap", () =>
    Effect.gen(function* () {
      const space = yield* tmpdirScoped()
      yield* registerSpace(space)
      const child = path.join(space, "child")
      yield* Effect.promise(async () => {
        await mkdir(child)
        await Bun.write(path.join(child, "visible.txt"), "visible")
        await Bun.write(path.join(child, ".hidden"), "hidden")
        await Bun.write(path.join(child, ".gitignore"), "ignored.txt\n")
        await Bun.write(path.join(child, "ignored.txt"), "ignored")
        await Bun.write(path.join(space, ".gitignore"), "child/ignored.txt\n")
        await mkdir(path.join(space, ".git"))
        await Bun.write(path.join(child, ".DS_Store"), "metadata")
      })

      const response = yield* files(space, "child")

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([
        {
          name: ".gitignore",
          path: "child/.gitignore",
          absolute: path.join(child, ".gitignore"),
          type: "file",
          ignored: false,
        },
        { name: ".hidden", path: "child/.hidden", absolute: path.join(child, ".hidden"), type: "file", ignored: false },
        {
          name: "ignored.txt",
          path: "child/ignored.txt",
          absolute: path.join(child, "ignored.txt"),
          type: "file",
          ignored: true,
        },
        {
          name: "visible.txt",
          path: "child/visible.txt",
          absolute: path.join(child, "visible.txt"),
          type: "file",
          ignored: false,
        },
      ])
    }),
  )

  it.live("reads text, image, and binary content without booting an instance", () =>
    Effect.gen(function* () {
      const space = yield* tmpdirScoped()
      yield* registerSpace(space)
      const image = new Uint8Array([137, 80, 78, 71])
      yield* Effect.promise(async () => {
        await Bun.write(path.join(space, "note.txt"), " hello ")
        await Bun.write(path.join(space, "image.png"), image)
        await Bun.write(path.join(space, "archive.pdf"), new Uint8Array([37, 80, 68, 70]))
      })

      const [text, imageResponse, binary] = yield* Effect.all(
        [fileContent(space, "note.txt"), fileContent(space, "image.png"), fileContent(space, "archive.pdf")],
        { concurrency: "unbounded" },
      )

      expect(text.status).toBe(200)
      expect(yield* text.json).toEqual({ type: "text", content: "hello" })
      expect(imageResponse.status).toBe(200)
      expect(yield* imageResponse.json).toEqual({
        type: "text",
        content: Buffer.from(image).toString("base64"),
        mimeType: "image/png",
        encoding: "base64",
      })
      expect(binary.status).toBe(200)
      expect(yield* binary.json).toEqual({ type: "binary", content: "" })
    }),
  )

  it.live("refreshes an empty SpaceRegistry snapshot before reading a persisted file", () =>
    Effect.gen(function* () {
      const space = yield* tmpdirScoped()
      yield* registerSpace(space, { coldStart: true })
      yield* Effect.promise(() => Bun.write(path.join(space, "restored.txt"), "restored"))

      const response = yield* fileContent(space, "restored.txt")

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ type: "text", content: "restored" })
    }),
  )

  it.live("refreshes a nonempty stale SpaceRegistry snapshot before reading a newly registered Space", () =>
    Effect.gen(function* () {
      const staleSpace = yield* tmpdirScoped()
      const space = yield* tmpdirScoped()
      yield* registerSpace(space, {
        cachedSpaces: [{ id: "stale", name: "stale", path: staleSpace, type: "local" }],
      })
      yield* Effect.promise(() => Bun.write(path.join(space, "new-space.txt"), "new space"))

      const response = yield* fileContent(space, "new-space.txt")

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ type: "text", content: "new space" })
      expect(refreshes).toBe(1)
    }),
  )

  it.live("rejects unregistered roots, traversal, and symlinks that resolve outside the registered Space", () =>
    Effect.gen(function* () {
      const space = yield* tmpdirScoped()
      yield* registerSpace(space)
      yield* Effect.promise(() => symlink(path.dirname(space), path.join(space, "escape")))

      const [unknown, traversal, escaped, contentTraversal, contentEscaped] = yield* Effect.all(
        [
          files(path.join(space, "unregistered")),
          files(space, "../outside"),
          files(space, "escape"),
          fileContent(space, "../outside"),
          fileContent(space, "escape"),
        ],
        { concurrency: "unbounded" },
      )

      expect(unknown.status).toBe(404)
      expect(traversal.status).toBe(403)
      expect(escaped.status).toBe(403)
      expect(contentTraversal.status).toBe(403)
      expect(contentEscaped.status).toBe(403)
    }),
  )
})
