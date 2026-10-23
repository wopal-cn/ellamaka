const UTIL_IMPORT = 'import { getSystemErrorMessage, getSystemErrorName, inspect } from "node:util";'
const SUBPROCESS_FILTER = /[\\/]@deepseek-ai[\\/]dsh-subprocess-local[\\/]lib[\\/]runner-launch-[^\\/]+\.js$/
const REPLACEMENT =
  'import { getSystemErrorName, inspect } from "node:util";\n' +
  "const getSystemErrorMessage = (code) => getSystemErrorName(code);"

interface BunPluginBuilder {
  onLoad(
    options: { filter: RegExp },
    callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>,
  ): void
}

interface BunRuntime {
  file(path: string): { text(): Promise<string> }
  plugin(plugin: { name: string; setup(builder: BunPluginBuilder): void }): void
}

let installed = false

/**
 * Bun 1.3 exposes `syncBuiltinESMExports` but cannot add a new named export to
 * the already-bound `node:util` namespace. The official subprocess provider
 * imports `getSystemErrorMessage` (Node 22.12+), so its ESM import fails and
 * every dependent entry stays pending. Replace only that public named import
 * with the documented name/code pair; framing, sandbox and ownership remain
 * upstream. The anchor must match exactly once, otherwise the host fails
 * loudly instead of silently running without the subprocess backend.
 */
export function rewriteSubprocessUtilImport(source: string): string {
  const first = source.indexOf(UTIL_IMPORT)
  if (first < 0 || first !== source.lastIndexOf(UTIL_IMPORT))
    throw new Error(
      "ellamaka-cordis: DSH subprocess provider util import changed; expected the rc.2 getSystemErrorMessage seam",
    )
  return source.replace(UTIL_IMPORT, REPLACEMENT)
}

export function installBunSubprocessCompatibility(): void {
  if (installed || process.versions.bun === undefined) return
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  if (bun === undefined) throw new Error("ellamaka-cordis: Bun runtime API is unavailable")

  bun.plugin({
    name: "ellamaka-dsh-subprocess-compat",
    setup(builder) {
      builder.onLoad({ filter: SUBPROCESS_FILTER }, async ({ path }) => ({
        contents: rewriteSubprocessUtilImport(await bun.file(path).text()),
        loader: "js",
      }))
    },
  })
  installed = true
}
