import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { DEFAULT_DSH_RUNTIME_MANIFEST, resolveInstallAnchor } from "@wopal/ellamaka-cordis/runtime"
import { Global } from "@wopal/ellamaka-core/global"

/**
 * Internal process role for the official `dsh` CLI.
 *
 * `ellamaka dsh plugin` forwards install verbs to the official installer, but
 * a compiled product cannot hand arbitrary JS to its own executable. This role
 * runs the closure's `dsh` entry point in a child of the current CLI: DSH_HOME
 * points at this installation's home and the forwarded arguments become the
 * child's argv verbatim.
 *
 * It is intercepted BEFORE yargs parses anything: the forwarded arguments
 * contain `--profile`, which the `dsh` parent also declares, so a subcommand
 * would have it hoisted away instead of reaching the official CLI.
 */

export interface OfficialInvocation {
  /** The Ellamaka territory root (`$WOPAL_HOME/dsh`). */
  home: string
  /** Arguments for the official CLI, verbatim (`plugin --profile web add …`). */
  forwarded: string[]
}

/** Parse `<cli> dsh official --home <dir> <args…>`. */
export function parseOfficialInvocation(argv: readonly string[]): OfficialInvocation | undefined {
  const dsh = argv.indexOf("dsh")
  // The token must sit at the command position, immediately after the
  // runtime/entry (argv[1] under `bun <entry>`, argv[0] in a compiled
  // product). Without this, `ellamaka run dsh official` would be hijacked.
  const entry = dsh === 1 ? argv[0] : dsh === 2 ? argv[1] : undefined
  if (entry === undefined || argv[dsh - 1] !== entry) return undefined
  if (argv[dsh + 1] !== "official") return undefined
  const rest = argv.slice(dsh + 2)
  const at = rest.indexOf("--home")
  const home = at === -1 ? undefined : rest[at + 1]
  if (home === undefined || home.length === 0) {
    throw new Error("dsh official requires --home <dsh-root>")
  }
  const forwarded = [...rest.slice(0, at), ...rest.slice(at + 2)]
  if (forwarded.length === 0) {
    throw new Error("dsh official needs arguments (e.g. plugin --profile web add <package>)")
  }
  return { home, forwarded }
}

function isRunCliModule(value: unknown): value is { runCli: () => Promise<void> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "runCli" in value &&
    typeof (value as { runCli?: unknown }).runCli === "function"
  )
}

function dshEntryPoint(): string {
  const anchor = resolveInstallAnchor(Global.Path.wopalHome, DEFAULT_DSH_RUNTIME_MANIFEST).path
  const resolved = existsSync(anchor) ? anchor : createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json")
  const bin = join(dirname(resolved), "lib", "bin.js")
  if (!existsSync(bin)) throw new Error(`dsh: official entry point is missing at ${bin}`)
  return bin
}

/**
 * Run the official CLI when this process was launched as its child role.
 * Returns false for every ordinary invocation.
 */
export async function runDshOfficialIfRequested(argv: readonly string[]): Promise<boolean> {
  const invocation = parseOfficialInvocation(argv)
  if (invocation === undefined) return false
  const bin = dshEntryPoint()
  process.env.DSH_HOME = join(invocation.home, "home")
  process.argv = [process.execPath, bin, ...invocation.forwarded]
  // The official entry point exits the process for the plugin command; the
  // boolean only matters for a caller that ever reaches it.
  const official: unknown = await import(pathToFileURL(bin).href)
  if (!isRunCliModule(official)) throw new Error(`dsh: ${bin} does not export the official CLI entry`)
  await official.runCli()
  return true
}
