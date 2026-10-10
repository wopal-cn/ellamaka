import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

const CHILD_MARKER = "--ellamaka-dsh-ptc-child"
const PROVIDER_MARKER_ENV = "DSH_PTC_RUNTIME_NODE"
const CHILD_FILTER = /[\\/]@deepseek-ai[\\/]dsh-ptc-runtime-node[\\/]lib[\\/]process\.js$/
const CHILD_SOCKET_IMPORT = 'import { Socket } from "node:net";'
const CHILD_MARKER_CHECK = 'if (marker !== "pipe") throw new Error("subprocess control channel was not inherited");'
const CHILD_SOCKET = `return new Socket({
\t\tfd: 7,
\t\treadable: true,
\t\twritable: true,
\t\tallowHalfOpen: true
\t});`

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

/**
 * Enter the private PTC child role used by a compiled Bun executable. The
 * parent DSH provider supplies the official process.js path and message cap;
 * this role only maps the upstream fd-7 bootstrap seam onto stdin/stdout.
 */
export async function runBunPtcChildIfRequested(): Promise<boolean> {
  if (process.versions.bun === undefined || process.env[PROVIDER_MARKER_ENV] !== "1") return false
  const marker = process.argv.indexOf(CHILD_MARKER)
  if (marker < 0) return false
  const processPath = process.argv[marker + 1]
  const maxMessageBytes = process.argv[marker + 2]
  if (
    !processPath ||
    !isAbsolute(processPath) ||
    !CHILD_FILTER.test(processPath) ||
    !maxMessageBytes ||
    !/^\d+$/.test(maxMessageBytes)
  ) {
    throw new Error("ellamaka-cordis: invalid Bun PTC child invocation")
  }

  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  if (bun === undefined) throw new Error("ellamaka-cordis: Bun runtime API is unavailable in PTC child")
  bun.plugin({
    name: "ellamaka-dsh-ptc-child",
    setup(builder) {
      builder.onLoad({ filter: CHILD_FILTER }, async ({ path }) => {
        let source = await bun.file(path).text()
        if (
          !source.includes(CHILD_SOCKET_IMPORT) ||
          !source.includes(CHILD_MARKER_CHECK) ||
          !source.includes(CHILD_SOCKET)
        ) {
          throw new Error("ellamaka-cordis: DSH PTC child shape changed; expected fd 7 Node Socket bootstrap")
        }
        source = source
          .replace(
            CHILD_SOCKET_IMPORT,
            'import { createReadStream, createWriteStream } from "node:fs";\nimport { Duplex } from "node:stream";',
          )
          .replace(CHILD_MARKER_CHECK, "void marker;")
          .replace(
            CHILD_SOCKET,
            'return Duplex.from({ readable: createReadStream("", { fd: 0, autoClose: false }), writable: createWriteStream("", { fd: 1, autoClose: false }) });',
          )
        return { contents: source, loader: "js" }
      })
    },
  })

  Reflect.deleteProperty(process.env, PROVIDER_MARKER_ENV)
  process.argv[2] = maxMessageBytes
  await import(pathToFileURL(processPath).href)
  return true
}
