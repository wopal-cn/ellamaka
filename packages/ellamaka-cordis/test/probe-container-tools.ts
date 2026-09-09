/**
 * Probe: what tools exist in the mounted dsh web container?
 * Answers whether fs-search (grep/glob) is in the global layer after
 * mountDshWeb, or only loaded per-preset.
 */
import { createRequire } from "node:module"

const req = createRequire(import.meta.url)
const dshAnchorDir = req.resolve("@deepseek-ai/dsh/package.json").replace("/package.json", "")

const { bootDshWeb } = await import("@wopal/ellamaka-cordis/dsh-web")
const host = await bootDshWeb({ port: 0, home: process.env.DSH_probe_HOME ?? undefined })
console.log("dsh container up at", host.url)

const ctx = (host as unknown as { dispose: () => Promise<void> }) // placeholder to keep types honest
// reach the container ctx through the module internals: bootDshWeb owns it, so
// re-mount approach instead: use mountDshWeb on our own Context to keep a handle.
await host.dispose()

const { Context } = await import("@deepseek-ai/cordis")
const { mountDshWeb } = await import("@wopal/ellamaka-cordis/dsh-web")
const context = new Context()
const host2 = await mountDshWeb(context, { port: 0 })

const tools = context.get("tools")
if (!tools) {
  console.log("NO tools service in container")
} else {
  const schemas = tools.schemas()
  console.log(`tools in global layer: ${schemas.length}`)
  for (const s of schemas.map((x: { name: string }) => x.name).sort()) console.log(" -", s)
}

await host2.dispose()
await context.fiber.dispose()
