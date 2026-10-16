import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ToolContext, type ToolDefinition } from "@wopal/ellamaka-plugin"
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools"
import { bootDshTools } from "../src/dsh-web"
import { dshAdapter } from "../src/dsh-adapter/index"
import { prepareDshProfiles } from "./fixture/prepare-dsh-profiles"

test("built-in adapter preserves installed schemas and runs the real session-free tool profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "ellamaka-adapter-home-"))
  const workspace = await mkdtemp(join(tmpdir(), "ellamaka-adapter-workspace-"))
  prepareDshProfiles(home)
  const host = await bootDshTools({ home, port: 0 })
  const globals = globalThis as Record<string, unknown>
  const previous = globals.__ellamakaDshContainer
  const enabled = process.env.ELLAMAKA_DSH
  globals.__ellamakaDshContainer = host.ctx
  process.env.ELLAMAKA_DSH = "1"
  const hook = await dshAdapter({
    directory: workspace,
    worktree: workspace,
    pluginConfig: { "dsh-adapter": { sandbox: { enabled: true } } },
  })
  try {
    const output: { tools: Record<string, ToolDefinition> } = { tools: {} }
    await hook["tool.provider"]!({ providerID: "test", modelID: "test" }, output)
    const tools: {
      schemas(): {
        name: string
        parameters: {
          properties: Record<string, { enum?: unknown[]; const?: unknown; description?: string }>
          required?: string[]
        }
      }[]
    } = host.ctx.get("tools")
    const mapping: Record<string, string> = { file_path: "filePath", old_string: "oldString", new_string: "newString" }
    let checked = 0
    for (const original of tools.schemas()) {
      const projected = output.tools[original.name === "pwsh" ? "bash" : original.name]
      if (!projected) continue
      for (const [name, property] of Object.entries(original.parameters.properties)) {
        const projectedName = mapping[name] ?? name
        const type = projected.args[projectedName]
        const candidates = [
          null,
          "x",
          0,
          1,
          1.5,
          true,
          [],
          {},
          ...(property.enum ?? []),
          ...(Object.hasOwn(property, "const") ? [property.const] : []),
        ]
        for (const value of candidates) {
          expect(type.safeParse(value).success, `${original.name}.${name}: ${JSON.stringify(value)}`).toBe(
            validateJsonSchemaValue(property, value).length === 0,
          )
          checked++
        }
        if (property.description) expect(type.description).toBe(property.description)
        expect(type.safeParse(undefined).success).toBe(!original.parameters.required?.includes(name))
      }
    }
    expect(checked).toBeGreaterThan(100)
    const ctx: ToolContext = {
      sessionID: "real-adapter",
      messageID: "message",
      agent: "test",
      directory: workspace,
      worktree: workspace,
      abort: new AbortController().signal,
      ask: async () => {},
      metadata() {},
    }
    await output.tools.write.execute({ filePath: "new.txt", content: "created" }, ctx)
    expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("created")
    await writeFile(join(workspace, "edit.txt"), "before\n")
    await output.tools.read.execute({ filePath: "edit.txt" }, ctx)
    const edited = await output.tools.edit.execute(
      { filePath: "edit.txt", oldString: "before", newString: "after" },
      ctx,
    )
    expect(await readFile(join(workspace, "edit.txt"), "utf8")).toBe("after\n")
    expect(edited).toMatchObject({ metadata: { filediff: { before: "before\n", after: "after\n" } } })
    await expect(
      output.tools.write.execute(
        { filePath: "denied.txt", content: "denied" },
        { ...ctx, extra: { sandboxMode: "read-only" } },
      ),
    ).rejects.toThrow()
    const asks: string[] = []
    await output.tools.write.execute(
      {
        filePath: "approved.txt",
        content: "approved",
        sandbox_permissions: "workspace-write",
        justification: "controlled integration test",
      },
      {
        ...ctx,
        extra: { sandboxMode: "read-only" },
        ask: async (request) => {
          asks.push(request.permission)
        },
      },
    )
    expect(asks).toContain("sandbox_escalation")
    expect(await readFile(join(workspace, "approved.txt"), "utf8")).toBe("approved")
    expect(host.ctx.get("sessions", false)).toBeUndefined()
    expect(host.ctx.get("agents", false)).toBeUndefined()
  } finally {
    await hook.dispose?.()
    globals.__ellamakaDshContainer = previous
    if (enabled === undefined) delete process.env.ELLAMAKA_DSH
    else process.env.ELLAMAKA_DSH = enabled
    await host.dispose()
  }
}, 60_000)
