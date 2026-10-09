import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { SubprocessHandle, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess"

/** Restore Electron's Node launch mode only for the official PTC bootstrap. */
export function electronPtcSpawnSpec(
  spec: SubprocessSpawnSpec,
  executable: string,
  bootstrap: string,
): SubprocessSpawnSpec {
  if (spec.stdio.control !== "pipe" || !spec.argv.includes(executable) || !spec.argv.includes(bootstrap)) return spec
  return { ...spec, env: { ...spec.env, ELECTRON_RUN_AS_NODE: "1" } }
}

/** Use the public subprocess provider seam; process ownership stays with DSH. */
export async function installElectronSubprocess(
  ctx: { registry: { plugin(plugin: unknown, config?: unknown): PromiseLike<unknown> } },
  installAnchor: string,
): Promise<void> {
  if (!process.versions.electron) return
  const requireRuntime = createRequire(installAnchor)
  const Base = requireRuntime("@deepseek-ai/dsh-subprocess-local").LocalSubprocessRuntime as new (ctx: unknown) => {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  }
  const bootstrap = join(
    dirname(requireRuntime.resolve("@deepseek-ai/dsh-ptc-runtime-node/package.json")),
    "lib/process.js",
  )
  class ElectronSubprocessRuntime extends Base {
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      return super.spawn(electronPtcSpawnSpec(spec, process.execPath, bootstrap))
    }
  }
  await ctx.registry.plugin(ElectronSubprocessRuntime)
}
