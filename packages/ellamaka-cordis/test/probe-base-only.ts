/**
 * Probe: mount a BASE-ONLY dsh profile (dsh-base bundle, no web-app) onto a
 * fresh cordis context and verify:
 *  - the container boots WITHOUT a webserver (no 4098 / no webServer service)
 *  - fs-search is present in the base bundle and its grep/glob tools register
 *  - a real grep executes through the container runtime
 *
 * This validates the "full container, no webserver" shape TUI needs.
 */
import { createRequire } from "node:module"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const req = createRequire(import.meta.url)
const dshAnchorDir = req.resolve("@deepseek-ai/dsh/package.json").replace("/package.json", "")
const dshReq = createRequire(`${dshAnchorDir}/package.json`)

const { Context } = await import("@deepseek-ai/cordis")
const {
  loadProfile,
  mountRootInclude,
  assertEntriesActivated,
  healProfilesModuleFallback,
  resolveProfileDir,
  initProfile,
  PROFILE_TEMPLATES,
} = await import("@deepseek-ai/dsh-app-boot")
const { provideCmdline } = await import("@deepseek-ai/dsh-cmdline")
const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await import("@deepseek-ai/dsh-launch-environment")
const { dshHomePath } = await import("@deepseek-ai/dsh-home-paths")
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default
const { pathToFileURL } = await import("node:url")

console.log("PROFILE_TEMPLATES:", JSON.stringify(PROFILE_TEMPLATES))

// workspace with a needle to find
const ws = "/Volumes/U500G/coding/wopal-workspace/.wopal-space/.tmp/base-only-ws"
mkdirSync(ws, { recursive: true })
writeFileSync(`${ws}/haystack.txt`, "alpha\nNEEDLE-here\nbeta\n")

// Use a dedicated base-only profile dir under the dsh home
const home = "/Volumes/U500G/coding/wopal-workspace/.wopal-space/.tmp/dsh-home"
const profileName = "base-only"
const profileDir = resolveProfileDir(profileName, home)
initProfile(profileDir, ["@deepseek-ai/dsh-base"])
console.log("profile dir:", profileDir)

healProfilesModuleFallback(req.resolve("@deepseek-ai/dsh/package.json"), home)

const profile = loadProfile("ellamaka", profileName, dshAnchorDir, home)
console.log("profile bundles:", profile.layers.map((l) => l.packageName))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(join(profile.dir, "cordis.yml")).href + "/"
ctx.provide("dshHomePath", dshHomePath)
const loaderFiber = await ctx.registry.plugin(Loader)
ctx.provide(
  DSH_LAUNCH_ENVIRONMENT_KEY,
  createLaunchEnvironmentSnapshot([{ source: "process", values: process.env as Record<string, string> }]),
)
provideCmdline(ctx, { args: ["--port", "0"], exit: () => {} })

const rootConfig = join(profile.dir, "cordis.yml")
// The root config is the host-owned include: an empty entry list. The
// bundle + profile patch layers carry every plugin.
writeFileSync(rootConfig, "[]\n")
const patches = [
  ...profile.layers.flatMap((layer) => layer.patches),
  ...profile.patches,
  // code-runtime needs node:module.stripTypeScriptTypes (Node 22.18+), which
  // the bun dev runtime lacks; disable it to boot under bun.
  { id: "code-runtime", disabled: true },
  // HMR needs --expose-internals (bun lacks it); TUI has no hot reload need.
  { id: "hmr", disabled: true },
]
const includeEntry = await mountRootInclude(ctx, rootConfig, patches)
await ctx.get("loader")?.await()
if (ctx.get("loader") === undefined || includeEntry === undefined) {
  throw new Error("base-only: dsh boot did not provide a loader service")
}
await assertEntriesActivated(ctx, "ellamaka")

// KEY CHECK: no webserver service should exist in base-only
const webServer = ctx.get("webServer")
console.log("webServer present (expect undefined):", webServer)

const tools = ctx.get("tools")
console.log("tools service present:", !!tools)
if (tools) {
  const names = tools.schemas().map((s: { name: string }) => s.name).sort()
  console.log("tool count:", names.length)
  console.log("has grep:", names.includes("grep"), "has glob:", names.includes("glob"))
  console.log("sample tools:", names.slice(0, 20).join(", "))

  // execute one real grep
  const result = await tools.execute({
    callId: "probe-grep-1",
    name: "grep",
    arguments: { pattern: "NEEDLE", path: ws },
    signal: new AbortController().signal,
  })
  console.log("grep isError:", result.isError)
  const text = (result.content ?? [])
    .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text : ""))
    .join("\n")
  console.log("grep output:", JSON.stringify(text.slice(0, 300)))
}

await loaderFiber.dispose()
await ctx.fiber.dispose()
console.log("DONE")
