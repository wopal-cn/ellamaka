import { transformSync } from "amaro"
import { Duplex, type Readable, type Writable } from "node:stream"
import { fileURLToPath } from "node:url"

const STRIP_TYPES = Symbol.for("ellamaka.dsh.stripTypeScriptTypes")
const BOOTSTRAP_ARGS = Symbol.for("ellamaka.dsh.ptcBootstrapArgs")
const PACKAGED_RUNTIME = Symbol.for("ellamaka.dsh.ptcPackagedRuntime")
const PRIVATE_CHILD = Symbol.for("ellamaka.dsh.ptcPrivateChild")
const CONTROL_STREAM = Symbol.for("ellamaka.dsh.ptcControlStream")
const CHILD_MARKER = "--ellamaka-dsh-ptc-child"
const PROVIDER_IMPORT = 'import { stripTypeScriptTypes } from "node:module";'
const PROVIDER_FILTER = /[\\/]@deepseek-ai[\\/]dsh-ptc-runtime-node[\\/]lib[\\/]index\.js$/
const PROVIDER_BOOTSTRAP_START = "function bootstrapArgs(fs, config, maxMessageBytes) {\n"
const PROVIDER_PACKAGED = 'const packaged = "pkg" in process && this.config.bootstrapPath === void 0;'
const PROVIDER_CHILD_ENV = `if (packaged) {
\t\t\t\tenv.DSH_PTC_RUNTIME_NODE = "1";
\t\t\t\tenv.NODE_OPTIONS = heapFlag;
\t\t\t}`
const PROVIDER_STDIO = `stdio: {
\t\t\t\t\tstdin: "ignore",
\t\t\t\t\tstdout: "pipe",
\t\t\t\t\tstderr: "pipe",
\t\t\t\t\tcontrol: "pipe"
\t\t\t\t}`
const PROVIDER_VALIDATE =
  'if (launched.control === void 0 || launched.stdout === void 0 || launched.stderr === void 0) throw new Error("subprocess provider did not supply the requested control and output pipes");'
const PROVIDER_STDOUT_CAPTURE = `const stdoutDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
\t\t\tconst stderrDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
\t\t\thandle.stdout?.on("data", (chunk) => {
\t\t\t\tconst text = stdoutDecoder.decode(chunk, { stream: true });
\t\t\t\tif (text.length > 0) admit(text);
\t\t\t});
\t\t\thandle.stdout?.on("end", () => {
\t\t\t\tconst text = stdoutDecoder.decode();
\t\t\t\tif (text.length > 0) admit(text);
\t\t\t});
\t\t\thandle.stdout?.on("error", (error) => {
\t\t\t\tfinish({
\t\t\t\t\tkind: "worker-exit",
\t\t\t\t\tmessage: messageOf(error)
\t\t\t\t});
\t\t\t});`
const PROVIDER_DRAIN =
  "Promise.all([drainOutput(handle.stdout, this.config.graceMs), drainOutput(handle.stderr, this.config.graceMs)])"
const PROVIDER_TRANSPORT = "const transport = new JsonChannel(launched.control, this.config.maxMessageBytes,"

interface BunPluginBuilder {
  onLoad(
    options: { filter: RegExp },
    callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>,
  ): void
}

interface BunRuntime {
  readonly main: string
  file(path: string): { text(): Promise<string> }
  plugin(plugin: { name: string; setup(builder: BunPluginBuilder): void }): void
}

let installed = false

export function isCompiledBunMain(main: string): boolean {
  return main.startsWith("/$bunfs/") || /^[A-Za-z]:\/~BUN\//.test(main)
}

function sourceChildEntry(): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
  return fileURLToPath(new URL(`./bun-ptc-child-entry${ext}`, import.meta.url))
}

function stripBunTypeScriptTypes(source: string): string {
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

/**
 * Make the released DSH Node PTC provider run under Bun without forking its
 * execution protocol. rc.2 imports Node's `stripTypeScriptTypes` and uses an
 * extra child-process pipe for JsonChannel control. Bun needs a narrow host
 * replacement for type stripping plus a standard-stdio control transport; the
 * provider framing, bindings, sandbox, cancellation and cleanup stay upstream.
 */
export function installBunPtcCompatibility(): void {
  if (installed || process.versions.bun === undefined) return
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun
  if (bun === undefined) throw new Error("ellamaka-cordis: Bun runtime API is unavailable")

  Object.defineProperty(globalThis, STRIP_TYPES, {
    configurable: true,
    value: stripBunTypeScriptTypes,
  })
  Object.defineProperty(globalThis, PACKAGED_RUNTIME, {
    configurable: true,
    value: () => isCompiledBunMain(bun.main),
  })
  Object.defineProperty(globalThis, PRIVATE_CHILD, {
    configurable: true,
    value: () => true,
  })
  Object.defineProperty(globalThis, CONTROL_STREAM, {
    configurable: true,
    value: (readable: Readable, writable: Writable) => Duplex.from({ readable, writable }),
  })
  Object.defineProperty(globalThis, BOOTSTRAP_ARGS, {
    configurable: true,
    value: (processPath: string, maxMessageBytes: number) =>
      isCompiledBunMain(bun.main)
        ? [CHILD_MARKER, processPath, String(maxMessageBytes)]
        : [sourceChildEntry(), CHILD_MARKER, processPath, String(maxMessageBytes)],
  })

  bun.plugin({
    name: "ellamaka-dsh-ptc-compat",
    setup(builder) {
      builder.onLoad({ filter: PROVIDER_FILTER }, async ({ path }) => {
        let source = await bun.file(path).text()
        const first = source.indexOf(PROVIDER_IMPORT)
        const last = source.lastIndexOf(PROVIDER_IMPORT)
        if (
          first < 0 ||
          first !== last ||
          !source.includes(PROVIDER_BOOTSTRAP_START) ||
          !source.includes(PROVIDER_PACKAGED) ||
          !source.includes(PROVIDER_CHILD_ENV) ||
          !source.includes(PROVIDER_STDIO) ||
          !source.includes(PROVIDER_VALIDATE) ||
          !source.includes(PROVIDER_STDOUT_CAPTURE) ||
          !source.includes(PROVIDER_DRAIN) ||
          !source.includes(PROVIDER_TRANSPORT)
        ) {
          throw new Error(
            "ellamaka-cordis: DSH PTC provider shape changed; expected rc.2 strip-types, bootstrap and child-env seams",
          )
        }
        source = source
          .replace(
            PROVIDER_IMPORT,
            'const stripTypeScriptTypes = globalThis[Symbol.for("ellamaka.dsh.stripTypeScriptTypes")];',
          )
          .replace(
            PROVIDER_BOOTSTRAP_START,
            `${PROVIDER_BOOTSTRAP_START}\tif (config.bootstrapPath === void 0) {\n\t\tconst ellamakaArgs = globalThis[Symbol.for("ellamaka.dsh.ptcBootstrapArgs")]?.(fileURLToPath(new URL("./process.js", import.meta.url)), maxMessageBytes);\n\t\tif (ellamakaArgs !== undefined) return ellamakaArgs;\n\t}\n`,
          )
          .replace(
            PROVIDER_PACKAGED,
            'const packaged = (globalThis[Symbol.for("ellamaka.dsh.ptcPackagedRuntime")]?.() ?? ("pkg" in process)) && this.config.bootstrapPath === void 0;',
          )
          .replace(
            PROVIDER_CHILD_ENV,
            `if (packaged || globalThis[Symbol.for("ellamaka.dsh.ptcPrivateChild")]?.() === true) {\n\t\t\t\tenv.DSH_PTC_RUNTIME_NODE = "1";\n\t\t\t\tif (packaged) env.NODE_OPTIONS = heapFlag;\n\t\t\t}`,
          )
          .replace(
            PROVIDER_STDIO,
            `stdio: {\n\t\t\t\t\tstdin: "pipe",\n\t\t\t\t\tstdout: "pipe",\n\t\t\t\t\tstderr: "pipe"\n\t\t\t\t}`,
          )
          .replace(
            PROVIDER_VALIDATE,
            'const ellamakaControl = globalThis[Symbol.for("ellamaka.dsh.ptcControlStream")]?.(launched.stdout, launched.stdin);\n\t\t\tif (ellamakaControl === void 0 || launched.stderr === void 0) throw new Error("subprocess provider did not supply the Bun PTC stdio transport");',
          )
          .replace(PROVIDER_STDOUT_CAPTURE, 'const stderrDecoder = new TextDecoder("utf-8", { ignoreBOM: true });')
          .replace(PROVIDER_DRAIN, "Promise.all([drainOutput(handle.stderr, this.config.graceMs)])")
          .replace(
            PROVIDER_TRANSPORT,
            "const transport = new JsonChannel(ellamakaControl, this.config.maxMessageBytes,",
          )
        return { contents: source, loader: "js" }
      })
    },
  })
  installed = true
}
