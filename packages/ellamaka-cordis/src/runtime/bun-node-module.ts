/**
 * One version-pinned Bun module-loading seam for DSH Web RC.3.
 * The official PTC Node Worker, bootstrap, fd7/RPC and sandbox are untouched.
 */
import { transformSync } from "amaro"
import { createHash } from "node:crypto"

const PROVIDER_FILTER = /[\\/]@deepseek-ai[\\/]dsh-ptc-runtime-node[\\/]lib[\\/]index\.js$/
const PROVIDER_SHA256 = "2eee67bc472e933cc71f9ee25c04ed266f56be0310b809cadeb31d5d5c804349"
const IMPORT = 'import { stripTypeScriptTypes } from "node:module";'
const STRIP_TYPES = Symbol.for("ellamaka.dsh.stripTypeScriptTypes")

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

export function stripProviderModule(source: string): string {
  if (createHash("sha256").update(source).digest("hex") !== PROVIDER_SHA256)
    throw new Error("ellamaka-cordis: DSH PTC provider is not the pinned 0.2.2-rc.3 release")
  const first = source.indexOf(IMPORT)
  if (first < 0 || first !== source.lastIndexOf(IMPORT))
    throw new Error("ellamaka-cordis: DSH PTC RC.3 named import seam changed")
  // The only substitution is the missing Bun node:module export. The full
  // official provider's worker lifecycle and transport stay byte-for-byte.
  return source.replace(
    IMPORT,
    'const stripTypeScriptTypes = globalThis[Symbol.for("ellamaka.dsh.stripTypeScriptTypes")];',
  )
}

function stripTypeScriptTypes(source: string): string {
  try {
    return transformSync(source, { mode: "strip-only" }).code
  } catch (error) {
    if (error instanceof Error) throw error
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
      const normalized = new SyntaxError(error.message)
      Object.defineProperty(normalized, "code", { configurable: true, value: "ERR_INVALID_TYPESCRIPT_SYNTAX" })
      throw normalized
    }
    throw error
  }
}

export function installBunNodeModuleCompatibility(): void {
  if (installed || process.versions.bun === undefined) return
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  if (!bun) throw new Error("ellamaka-cordis: Bun runtime API is unavailable")
  Object.defineProperty(globalThis, STRIP_TYPES, { configurable: true, value: stripTypeScriptTypes })
  bun.plugin({
    name: "ellamaka-dsh-rc3-strip-types",
    setup(builder) {
      builder.onLoad({ filter: PROVIDER_FILTER }, async ({ path }) => ({
        contents: stripProviderModule(await bun.file(path).text()),
        loader: "js",
      }))
    },
  })
  installed = true
}
