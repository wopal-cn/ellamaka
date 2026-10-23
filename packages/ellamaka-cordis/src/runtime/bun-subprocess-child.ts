import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import { isCompiledBunMain } from "./bun-ptc.js"
import { installBunSubprocessCompatibility } from "./bun-subprocess.js"

const RUNNER_ENV = "DSH_SUBPROCESS_RUNNER"
const RUNNER_PATH = /[\\/]@deepseek-ai[\\/]dsh-subprocess-local[\\/]lib[\\/]runner\.js$/

/** Re-enter the official runner when its executable is a compiled Bun product. */
export async function runBunSubprocessChildIfRequested(): Promise<boolean> {
  if (process.versions.bun === undefined) return false
  const bun = (globalThis as typeof globalThis & { Bun?: { readonly main: string } }).Bun
  if (bun === undefined || !isCompiledBunMain(bun.main)) return false
  const selection = process.env[RUNNER_ENV]
  if (!selection) return false

  const runnerPath = process.argv[2]
  if (
    !runnerPath ||
    !isAbsolute(runnerPath) ||
    !RUNNER_PATH.test(runnerPath) ||
    process.argv[3] !== "--" ||
    process.argv.length < 5
  ) {
    throw new Error("ellamaka-cordis: invalid Bun subprocess runner invocation")
  }

  Reflect.deleteProperty(process.env, RUNNER_ENV)
  // Compiled Bun retains its virtual main before the runner and keeps `--`.
  process.argv = [process.execPath, runnerPath, ...process.argv.slice(3)]
  installBunSubprocessCompatibility()
  const { runSelectedSubprocessRunner } = await import(pathToFileURL(runnerPath).href)
  await runSelectedSubprocessRunner(selection)
  return true
}
