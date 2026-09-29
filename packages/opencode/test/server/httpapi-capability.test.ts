import { describe, expect } from "bun:test"
import { Global } from "@wopal/ellamaka-core/global"
import { Context, Effect, Layer, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Rule } from "../../src/rule"
import { ToolCapabilityInfo } from "../../src/server/routes/instance/httpapi/groups/instance"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.makeUnsafe<unknown>(new Map())

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)

// MCP is also built as a test-side service so the discovery surface can be
// cross-checked against the runtime mount (`MCP.tools()`) for the same instance.
const it = testEffect(Layer.mergeAll(testStateLayer, MCP.defaultLayer))

// Other test files in the same process dispose the shared HttpApiApp.webHandler()
// singleton. Disposing closes that build's layer scope, which closes the
// ScopedCaches `InstanceState` created in it; a later first-use request for such
// a cache (rule discovery is created lazily) is interrupted and surfaces as an
// empty 503. Resetting the lazy singleton before each acquire forces a fresh
// layer build, so this file always serves against live caches. Resetting again
// after the release leaves a rebuildable singleton behind instead of a disposed
// one for whichever file runs next.
const handlerScoped = Effect.acquireRelease(
  Effect.sync(() => {
    HttpApiApp.webHandler.reset()
    return HttpApiApp.webHandler()
  }),
  (handler) =>
    Effect.promise(async () => {
      await handler.dispose().catch(() => {})
      HttpApiApp.webHandler.reset()
    }),
)

type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  options?: { directory?: string; query?: string },
) {
  const url = new URL(`http://localhost${route}${options?.query ?? ""}`)
  const headers = new Headers()
  if (options?.directory) headers.set("x-opencode-directory", options.directory)
  const response = yield* Effect.promise(() => Promise.resolve(handler.handler(new Request(url, { headers }), context)))
  const text = yield* Effect.promise(() => response.text())
  return { status: response.status, text }
})

const RuleCapabilities = Schema.Array(Rule.Info)
const ToolCapabilities = Schema.Array(ToolCapabilityInfo)
const Agents = Schema.Array(Schema.Struct({ name: Schema.String, permission: Permission.Ruleset }))

// Raw-shape helpers assert the wire payload itself, before schema decoding can
// normalize anything away (e.g. an accidental `execute` field).
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const unexpectedKeys = (value: unknown, allowed: string[]) =>
  Object.keys(asRecord(value) ?? {}).filter((key) => !allowed.includes(key))

// The global rule layer lives in the per-PID isolated WOPAL_HOME created by
// test/preload.ts. Use unique file names and remove them on scope exit so the
// shared test home stays clean for other files.
const writeGlobalRule = (name: string, content: string) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      Bun.write(path.join(Global.Path.wopalHome, "rules", name), content).then(() =>
        path.join(Global.Path.wopalHome, "rules", name),
      ),
    ),
    (file) => Effect.promise(() => fs.rm(file, { force: true })),
  )

describe("capability discovery HttpApi", () => {
  it.instance(
    "serves discovered rules and resolves the directory query parameter",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped
        const other = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const dir = path.join(Global.Path.tmp, `capability-other-${crypto.randomUUID()}`)
            await fs.mkdir(dir, { recursive: true })
            return dir
          }),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
        )

        yield* writeGlobalRule(
          "capability-discovery-global.md",
          "---\ndescription: Global capability rule\nkeywords: [global]\n---\nbody\n",
        )
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(tmp.directory, ".wopal", "rules"), { recursive: true })
          await fs.writeFile(path.join(tmp.directory, ".wopal", ".git"), "")
          await fs.writeFile(
            path.join(tmp.directory, ".wopal", "rules", "capability-discovery-global.md"),
            "---\ndescription: Space override rule\n---\nbody\n",
          )
          await fs.writeFile(
            path.join(tmp.directory, ".wopal", "rules", "capability-discovery-space.mdc"),
            "---\ndescription: Space only rule\n---\nbody\n",
          )
        })

        // The directory query parameter (declared on the endpoint, like /skill)
        // routes the request to the target instance and is never rejected as 400.
        const targeted = yield* request(handler, "/rule", {
          query: `?directory=${encodeURIComponent(tmp.directory)}`,
        })
        expect(targeted.status).toBe(200)
        const rules = Schema.decodeUnknownSync(RuleCapabilities)(JSON.parse(targeted.text))
        const shared = rules.find((rule) => rule.name === "capability-discovery-global.md")
        expect(shared).toMatchObject({
          description: "Space override rule",
          source: "space",
          location: path.join(tmp.directory, ".wopal", "rules", "capability-discovery-global.md"),
        })
        expect(rules.find((rule) => rule.name === "capability-discovery-space.mdc")).toMatchObject({
          description: "Space only rule",
          source: "space",
        })
        expect(shared?.keywords).toBeUndefined()

        // A non-space directory resolves a different instance: only the global layer applies.
        const untargeted = yield* request(handler, "/rule", {
          query: `?directory=${encodeURIComponent(other)}`,
        })
        expect(untargeted.status).toBe(200)
        const otherRules = Schema.decodeUnknownSync(RuleCapabilities)(JSON.parse(untargeted.text)).filter((rule) =>
          rule.name.startsWith("capability-discovery-"),
        )
        expect(otherRules.map((rule) => rule.name)).toEqual(["capability-discovery-global.md"])
        expect(otherRules[0]?.source).toBe("global")
        expect(otherRules[0]?.description).toBe("Global capability rule")
      }),
    { git: true },
  )

  it.instance(
    "serves builtin and custom tools as metadata only",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped

        yield* Effect.promise(() =>
          Bun.write(
            path.join(tmp.directory, ".opencode", "tool", "capability_hello.ts"),
            [
              "export default {",
              "  description: 'capability hello tool',",
              "  args: { name: { type: 'string' } },",
              "  execute: async () => 'hello',",
              "}",
              "",
            ].join("\n"),
          ),
        )

        const response = yield* request(handler, "/tool", { directory: tmp.directory })
        expect(response.status).toBe(200)
        const raw: unknown = JSON.parse(response.text)
        const tools = Schema.decodeUnknownSync(ToolCapabilities)(JSON.parse(response.text))

        // Runtime filtering in ToolRegistry.tools() drops websearch for
        // non-opencode providers and rewrites task/skill descriptions; the
        // discovery endpoint must not go through that path.
        expect(tools.map((tool) => tool.id)).toContain("websearch")
        const task = tools.find((tool) => tool.id === "task")
        expect(task?.description).not.toContain("Available agent types")

        expect(tools.find((tool) => tool.id === "bash")).toMatchObject({ id: "bash", source: "builtin" })
        expect(tools.find((tool) => tool.id === "read")?.parameters).toContainEqual({
          name: "filePath",
          type: "string",
        })
        expect(tools.find((tool) => tool.id === "capability_hello")).toMatchObject({
          id: "capability_hello",
          source: "custom",
          description: "capability hello tool",
        })

        // Metadata only: no runtime fields, no JSON Schema bodies.
        const allowed = ["id", "description", "source", "service", "parameters"]
        for (const item of asArray(raw)) {
          expect(unexpectedKeys(item, allowed)).toEqual([])
          for (const parameter of asArray(asRecord(item)?.parameters)) {
            expect(unexpectedKeys(parameter, ["name", "type"])).toEqual([])
          }
        }
      }),
    { git: true },
  )

  it.instance(
    "serves mcp tools with the raw service key and the runtime composite id",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped

        const response = yield* request(handler, "/tool", { directory: tmp.directory })
        expect(response.status).toBe(200)
        const tools = Schema.decodeUnknownSync(ToolCapabilities)(JSON.parse(response.text))

        // The configured key (`fixture.server`) is preserved while the id uses
        // the same sanitized composite key MCP.tools() mounts.
        const entry = tools.find((tool) => tool.id === "fixture_server_fixture_tool_one")
        expect(entry).toMatchObject({
          id: "fixture_server_fixture_tool_one",
          source: "mcp",
          service: "fixture.server",
          description: "Fixture tool one",
        })
        expect(entry?.parameters).toEqual([
          { name: "path", type: "string" },
          { name: "count", type: "number" },
        ])
        expect(unexpectedKeys(entry, ["id", "description", "source", "service", "parameters"])).toEqual([])
      }),
    {
      git: true,
      config: {
        mcp: {
          "fixture.server": {
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "..", "fixture", "mcp-capability-server.ts")],
            enabled: true,
            timeout: 15000,
          },
        },
      },
    },
  )

  it.instance(
    "aligns mcp discovery with the runtime mount on sanitized key collisions",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped

        const response = yield* request(handler, "/tool", { directory: tmp.directory })
        expect(response.status).toBe(200)
        const discovered = Schema.decodeUnknownSync(ToolCapabilities)(JSON.parse(response.text)).filter(
          (tool) => tool.source === "mcp",
        )

        // Two raw tool names (`fixture.collide.one`, `fixture.collide/one`)
        // sanitize to the same composite key. Only the runtime winner may be
        // exposed: one entry, built from the last tool in the server's list.
        const collided = discovered.filter((tool) => tool.id === "fixture_server_fixture_collide_one")
        expect(collided).toHaveLength(1)
        expect(collided[0]).toMatchObject({
          id: "fixture_server_fixture_collide_one",
          source: "mcp",
          service: "fixture.server",
          description: "Fixture collision winner",
        })
        expect(collided[0]?.parameters).toEqual([{ name: "winner", type: "string" }])

        // Cross-check: the discovered mcp id set equals the runtime mount keys.
        const mcp = yield* MCP.Service
        const runtimeIds = Object.keys(yield* mcp.tools()).toSorted()
        expect(runtimeIds).toEqual(["fixture_server_fixture_collide_one", "fixture_server_fixture_tool_one"])
        expect(discovered.map((tool) => tool.id).toSorted()).toEqual(runtimeIds)
      }),
    {
      git: true,
      config: {
        mcp: {
          "fixture.server": {
            type: "local",
            command: [process.execPath, path.join(import.meta.dir, "..", "fixture", "mcp-capability-server.ts")],
            enabled: true,
            timeout: 15000,
          },
        },
      },
    },
  )

  it.instance(
    "lists entries that a permission-restricted agent is denied at runtime",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = yield* handlerScoped

        const agents = yield* request(handler, "/agent", { directory: tmp.directory })
        expect(agents.status).toBe(200)
        const restricted = Schema.decodeUnknownSync(Agents)(JSON.parse(agents.text)).find(
          (agent) => agent.name === "capability-restricted",
        )
        expect(restricted).toBeDefined()
        expect(Permission.evaluate("bash", "bash", restricted!.permission).action).toBe("deny")

        const response = yield* request(handler, "/tool", { directory: tmp.directory })
        expect(response.status).toBe(200)
        const tools = Schema.decodeUnknownSync(ToolCapabilities)(JSON.parse(response.text))
        expect(tools.find((tool) => tool.id === "bash")).toMatchObject({ id: "bash", source: "builtin" })
      }),
    {
      git: true,
      config: {
        agent: {
          "capability-restricted": {
            permission: { bash: "deny" },
          },
        },
      },
    },
  )
})
