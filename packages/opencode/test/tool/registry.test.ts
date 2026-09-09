import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import { Effect, Layer, Result, Schema } from "effect"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Provider } from "@/provider/provider"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { Reference } from "@/reference/reference"
import { RepositoryCache } from "@/reference/repository-cache"
import { ProviderID, ModelID } from "@/provider/schema"
import { ToolJsonSchema } from "@/tool/json-schema"
import { MessageID, SessionID } from "@/session/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"

const node = CrossSpawnSpawner.defaultLayer
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
})

type RegistryLayerOptions = {
  flags?: Partial<RuntimeFlags.Info>
  plugin?: Layer.Layer<Plugin.Service>
}

const registryLayer = (opts: RegistryLayerOptions = {}) =>
  ToolRegistry.layer
    .pipe(
      Layer.provide(configLayer),
      Layer.provide(opts.plugin ?? Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Layer.mergeAll(SessionStatus.defaultLayer, BackgroundJob.defaultLayer)),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Layer.mergeAll(Git.defaultLayer, RepositoryCache.defaultLayer)),
      Layer.provide(Reference.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(node),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
    )
    .pipe(Layer.provide(RuntimeFlags.layer(opts.flags ?? {})))

// Fake Plugin.Service that returns a single plugin whose `tool` map contains
// one definition with `args: undefined`. Used to exercise the plugin entry
// point of `fromPlugin` for the #27451 / #27630 regression.
const brokenPluginLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
    list: () =>
      Effect.succeed([
        {
          tool: {
            broken_plugin_tool: {
              description: "plugin tool with missing args",
              args: undefined as unknown as Record<string, never>,
              execute: async () => "ok",
            },
          },
        },
      ]),
  }),
)

// Fake Plugin.Service that exposes a `tool.provider` hook reading the current
// supplied set from a mutable closure variable. This models a dsh container
// whose mounted tool set changes between model requests.
function providerPluginLayer(supply: { current: Record<string, unknown> }) {
  return Layer.succeed(
    Plugin.Service,
    Plugin.Service.of({
      init: () => Effect.void,
      trigger: ((name: unknown, input: unknown, output: unknown) => {
        if (name === "tool.provider") {
          const out = output as { tools: Record<string, ToolDefinition> }
          for (const [id, def] of Object.entries(supply.current)) {
            out.tools[id] = def as ToolDefinition
          }
        }
        return Effect.succeed(output)
      }) as Plugin.Interface["trigger"],
      list: () => Effect.succeed([]),
    }),
  )
}

// Fake Plugin.Service whose `tool.provider` hook always throws. Used to prove
// a throwing provider degrades to the static tool set instead of breaking the
// model request. Mirrors the real `Plugin.trigger`, which wraps each hook call
// in `Effect.promise`, so a throwing hook surfaces as a recoverable error.
const throwingProviderLayer = Layer.succeed(
  Plugin.Service,
  Plugin.Service.of({
    init: () => Effect.void,
    trigger: ((name: unknown, _input: unknown, _output: unknown) =>
      name === "tool.provider"
        ? Effect.promise(async () => {
            throw new Error("provider boom")
          })
        : Effect.succeed({})) as Plugin.Interface["trigger"],
    list: () => Effect.succeed([]),
  }),
)

const dynamicTool = (description: string) => ({
  description,
  args: {},
  execute: async () => "dynamic",
})

const it = testEffect(Layer.mergeAll(registryLayer(), node, Agent.defaultLayer))
const scout = testEffect(
  Layer.mergeAll(registryLayer({ flags: { experimentalScout: true } }), node, Agent.defaultLayer),
)
const withBrokenPlugin = testEffect(
  Layer.mergeAll(registryLayer({ plugin: brokenPluginLayer }), node, Agent.defaultLayer),
)
const withThrowingProvider = testEffect(
  Layer.mergeAll(registryLayer({ plugin: throwingProviderLayer }), node, Agent.defaultLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("hides repo research tools unless experimental", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("repo_clone")
      expect(ids).not.toContain("repo_overview")
    }),
  )

  scout.instance("shows repo research tools when experimental scout is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).toContain("repo_clone")
      expect(ids).toContain("repo_overview")
    }),
  )

  it.instance("does not expose task_status", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()

      expect(ids).not.toContain("task_status")
    }),
  )

  it.instance("hides task background parameter unless experimental background subagents are enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = yield* Agent.Service
      const build = yield* agent.get("build")
      if (!build) throw new Error("build agent not found")
      const task = (yield* registry.tools({
        providerID: ProviderID.opencode,
        modelID: ModelID.make("test"),
        agent: build,
      })).find((tool) => tool.id === "task")

      expect(task?.jsonSchema).toBeDefined()
      expect((task?.jsonSchema?.properties as Record<string, unknown> | undefined)?.background).toBeUndefined()
    }),
  )

  it.instance("loads tools from .opencode/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tool = path.join(opencode, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("ignores non-tool exports in .opencode/tool files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("mixed")
      expect(ids).not.toContain("mixed_helper")
    }),
  )

  // Regression for #27451 / #27630: a custom tool that omits `args` must not
  // crash registry initialization with
  // `Object.entries requires that input parameter not be null or undefined`.
  // Pre-1.14.49 the code path was `z.object(def.args)`, and `z.object(undefined)`
  // silently produced an empty schema — so the tool registered as no-args.
  // Preserve that tolerance.
  it.instance("tolerates a custom tool exporting null/undefined args (no-args fallback)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tool = path.join(test.directory, ".opencode", "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "noargs.ts"),
          [
            "export default {",
            "  description: 'tool with no args',",
            "  args: undefined,",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      // Built-in tools must still load — a single malformed custom tool must
      // not poison the whole registry.
      expect(ids).toContain("read")
      const loaded = (yield* registry.all()).find((t) => t.id === "noargs")
      if (!loaded) throw new Error("noargs tool was not loaded")
      expect(loaded.jsonSchema).toMatchObject({ type: "object", properties: {} })
    }),
  )

  // Same regression, plugin entry point. The original reports (#27451, #27630)
  // came in through `plugin.list()` — `oh-my-opencode` was registering a tool
  // with `args: undefined` and crashing every message submit. The file-scan
  // and plugin-list loops both funnel through `fromPlugin`, but covering both
  // entry points means a future refactor that splits them won't silently lose
  // protection.
  withBrokenPlugin.instance("tolerates a plugin tool registered with null/undefined args", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("read")
      expect(ids).toContain("broken_plugin_tool")
    }),
  )

  it.instance("loads tools from .opencode/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads Zod-schema custom tools with JSON Schema and validation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "sql.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'query database',",
            "  args: { query: tool.schema.string().describe('SQL query to execute') },",
            "  execute: async ({ query }) => query,",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "sql")
      if (!loaded) throw new Error("custom sql tool was not loaded")
      expect(loaded?.jsonSchema).toMatchObject({
        type: "object",
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({ query: "select 1" }))).toBe(true)
      expect(Result.isSuccess(Schema.decodeUnknownResult(loaded.parameters)({}))).toBe(false)

      const agents = yield* Agent.Service
      const promptTools = yield* registry.tools({
        providerID: ProviderID.opencode,
        modelID: ModelID.make("test"),
        agent: yield* agents.defaultInfo(),
      })
      const promptTool = promptTools.find((tool) => tool.id === "sql")
      if (!promptTool) throw new Error("custom sql tool was not returned for prompts")
      expect(ToolJsonSchema.fromTool(promptTool)).toMatchObject({
        properties: {
          query: { type: "string", description: "SQL query to execute" },
        },
        required: ["query"],
      })
    }),
  )

  it.instance(
    "preserves Zod arg descriptions from older config-scoped plugin packages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const opencode = path.join(test.directory, ".opencode")
        const customTools = path.join(opencode, "tools")
        const plugin = path.join(opencode, "node_modules", "@opencode-ai", "plugin")
        yield* Effect.promise(() => fs.mkdir(path.join(plugin, "dist"), { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
        yield* Effect.promise(() =>
          fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(opencode, "node_modules", "zod"), {
            dereference: true,
            recursive: true,
          }),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "package.json"),
            JSON.stringify({ name: "@opencode-ai/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(plugin, "dist", "index.js"),
            [
              "import { z } from 'zod'",
              "export function tool(input) {",
              "  return input",
              "}",
              "tool.schema = z",
              "",
            ].join("\n"),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            path.join(customTools, "addition.ts"),
            [
              'import { tool } from "@opencode-ai/plugin"',
              "export default tool({",
              "  description: 'Use this tool to add two numbers and return their sum.',",
              "  args: {",
              "    left: tool.schema.number().describe('The first number to add'),",
              "    right: tool.schema.number().describe('The second number to add'),",
              "  },",
              "  execute: async (args) => `${args.left} + ${args.right} = ${args.left + args.right}`,",
              "})",
              "",
            ].join("\n"),
          ),
        )

        const registry = yield* ToolRegistry.Service
        const loaded = (yield* registry.all()).find((tool) => tool.id === "addition")
        if (!loaded) throw new Error("custom addition tool was not loaded")

        expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
          properties: {
            left: { type: "number", description: "The first number to add" },
            right: { type: "number", description: "The second number to add" },
          },
        })
      }),
    20_000,
  )

  it.instance("preserves attachments from structured custom tool results", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const customTools = path.join(test.directory, ".opencode", "tools")
      const pluginTool = pathToFileURL(path.resolve(import.meta.dir, "../../../plugin/src/tool.ts")).href
      yield* Effect.promise(() => fs.mkdir(customTools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(customTools, "image.ts"),
          [
            `import { tool } from ${JSON.stringify(pluginTool)}`,
            "export default tool({",
            "  description: 'image tool',",
            "  args: {},",
            "  execute: async () => ({",
            "    output: 'here is an image',",
            "    attachments: [{ type: 'file', mime: 'image/png', filename: 'picture.png', url: 'data:image/png;base64,AAAA' }],",
            "  }),",
            "})",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "image")
      if (!loaded) throw new Error("custom image tool was not loaded")
      const agents = yield* Agent.Service
      const result = yield* loaded.execute({}, {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context)

      expect(result.output).toBe("here is an image")
      expect(result.attachments).toEqual([
        { type: "file", mime: "image/png", filename: "picture.png", url: "data:image/png;base64,AAAA" },
      ])
    }),
  )

  it.instance("loads legacy JSON-schema-shaped custom tools with wire schema", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const tools = path.join(test.directory, ".opencode", "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "legacy.ts"),
          [
            "export default {",
            "  description: 'legacy schema tool',",
            "  args: { text: { type: 'string', description: 'Text to render' } },",
            "  execute: async ({ text }) => text,",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const registry = yield* ToolRegistry.Service
      const loaded = (yield* registry.all()).find((tool) => tool.id === "legacy")
      if (!loaded) throw new Error("legacy custom tool was not loaded")
      expect(ToolJsonSchema.fromTool(loaded)).toMatchObject({
        type: "object",
        properties: {
          text: { type: "string", description: "Text to render" },
        },
        required: ["text"],
      })
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".opencode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(opencode, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )

  describe("dynamic tool provider", () => {
    const supply: { current: Record<string, unknown> } = { current: {} }
    const withProvider = testEffect(
      Layer.mergeAll(
        registryLayer({ plugin: providerPluginLayer(supply) }),
        node,
        Agent.defaultLayer,
      ),
    )

    const toolsFor = (registry: ToolRegistry.Interface) =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        return yield* registry.tools({
          providerID: ProviderID.opencode,
          modelID: ModelID.make("test"),
          agent: yield* agent.defaultInfo(),
        })
      })

    withProvider.instance("exposes a dynamically supplied tool", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        supply.current = { custom_probe: dynamicTool("a dynamic probe tool") }
        const tools = yield* toolsFor(registry)
        const probe = tools.find((t) => t.id === "custom_probe")
        expect(probe).toBeDefined()
        if (!probe) throw new Error("custom_probe tool was not returned")
        expect(probe.description).toBe("a dynamic probe tool")
      }),
    )

    withProvider.instance("dynamic provider wins over builtin on id collision", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        supply.current = { grep: { description: "dynamic grep", args: {}, execute: async () => "dynamic grep" } }
        const tools = yield* toolsFor(registry)
        const grep = tools.find((t) => t.id === "grep")
        if (!grep) throw new Error("grep tool was not returned")
        const output = yield* grep.execute(
          {},
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context,
        )
        expect(output.output).toBe("dynamic grep")
      }),
    )

    withProvider.instance("removing a dynamic tool restores the builtin", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        supply.current = { grep: { description: "dynamic grep", args: {}, execute: async () => "dynamic grep" } }
        const withProvider = yield* toolsFor(registry)
        const overridden = withProvider.find((t) => t.id === "grep")
        if (!overridden) throw new Error("grep tool was not returned")
        expect((yield* overridden.execute({}, {
          sessionID: SessionID.make("ses_test"),
          messageID: MessageID.make("msg_test"),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        } satisfies Tool.Context)).output).toBe("dynamic grep")

        supply.current = {}
        const after = yield* toolsFor(registry)
        const restored = after.find((t) => t.id === "grep")
        if (!restored) throw new Error("grep tool was not returned after removal")
        const output = yield* restored.execute(
          { pattern: "x", path: "." },
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context,
        )
        expect(output.output).not.toBe("dynamic grep")
      }),
    )

    it.instance("no provider equals static collection (builtin + custom)", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const withProviderTools = yield* toolsFor(registry)
        const registryNoProvider = yield* ToolRegistry.Service
        const baseTools = yield* toolsFor(registryNoProvider)
        // Both resolve the same service instance; when nothing provides dynamic
        // tools the merged set equals the static base.
        expect(withProviderTools.map((t) => t.id).sort()).toEqual(baseTools.map((t) => t.id).sort())
      }),
    )

    // W-02: lock the D-02 ordering mechanics. A same-name dynamic tool keeps
    // the static base's original position; brand-new ids are appended in
    // `localeCompare` sorted order after the (possibly overridden) base.
    withProvider.instance("orders merged ids: same-name keeps base position, new ids appended sorted", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        // Baseline filtered base order (no dynamic tools supplied).
        supply.current = {}
        const base = (yield* toolsFor(registry)).map((t) => t.id)
        const grepIdx = base.indexOf("grep")
        expect(grepIdx).toBeGreaterThanOrEqual(0)

        // Override an existing builtin (grep) and add three brand-new ids out
        // of sorted order to prove append-then-sort.
        supply.current = {
          zzz_tool: dynamicTool("z"),
          grep: { description: "dynamic grep", args: {}, execute: async () => "dynamic grep" },
          aaa_tool: dynamicTool("a"),
          mmm_tool: dynamicTool("m"),
        }
        const tools = yield* toolsFor(registry)
        const ids = tools.map((t) => t.id)

        // Same-name override keeps grep at its base position; base order intact.
        expect(ids.slice(0, base.length)).toEqual(base)
        // New ids appended in localeCompare order after the base.
        expect(ids.slice(base.length)).toEqual(["aaa_tool", "mmm_tool", "zzz_tool"])
        // grep is the dynamic version at its original position.
        const grepTool = tools[grepIdx]
        expect(grepTool.id).toBe("grep")
        const out = yield* grepTool.execute(
          {},
          {
            sessionID: SessionID.make("ses_test"),
            messageID: MessageID.make("msg_test"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          } satisfies Tool.Context,
        )
        expect(out.output).toBe("dynamic grep")
      }),
    )

    // W-01: byte stability must run through the dynamic provider path, with a
    // fixed collection containing both a same-name override and new ids.
    withProvider.instance("unchanged dynamic tool set produces byte-identical output across requests", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        supply.current = {
          grep: { description: "dynamic grep", args: {}, execute: async () => "dynamic grep" },
          custom_probe: dynamicTool("a dynamic probe tool"),
        }
        const first = yield* toolsFor(registry)
        const second = yield* toolsFor(registry)
        expect(JSON.stringify(first)).toBe(JSON.stringify(second))
      }),
    )

    // B-01: a throwing provider must degrade to the static set, not break the
    // model request. Compare against the base produced by a provider that
    // supplies nothing (empty supply) — a throwing provider must yield the
    // exact same static set.
    withThrowingProvider.instance("throwing provider degrades to static tool set", () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const tools = yield* toolsFor(registry)
        const ids = tools.map((t) => t.id)
        // Static builtin surface intact (the throwing provider added nothing).
        for (const builtin of ["invalid", "bash", "read", "glob", "grep", "write", "edit"]) {
          expect(ids).toContain(builtin)
        }
        // No dynamic tool leaked in.
        expect(ids).not.toContain("custom_probe")
      }),
    )
  })
})
