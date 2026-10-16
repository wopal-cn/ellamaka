import { afterEach, describe, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { tool, type ToolContext, type ToolDefinition } from "@wopal/ellamaka-plugin"
import { dshAdapter, DshAdapterError, trackDshToolsInitialization } from "../src/dsh-adapter/index"

const globals = globalThis as Record<string, unknown>
const previous = globals.__ellamakaDshContainer
const enabled = process.env.ELLAMAKA_DSH
afterEach(() => {
  globals.__ellamakaDshContainer = previous
  if (enabled === undefined) delete process.env.ELLAMAKA_DSH
  else process.env.ELLAMAKA_DSH = enabled
})

function input(config: Record<string, unknown> = { sandbox: { enabled: true } }): Parameters<typeof dshAdapter>[0] {
  return { directory: "/project", worktree: "/project", pluginConfig: { "dsh-adapter": config } }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "test",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
    ...overrides,
  }
}

function container() {
  const handlers = new Set<(request: unknown, next: () => unknown) => unknown>()
  const schemas = ["read", "write", "edit", "grep", "glob", "str_replace_editor", "bash"].map((name) => ({
    name,
    description: name,
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File to operate on" },
        insert_line: { oneOf: [{ type: "integer" }, { type: "null" }] },
        command: { enum: ["view", "insert"] },
        fixed: { const: "fixed" },
      },
      required: ["file_path"],
    },
  }))
  const calls: any[] = []
  let run = async (_call: any): Promise<any> => ({ isError: false, content: [{ type: "text", text: "done" }] })
  const tools = {
    schemas: () => schemas,
    execute: async (call: any) => {
      calls.push(call)
      return run(call)
    },
  }
  const ctx = {
    get: () => tools,
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (_event: string, handler: (request: unknown, next: () => unknown) => unknown) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  globals.__ellamakaDshContainer = ctx
  return {
    ctx,
    tools,
    schemas,
    calls,
    handlers,
    run: (fn: typeof run) => {
      run = fn
    },
    approve: async (session: unknown, reason = "escalate sandbox to workspace-write: test") => {
      const chain = [...handlers]
      const next = (index: number): unknown =>
        chain[index]?.({ agent: { session }, reason }, () => next(index + 1)) ?? "unavailable"
      return await next(0)
    },
  }
}

async function projected(hook: Awaited<ReturnType<typeof dshAdapter>>) {
  const output: { tools: Record<string, ToolDefinition> } = { tools: {} }
  await hook["tool.provider"]?.({ providerID: "test", modelID: "test" }, output)
  return output.tools
}

describe("built-in dsh adapter", () => {
  test("live projection and dispatch use a replaced registry service on the same host", async () => {
    const first = container()
    const hook = await dshAdapter(input())
    const replacement = container()
    globals.__ellamakaDshContainer = first.ctx
    first.ctx.get = () => replacement.tools
    replacement.schemas[0].description = "replacement read"
    const tools = await projected(hook)
    expect(tools.read.description).toBe("replacement read")
    await tools.read.execute({ filePath: "a" }, context())
    expect(replacement.calls).toHaveLength(1)
    expect(first.calls).toHaveLength(0)
    await hook.dispose?.()
  })
  test("required instances wait for the host's shared initialization before binding tools", async () => {
    delete globals.__ellamakaDshContainer
    process.env.ELLAMAKA_DSH = "1"
    const ready = Promise.withResolvers<void>()
    void trackDshToolsInitialization(ready.promise)
    const pending = dshAdapter(input())
    container()
    ready.resolve()
    const hook = await pending
    expect(Object.keys(await projected(hook))).toHaveLength(7)
    await hook.dispose?.()
  })
  test("disabled adoption and the hard kill switch never inspect the container", async () => {
    globals.__ellamakaDshContainer = {
      get() {
        throw new Error("must not inspect")
      },
    }
    expect(await dshAdapter(input({ sandbox: { enabled: false } }))).toEqual({})
    process.env.ELLAMAKA_DSH = "0"
    expect(await dshAdapter(input())).toEqual({})
  })

  test("missing container and tools fail explicitly instead of producing an empty provider", async () => {
    process.env.ELLAMAKA_DSH = "1"
    delete globals.__ellamakaDshContainer
    await expect(dshAdapter(input())).rejects.toBeInstanceOf(DshAdapterError)
    globals.__ellamakaDshContainer = { get: () => undefined }
    await expect(dshAdapter(input())).rejects.toBeInstanceOf(DshAdapterError)
  })

  test("validates effective config and preserves inline fallback precedence", async () => {
    container()
    await expect(dshAdapter(input({ sandbox: { enabled: "yes" } }))).rejects.toThrow("validation")
    expect(await dshAdapter(input({ sandbox: { enabled: false } }), { sandbox: { enabled: true } })).toEqual({})
    const inline = await dshAdapter({ ...input(), pluginConfig: {} }, { sandbox: { enabled: true } })
    expect(Object.keys(await projected(inline))).toHaveLength(7)
    await inline.dispose?.()
  })

  test("projects live schemas through the SDK's schema instance without losing constraints", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const tools = await projected(hook)
    expect(Object.keys(tools)).toEqual(Object.keys(tools).sort())
    const schema = tool.schema.object(tools.read.args)
    expect(schema.safeParse({ filePath: "a", insert_line: null, command: "view", fixed: "fixed" }).success).toBe(true)
    expect(schema.safeParse({ filePath: "a", insert_line: "1" }).success).toBe(false)
    expect(schema.safeParse({ filePath: "a", command: "bad" }).success).toBe(false)
    expect(schema.safeParse({ filePath: "a", fixed: "bad" }).success).toBe(false)
    expect(tool.schema.toJSONSchema(schema).properties?.filePath?.description).toBe("File to operate on")
    pool.schemas[0].description = "changed"
    expect((await projected(hook)).read.description).toBe("changed")
    pool.schemas.splice(0, 1)
    await expect(projected(hook)).rejects.toBeInstanceOf(DshAdapterError)
    await hook.dispose?.()
  })

  test("maps parameters, permissions, full-file value and output independently", async () => {
    const pool = container()
    pool.run(async () => ({
      isError: false,
      content: [{ type: "text", text: "summary" }],
      value: { path: "/project/a", before: "old\n", after: "new\n" },
      meta: { diffs: [{ path: "/project/a", oldText: "wrong", newText: "wrong" }] },
    }))
    const hook = await dshAdapter(input())
    const asks: string[] = []
    const result = await (
      await projected(hook)
    ).edit.execute(
      { filePath: "a", oldString: "old", newString: "new" },
      context({
        ask: async (request) => {
          asks.push(request.permission)
        },
      }),
    )
    expect(asks).toEqual(["edit"])
    expect(pool.calls[0].arguments).toEqual({ file_path: "a", old_string: "old", new_string: "new" })
    expect(result).toMatchObject({
      output: "summary",
      metadata: { filediff: { before: "old\n", after: "new\n", additions: 1, deletions: 1 } },
    })
    expect(typeof result !== "string" && result.metadata?.diff).toContain("-old\n+new")
    await hook.dispose?.()
  })

  test("instance facades and asks stay isolated even with identical session ids", async () => {
    const pool = container()
    const a = await dshAdapter(input({ sandbox: { enabled: true, mode: "read-only" } }))
    const b = await dshAdapter(input({ sandbox: { enabled: true, mode: "workspace-write" } }))
    const seen: string[] = []
    pool.run(async (call) => {
      expect(await pool.approve(call.agent.session)).toBe("allowed-once")
      return { isError: false, content: [] }
    })
    await (
      await projected(a)
    ).read.execute(
      { filePath: "a" },
      context({
        ask: async (req) => {
          if (req.permission === "sandbox_escalation") seen.push("a")
        },
      }),
    )
    await (
      await projected(b)
    ).read.execute(
      { filePath: "b" },
      context({
        ask: async (req) => {
          if (req.permission === "sandbox_escalation") seen.push("b")
        },
      }),
    )
    expect(seen).toEqual(["a", "b"])
    expect(pool.calls[0].agent.session).not.toBe(pool.calls[1].agent.session)
    expect(await pool.approve(pool.calls[0].agent.session)).toBe("unavailable")
    await a.dispose?.()
    expect(pool.handlers.size).toBe(1)
    await b.dispose?.()
    expect(pool.handlers.size).toBe(0)
  })

  test("sandbox LAST-wins restores default explicitly and closes turns on failure", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const read = (await projected(hook)).read
    await read.execute({ filePath: "a" }, context({ extra: { sandboxMode: "read-only" } }))
    await read.execute({ filePath: "a" }, context({ extra: { sandboxMode: "workspace-write" } }))
    const session = pool.calls[0].agent.session
    expect(
      session
        .snapshotEvents()
        .filter((event: any) => event.type === "sandbox/mode")
        .map((event: any) => event.data.mode),
    ).toEqual(["workspace-write", "read-only", "workspace-write"])
    pool.run(async () => {
      throw new Error("cancelled")
    })
    await expect(read.execute({ filePath: "a" }, context())).rejects.toThrow("cancelled")
    expect(session.eventAt(session.seq - 1).type).toBe("turn/end")
    expect(session.turnDepth).toBe(0)
    await hook.dispose?.()
  })

  test("concurrent calls on one session retain their own approval closures and abort signals", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const read = (await projected(hook)).read
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const seen: string[] = []
    pool.run(async (call) => {
      if (call.arguments.file_path === "a") {
        entered.resolve()
        await release.promise
      }
      expect(await pool.approve(call.agent.session)).toBe("allowed-once")
      return { isError: false, content: [] }
    })
    const a = read.execute(
      { filePath: "a" },
      context({
        ask: async (req) => {
          if (req.permission === "sandbox_escalation") seen.push("a")
        },
      }),
    )
    await entered.promise
    await read.execute(
      { filePath: "b" },
      context({
        ask: async (req) => {
          if (req.permission === "sandbox_escalation") seen.push("b")
        },
      }),
    )
    release.resolve()
    await a
    expect(seen).toEqual(["b", "a"])
    expect(pool.calls[0].agent.session).toBe(pool.calls[1].agent.session)
    const events = pool.calls[0].agent.session.snapshotEvents()
    expect(events.filter((event: any) => event.type === "turn/start")).toHaveLength(1)
    expect(events.filter((event: any) => event.type === "turn/end")).toHaveLength(1)
    const abort = new AbortController()
    abort.abort(new Error("cancelled"))
    await expect(read.execute({ filePath: "a" }, context({ abort: abort.signal }))).rejects.toThrow("cancelled")
    expect(pool.calls).toHaveLength(2)
    await hook.dispose?.()
  })

  test("completed calls cannot answer delayed approval events from their old async scope", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    let later: (() => Promise<unknown>) | undefined
    pool.run(async (call) => {
      const scope = AsyncLocalStorage.snapshot()
      later = () => scope(() => pool.approve(call.agent.session))
      return { isError: false, content: [] }
    })
    await (await projected(hook)).read.execute({ filePath: "a" }, context())
    expect(await later?.()).toBe("unavailable")
    await hook.dispose?.()
  })

  test("search tools retain native permission checks before DSH execution", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const tools = await projected(hook)
    for (const name of ["grep", "glob"]) {
      const asks: string[] = []
      await expect(
        tools[name].execute(
          { pattern: "secret", path: "/outside" },
          context({
            ask: async (req) => {
              asks.push(req.permission)
              throw new Error("denied")
            },
          }),
        ),
      ).rejects.toThrow("denied")
      expect(asks).toEqual([name])
    }
    expect(pool.calls).toHaveLength(0)
    await hook.dispose?.()
  })

  test("Windows shell dispatch keeps logical bash permission and rejection/cancellation semantics", async () => {
    const pool = container()
    pool.schemas.find((entry) => entry.name === "bash")!.name = "pwsh"
    const hook = await dshAdapter(input())
    const bash = (await projected(hook)).bash
    const permissions: string[] = []
    pool.run(async (call) => {
      expect(await pool.approve(call.agent.session)).toBe("rejected")
      return { isError: false, content: [] }
    })
    await bash.execute(
      { command: "view" },
      context({
        ask: async (req) => {
          permissions.push(req.permission)
          if (req.permission === "sandbox_escalation") {
            const error = new Error("denied")
            error.name = "PermissionRejectedError"
            throw error
          }
        },
      }),
    )
    expect(permissions).toEqual(["bash", "sandbox_escalation"])
    expect(pool.calls[0].name).toBe("pwsh")
    pool.run(async (call) => {
      await pool.approve(call.agent.session)
      return { isError: false }
    })
    await expect(
      bash.execute(
        { command: "view" },
        context({
          ask: async (req) => {
            if (req.permission === "sandbox_escalation") throw new Error("cancelled")
          },
        }),
      ),
    ).rejects.toThrow("cancelled")
    await hook.dispose?.()
  })
})
