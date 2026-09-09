/**
 * Probe: manually mount fs-search onto the container's GLOBAL layer and run
 * one real grep. Validates the experiment-2 mounting path (bypassing the
 * agent-preset plane which the web container leaves empty).
 */
import { createRequire } from "node:module"
import { mkdirSync, writeFileSync } from "node:fs"

const req = createRequire(import.meta.url)
const dshAnchorDir = req.resolve("@deepseek-ai/dsh/package.json").replace("/package.json", "")
const dshReq = createRequire(`${dshAnchorDir}/package.json`)

const { Context } = await import("@deepseek-ai/cordis")
const { mountDshWeb } = await import("@wopal/ellamaka-cordis/dsh-web")

// workspace with a needle to find
const ws = "/Volumes/U500G/coding/wopal-workspace/.wopal-space/.tmp/fs-search-ws"
mkdirSync(ws, { recursive: true })
writeFileSync(`${ws}/haystack.txt`, "alpha\nNEEDLE-here\nbeta\n")

const ctx = new Context()
const host = await mountDshWeb(ctx, { port: 0 })
console.log("container up:", host.url)

const tools = ctx.get("tools")
console.log("tools before fs-search mount:", tools ? tools.schemas().length : "no tools service")

// resolve fs-search through the dsh anchor closure
const fsSearchMod = await import(dshReq.resolve("@deepseek-ai/dsh-tool-fs-search"))
console.log("fs-search exports:", Object.keys(fsSearchMod).filter((k) => !k.startsWith("_")).slice(0, 12))

// build the resolved config via its schemastery Config (fills defaults)
const config = fsSearchMod.Config({ sampleOverCapGlobResults: false })
console.log("resolved config keys:", Object.keys(config))

// mount as a function plugin onto the container root ctx (global layer)
const fiber = ctx.plugin(fsSearchMod as never, config)
await Promise.resolve(fiber).catch((e) => {
  console.log("MOUNT FAILED:", e.message)
  throw e
})

const names = tools.schemas().map((s: { name: string }) => s.name).sort()
console.log("tools after mount:", names)

// execute one real grep through the container runtime
const result = await tools.execute({
  callId: "probe-grep-1",
  name: "grep",
  arguments: { pattern: "NEEDLE", path: ws },
  signal: new AbortController().signal,
})
console.log("isError:", result.isError)
const text = (result.content ?? [])
  .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text : ""))
  .join("\n")
console.log("grep output:", JSON.stringify(text.slice(0, 300)))

await host.dispose()
await ctx.fiber.dispose()
