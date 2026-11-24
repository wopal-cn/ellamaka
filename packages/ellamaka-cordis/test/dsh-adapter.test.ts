import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { tool, type ToolContext, type ToolDefinition } from "@wopal/ellamaka-plugin"
import {
  dshAdapter,
  DshAdapterError,
  SessionExclusiveQueues,
  trackDshToolsInitialization,
} from "../src/dsh-adapter/index"
import { scopedEnv } from "./fixture/process-env"

const globals = globalThis as Record<string, unknown>
const previous = globals.__ellamakaDshContainer
let environment: Disposable

beforeEach(() => {
  environment = scopedEnv({ ELLAMAKA_DSH_TOOLS: undefined })
})

afterEach(() => {
  globals.__ellamakaDshContainer = previous
  environment[Symbol.dispose]()
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
  const batches: any[] = []
  let run = async (_call: any): Promise<any> => ({ isError: false, content: [{ type: "text", text: "done" }] })
  const tools = {
    schemas: () => schemas,
    execute: async (call: any) => {
      batches.push(call)
      const item = call.calls?.[0]
      const legacyCall = item
        ? {
            callId: item.id,
            name: item.name,
            arguments: JSON.parse(item.arguments),
            signal: call.signal,
            agent: call.agent,
          }
        : call
      calls.push(legacyCall)
      const result = await run(legacyCall)
      return item ? { results: [{ callId: item.id, result }], additionalContexts: [], concluded: false } : result
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
    batches,
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
  test("uses the RC.3 native batch API for a single ordinary tool call", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const result = await (await projected(hook)).read.execute({ filePath: "a" }, context())
    expect(result).toMatchObject({ output: "done", title: "read" })
    expect(pool.batches).toHaveLength(1)
    expect(pool.batches[0]).toMatchObject({
      calls: [{ type: "tool-call", name: "read", arguments: JSON.stringify({ file_path: "a" }) }],
    })
    expect(pool.batches[0].calls[0].id).toBe(pool.calls[0].callId)
    expect(pool.batches[0].signal).toBeInstanceOf(AbortSignal)
    expect(pool.batches[0].agent.session).toBeDefined()
    await hook.dispose?.()
  })

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
    using _disabled = scopedEnv({ ELLAMAKA_DSH_TOOLS: "0" })
    expect(await dshAdapter(input())).toEqual({})
  })

  test("missing container falls back to native tools instead of failing the session", async () => {
    delete globals.__ellamakaDshContainer
    const missing = await dshAdapter(input())
    expect(await projected(missing)).toEqual({})

    globals.__ellamakaDshContainer = { get: () => undefined }
    const incomplete = await dshAdapter(input())
    expect(await projected(incomplete)).toEqual({})
  })

  test("a ready DSH tool failure never retries the native tool and logs structured error details for classification", async () => {
    const pool = container()
    const logged: Array<{ message: string; extra: unknown }> = []
    pool.ctx.logger = () => ({
      info() {},
      warn() {},
      error(message: string, extra?: unknown) {
        logged.push({ message, extra })
      },
    })
    pool.run(async () => ({
      isError: true,
      content: [
        { type: "text", text: 'Error: cannot modify "/project/a": file has not been read — read the file, then retry' },
      ],
      error: {
        message: 'cannot modify "/project/a": file has not been read — read the file, then retry',
        info: { name: "FsError", code: "FS_NOT_OBSERVED" },
      },
    }))
    const hook = await dshAdapter(input())
    let nativeCalls = 0
    const output: { tools: Record<string, ToolDefinition> } = {
      tools: {
        edit: {
          description: "native edit",
          args: {},
          execute: async () => {
            nativeCalls += 1
            return { output: "native", title: "edit", metadata: {} }
          },
        },
      },
    }
    await hook["tool.provider"]?.({ providerID: "test", modelID: "test" }, output)
    await expect(
      output.tools.edit.execute({ filePath: "a", oldString: "x", newString: "y" }, context()),
    ).rejects.toThrow("file has not been read")
    expect(nativeCalls).toBe(0)
    expect(pool.calls).toHaveLength(1)
    expect(logged).toEqual([
      {
        message: "tool execution failed",
        extra: {
          tool: "edit",
          code: "FS_NOT_OBSERVED",
          error: 'cannot modify "/project/a": file has not been read — read the file, then retry',
        },
      },
    ])
    await hook.dispose?.()
  })

  test("adopts a container that appears after preparation", async () => {
    delete globals.__ellamakaDshContainer
    const hook = await dshAdapter(input())
    expect(await projected(hook)).toEqual({})
    const pool = container()
    const tools = await projected(hook)
    expect(Object.keys(tools)).toHaveLength(7)
    await tools.read.execute({ filePath: "a" }, context())
    expect(pool.calls).toHaveLength(1)
    await hook.dispose?.()
  })

  test("invalid config falls back to native tools and inline precedence is preserved", async () => {
    container()
    expect(await dshAdapter(input({ sandbox: { enabled: "yes" } }))).toEqual({})
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

  test("serializes mutating and shell calls on the same session while leaving view/search calls concurrent", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const tools = await projected(hook)

    const firstEntered = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const events: string[] = []
    let activeMutating = 0
    let maxConcurrentMutating = 0

    pool.run(async (call) => {
      activeMutating += 1
      maxConcurrentMutating = Math.max(maxConcurrentMutating, activeMutating)
      const label = call.arguments.file_path
      events.push(`enter:${label}`)
      try {
        if (label === "first") {
          firstEntered.resolve()
          await releaseFirst.promise
        }
        return { isError: false, content: [{ type: "text", text: "ok" }] }
      } finally {
        events.push(`exit:${label}`)
        activeMutating -= 1
      }
    })

    // Parallel edits on the same session must run strictly sequentially.
    const edit1 = tools.edit.execute({ filePath: "first", oldString: "a", newString: "b" }, context())
    await firstEntered.promise
    const edit2 = tools.edit.execute({ filePath: "second", oldString: "a", newString: "b" }, context())
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(["enter:first"])
    releaseFirst.resolve()
    await Promise.all([edit1, edit2])
    expect(events).toEqual(["enter:first", "exit:first", "enter:second", "exit:second"])
    expect(maxConcurrentMutating).toBe(1)

    // A failure in the first queued mutation does not stall the second queued call.
    const eFirst = Promise.withResolvers<void>()
    const rFirst = Promise.withResolvers<void>()
    events.length = 0
    pool.run(async (call) => {
      events.push(`seq:${call.arguments.file_path}`)
      if (call.arguments.file_path === "fail-first") {
        eFirst.resolve()
        await rFirst.promise
        return { isError: true, content: [{ type: "text", text: "boom" }], error: { message: "boom" } }
      }
      return { isError: false, content: [{ type: "text", text: "recovered" }] }
    })
    const failing = tools.edit.execute({ filePath: "fail-first", oldString: "a", newString: "b" }, context())
    await eFirst.promise
    const recovered = tools.edit.execute({ filePath: "after-fail", oldString: "a", newString: "b" }, context())
    rFirst.resolve()
    await expect(failing).rejects.toThrow("boom")
    await expect(recovered).resolves.toMatchObject({ output: "recovered" })
    expect(events).toEqual(["seq:fail-first", "seq:after-fail"])

    // Non-view str_replace_editor calls serialize on the same session; view stays concurrent.
    const sreEntered = Promise.withResolvers<void>()
    const sreRelease = Promise.withResolvers<void>()
    let sreSecondStarted = false
    pool.run(async (call) => {
      if (call.arguments.path === "s1") {
        sreEntered.resolve()
        await sreRelease.promise
      } else {
        sreSecondStarted = true
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] }
    })
    const sre1 = tools.str_replace_editor.execute({ command: "str_replace", path: "s1" }, context())
    await sreEntered.promise
    const sre2 = tools.str_replace_editor.execute({ command: "str_replace", path: "s2" }, context())
    await Promise.resolve()
    await Promise.resolve()
    expect(sreSecondStarted).toBe(false)
    sreRelease.resolve()
    await Promise.all([sre1, sre2])
    expect(sreSecondStarted).toBe(true)

    const viewEntered = Promise.withResolvers<void>()
    const viewRelease = Promise.withResolvers<void>()
    let concurrentViewRan = false
    pool.run(async (call) => {
      if (call.arguments.path === "v1") {
        viewEntered.resolve()
        await viewRelease.promise
      } else {
        concurrentViewRan = true
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] }
    })
    const view1 = tools.str_replace_editor.execute({ command: "view", path: "v1" }, context())
    await viewEntered.promise
    await tools.str_replace_editor.execute({ command: "view", path: "v2" }, context())
    expect(concurrentViewRan).toBe(true)
    viewRelease.resolve()
    await view1

    // Different sessions do not block each other's edits.
    const diffSessEntered = Promise.withResolvers<void>()
    const diffSessRelease = Promise.withResolvers<void>()
    let diffSessConcurrent = false
    pool.run(async (call) => {
      if (call.arguments.file_path === "sa") {
        diffSessEntered.resolve()
        await diffSessRelease.promise
      } else {
        diffSessConcurrent = true
      }
      return { isError: false, content: [{ type: "text", text: "ok" }] }
    })
    const editSessA = tools.edit.execute(
      { filePath: "sa", oldString: "a", newString: "b" },
      context({ sessionID: "s-a" }),
    )
    await diffSessEntered.promise
    await tools.edit.execute({ filePath: "sb", oldString: "a", newString: "b" }, context({ sessionID: "s-b" }))
    expect(diffSessConcurrent).toBe(true)
    diffSessRelease.resolve()
    await editSessA

    await hook.dispose?.()
  })

  test("cancels a queued mutating call on abort without letting later calls bypass the active holder", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const tools = await projected(hook)

    const entered1 = Promise.withResolvers<void>()
    const release1 = Promise.withResolvers<void>()
    const order: string[] = []
    let thirdEnteredBeforeFirstDone = false
    let firstDone = false

    pool.run(async (call) => {
      order.push(`enter:${call.arguments.file_path}`)
      if (call.arguments.file_path === "first") {
        entered1.resolve()
        await release1.promise
        firstDone = true
      } else if (call.arguments.file_path === "third" && !firstDone) {
        thirdEnteredBeforeFirstDone = true
      }
      order.push(`exit:${call.arguments.file_path}`)
      return { isError: false, content: [{ type: "text", text: call.arguments.file_path }] }
    })

    const abort2 = new AbortController()
    const call1 = tools.edit.execute({ filePath: "first", oldString: "a", newString: "b" }, context())
    await entered1.promise
    const call2 = tools.edit.execute(
      { filePath: "second", oldString: "a", newString: "b" },
      context({ abort: abort2.signal }),
    )
    const call3 = tools.edit.execute({ filePath: "third", oldString: "a", newString: "b" }, context())

    abort2.abort(new Error("user cancelled queued edit"))
    await expect(call2).rejects.toThrow("user cancelled queued edit")

    // Releasing the event loop while call1 is still active must NOT allow call3 to enter.
    await Promise.resolve()
    await Promise.resolve()
    expect(thirdEnteredBeforeFirstDone).toBe(false)

    release1.resolve()
    await Promise.all([call1, call3])
    expect(thirdEnteredBeforeFirstDone).toBe(false)
    expect(order).toEqual(["enter:first", "exit:first", "enter:third", "exit:third"])

    await hook.dispose?.()
  })

  test("preserves original dispatch order across queued mutating calls even when a later permission resolves first", async () => {
    const pool = container()
    const hook = await dshAdapter(input())
    const tools = await projected(hook)

    const bashAskStarted = Promise.withResolvers<void>()
    const bashAskRelease = Promise.withResolvers<void>()
    const events: string[] = []

    pool.run(async (call) => {
      events.push(`exec:${call.name}`)
      return { isError: false, content: [{ type: "text", text: call.name }] }
    })

    const bashCall = tools.bash.execute(
      { command: "echo hi > target.txt" },
      context({
        ask: async (req) => {
          events.push(`ask:${req.permission}`)
          bashAskStarted.resolve()
          await bashAskRelease.promise
        },
      }),
    )
    await bashAskStarted.promise

    const editCall = tools.edit.execute(
      { filePath: "target.txt", oldString: "a", newString: "b" },
      context({
        ask: async (req) => {
          events.push(`ask:${req.permission}`)
        },
      }),
    )

    // Allow microtasks to flush; edit's immediate permission must wait behind bash in the session queue.
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(["ask:bash"])

    bashAskRelease.resolve()
    await Promise.all([bashCall, editCall])
    expect(events).toEqual(["ask:bash", "exec:bash", "ask:edit", "exec:edit"])

    // A rejected permission on the earlier queued call must not block later calls on the same session.
    events.length = 0
    const rejectBashGate = Promise.withResolvers<void>()
    const rejectStarted = Promise.withResolvers<void>()
    const rejectedBash = tools.bash.execute(
      { command: "rm -rf /" },
      context({
        ask: async () => {
          events.push("ask:denied-bash")
          rejectStarted.resolve()
          await rejectBashGate.promise
          throw new Error("permission denied")
        },
      }),
    )
    await rejectStarted.promise
    const recoveredEdit = tools.edit.execute(
      { filePath: "target.txt", oldString: "b", newString: "c" },
      context({
        ask: async () => {
          events.push("ask:recovered-edit")
        },
      }),
    )
    rejectBashGate.resolve()
    await expect(rejectedBash).rejects.toThrow("permission denied")
    await expect(recoveredEdit).resolves.toMatchObject({ output: "edit" })
    expect(events).toEqual(["ask:denied-bash", "ask:recovered-edit", "exec:edit"])

    await hook.dispose?.()
  })

  test("prunes idle SessionExclusiveQueues entries and prevents stale cleanup after clear", async () => {
    const queues = new SessionExclusiveQueues()
    const abort = new AbortController()
    const gate1 = Promise.withResolvers<void>()
    const entered1 = Promise.withResolvers<void>()

    expect(queues.size).toBe(0)
    const task1 = queues.run("s-1", abort.signal, async () => {
      entered1.resolve()
      await gate1.promise
      return "done-1"
    })
    await entered1.promise
    expect(queues.size).toBe(1)

    gate1.resolve()
    expect(await task1).toBe("done-1")
    expect(queues.size).toBe(0)

    // Failures and aborts also prune idle queues.
    await expect(
      queues.run("s-err", abort.signal, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(queues.size).toBe(0)

    const cancelled = new AbortController()
    cancelled.abort(new Error("aborted"))
    await expect(queues.run("s-abort", cancelled.signal, async () => "never")).rejects.toThrow("aborted")
    expect(queues.size).toBe(0)

    // Old task cleanup after clear() must not delete a newly registered queue for the same sessionID.
    const oldEntered = Promise.withResolvers<void>()
    const oldRelease = Promise.withResolvers<void>()
    const oldTask = queues.run("s-reuse", abort.signal, async () => {
      oldEntered.resolve()
      await oldRelease.promise
      return "old"
    })
    await oldEntered.promise
    expect(queues.size).toBe(1)

    queues.clear()
    expect(queues.size).toBe(0)

    const newEntered = Promise.withResolvers<void>()
    const newRelease = Promise.withResolvers<void>()
    const newTask = queues.run("s-reuse", abort.signal, async () => {
      newEntered.resolve()
      await newRelease.promise
      return "new"
    })
    await newEntered.promise
    expect(queues.size).toBe(1)

    oldRelease.resolve()
    expect(await oldTask).toBe("old")
    expect(queues.size).toBe(1)

    newRelease.resolve()
    expect(await newTask).toBe("new")
    expect(queues.size).toBe(0)
  })
})
