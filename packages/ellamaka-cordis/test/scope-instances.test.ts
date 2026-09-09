/**
 * Experiment 1: container scope instantiation (research §17.4, guesses S7–S10).
 *
 * Verifies the dsh three-layer plugin instantiation model works for the
 * "per-directory scope" mapping ellamaka needs:
 *
 *  - S7: a scope mounts a plugin whose tool is visible only to that scope
 *  - S8: scope.dispose() cleanly removes the scope layer
 *  - S9: the same plugin code under two scopes yields isolated instances
 *  - S10 (shadow): a scope registration shadows the global name
 *
 * rc.1 mechanism (official scoped.spec.ts pattern): a scope key is an opaque
 * object that DOUBLES as the routing key on execution (`exec.agent`), and
 * `createScope` must run inside a plugin whose `inject` covers the services
 * scope holders will reach — the scoped context resolves services through the
 * minting plugin's dependency chain.
 *
 * dsh packages are resolved through the `@deepseek-ai/dsh` install anchor —
 * the same pattern serve.ts uses for installAnchor — because the packages
 * live in the dsh closure, not in this package's own dependencies.
 */
import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { Context } from "@deepseek-ai/cordis"

const req = createRequire(import.meta.url)
const dshAnchorDir = req.resolve("@deepseek-ai/dsh/package.json").replace("/package.json", "")
const dshReq = createRequire(`${dshAnchorDir}/package.json`)

// dsh-scope carries its kScope tag symbol per module instance, and the bun
// store materializes multiple copies of the peer-only package. The registry
// under test reads the tag with the copy IT resolves, so the test must mint
// scopes with the SAME copy: resolve dsh-scope from dsh-tools's own closure,
// not from the anchor root (whose copy differs).
const toolsModulePath = dshReq.resolve("@deepseek-ai/dsh-tools")
const toolsReq = createRequire(toolsModulePath)
const scopeModule = await import(toolsReq.resolve("@deepseek-ai/dsh-scope"))
const createScope = scopeModule.createScope as (ctx: Context, key: ScopeKey) => {
  ctx: Context
  dispose(): Promise<void>
}
type Scope = ReturnType<typeof createScope>
type ScopeKey = object
const { default: SystemPrompt } = await import(dshReq.resolve("@deepseek-ai/dsh-system-prompt"))
const { default: ToolRuntime, defineTool } = await import(toolsModulePath)

type ToolSchema = { name: string }

/** A fresh container with systemPrompt + tools services mounted at root. */
async function bootContainer() {
  const ctx = new Context()
  await Promise.resolve(ctx.plugin(SystemPrompt as never))
  await Promise.resolve(ctx.plugin(ToolRuntime as never, {}))
  return ctx
}

/**
 * Mint a scope the official way: createScope runs inside a minter plugin that
 * injects the services scope holders reach. The key doubles as the Agent on
 * execution routing.
 */
async function mintScope(ctx: Context, key: ScopeKey): Promise<{ scope: Scope; key: ScopeKey }> {
  let scope!: Scope
  await Promise.resolve(
    ctx.plugin(
      Object.assign((inner: Context) => {
        scope = createScope(inner, key)
      }, { inject: ["tools", "systemPrompt"] }) as never,
    ),
  )
  return { scope, key }
}

/**
 * Register one counter tool on a context (root or scope) — the rc.1 official
 * registration form: `ctx.tools.register(definition)` on the context whose
 * layer should own the tool (official scoped.spec.ts pattern; a plugin's
 * apply context does NOT carry the scope tag, so plugin-mounted registrations
 * land on the global layer). Every invocation creates an ISOLATED counter
 * instance, so registering the same factory under two scopes yields two
 * independent instances.
 */
function mountCounterTool(ctx: Context, toolName: string) {
  const calls: string[] = []
  const tools = (ctx as Context & { tools: { register(def: unknown): () => void } }).tools
  const tool = defineTool({
    name: toolName,
    description: `scoped counter tool ${toolName}`,
    parameters: {},
    output: {
      schema: { type: "string" as const },
      render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: String(value) }],
    },
    execute: async () => {
      calls.push(`call-${calls.length}`)
      return `${toolName} calls=${calls.length}`
    },
  })
  const dispose = tools.register(tool as never)
  return { calls, mounted: Promise.resolve(), dispose }
}

function execFor(name: string, agent?: object, signal?: AbortSignal) {
  return {
    callId: `call-${name}`,
    rootCallId: `call-${name}`,
    name,
    arguments: {},
    signal: signal ?? new AbortController().signal,
    ...(agent ? { agent } : {}),
  }
}

/** dsh ToolRuntime.execute takes ONE exec object (name/arguments inside). */
function run(ctx: Context, name: string, agent?: object) {
  return (ctx.tools as { execute(exec: unknown): Promise<{ isError: boolean }> }).execute(execFor(name, agent))
}

const names = (schemas: ToolSchema[]) => schemas.map((s) => s.name).sort()

describe("experiment 1: per-directory scope instantiation", () => {
  test("S7: a scope mounts a plugin whose tool is visible only to that scope", async () => {
    const ctx = await bootContainer()
    mountCounterTool(ctx, "global_probe")

    const dirA: ScopeKey = { directory: "/workspace/a" }
    const { scope: scopeA, key: keyA } = await mintScope(ctx, dirA)
    mountCounterTool(scopeA.ctx, "dir_a_tool")

    // global view: only the global tool
    expect(names(ctx.tools.schemas() as ToolSchema[])).toEqual(["global_probe"])
    // scope A view: global + own
    expect(names(ctx.tools.schemas(keyA) as ToolSchema[])).toEqual(["dir_a_tool", "global_probe"])
    // an unrelated sibling scope sees nothing of A
    const dirB: ScopeKey = { directory: "/workspace/b" }
    expect(names(ctx.tools.schemas(dirB) as ToolSchema[])).toEqual(["global_probe"])
  })

  test("S9: same plugin code under two scopes yields isolated instances", async () => {
    const ctx = await bootContainer()
    const dirA: ScopeKey = { directory: "/workspace/a" }
    const dirB: ScopeKey = { directory: "/workspace/b" }
    const { scope: scopeA, key: keyA } = await mintScope(ctx, dirA)
    const { scope: scopeB, key: keyB } = await mintScope(ctx, dirB)

    const instA = mountCounterTool(scopeA.ctx, "shared_name")
    const instB = mountCounterTool(scopeB.ctx, "shared_name")

    // execute twice under scope A's key (the key doubles as the agent)
    await run(ctx, "shared_name", keyA)
    await run(ctx, "shared_name", keyA)
    // once under scope B's key
    await run(ctx, "shared_name", keyB)

    expect(instA.calls.length).toBe(2)
    expect(instB.calls.length).toBe(1)
  })

  test("S10: scope registration shadows the global name for that scope only", async () => {
    const ctx = await bootContainer()
    const globalTool = mountCounterTool(ctx, "shadowed")

    const dirA: ScopeKey = { directory: "/workspace/a" }
    const { scope: scopeA, key: keyA } = await mintScope(ctx, dirA)
    const overrideA = mountCounterTool(scopeA.ctx, "shadowed")

    await run(ctx, "shadowed", keyA)
    await run(ctx, "shadowed")

    expect(overrideA.calls.length).toBe(1)
    expect(globalTool.calls.length).toBe(1)
  })

  test("S8: scope.dispose() removes the scope layer and its tools", async () => {
    const ctx = await bootContainer()
    const dirA: ScopeKey = { directory: "/workspace/a" }
    const { scope: scopeA, key: keyA } = await mintScope(ctx, dirA)
    const toolA = mountCounterTool(scopeA.ctx, "dir_a_tool")
    expect(names(ctx.tools.schemas(keyA) as ToolSchema[])).toContain("dir_a_tool")

    await scopeA.dispose()

    expect(names(ctx.tools.schemas(keyA) as ToolSchema[])).not.toContain("dir_a_tool")
    // the tool is no longer executable under that key
    const result = await run(ctx, "dir_a_tool", keyA)
    expect(result.isError).toBe(true)
  })

  test("execution routes by the exec key: a tool invisible to one scope reads as UNKNOWN_TOOL", async () => {
    const ctx = await bootContainer()
    const dirA: ScopeKey = { directory: "/workspace/a" }
    const dirB: ScopeKey = { directory: "/workspace/b" }
    const { scope: scopeA, key: keyA } = await mintScope(ctx, dirA)
    const toolA = mountCounterTool(scopeA.ctx, "dir_a_only")

    const underA = await run(ctx, "dir_a_only", keyA)
    expect(underA.isError).toBe(false)

    const underB = await run(ctx, "dir_a_only", dirB)
    expect(underB.isError).toBe(true)
  })
})
