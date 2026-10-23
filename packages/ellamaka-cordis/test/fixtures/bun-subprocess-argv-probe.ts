import "../../src/runtime/preload"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runBunPtcChildIfRequested } from "../../src/runtime/bun-ptc-child"
import { spawnSync } from "node:child_process"
import { isCompiledBunMain } from "../../src/runtime/bun-ptc"
import { installBunSubprocessCompatibility, rewriteSubprocessScopeArgs } from "../../src/runtime/bun-subprocess"

if (await runBunPtcChildIfRequested()) {
  // The official runner owns this invocation.
} else if (process.env.ELLAMAKA_SUBPROCESS_ARGV_CHILD === "1") {
  process.stdout.write(JSON.stringify(process.argv.slice(2)))
} else {
  installBunSubprocessCompatibility()
  const path = process.env.ELLAMAKA_SUBPROCESS_TEST_PROVIDER
  if (!path) throw new Error("missing test provider")
  // Exercise the installed provider's real argument builder, not a test copy.
  const source = rewriteSubprocessScopeArgs(readFileSync(path, "utf8"))
  const functionSource = source.match(/function scopeArgs\(unitBase, invocation, argv\) \{[\s\S]*?\n\}/)?.[0]
  if (!functionSource) throw new Error("official scope argument builder missing")
  const probeDir = mkdtempSync(join(tmpdir(), "ellamaka-scope-args-"))
  const scopeModule = join(probeDir, "scope.mjs")
  writeFileSync(scopeModule, `export ${functionSource}`)
  const { scopeArgs } = await import(pathToFileURL(scopeModule).href)
  const invocation = isCompiledBunMain(Bun.main) ? [process.execPath] : [process.execPath, import.meta.path]
  const scope = scopeArgs("test", invocation, process.argv.slice(2))
  const commandAt = scope.indexOf("--") + 1
  const result = spawnSync(scope[commandAt], scope.slice(commandAt + 1), {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, ELLAMAKA_SUBPROCESS_ARGV_CHILD: "1" },
  })
  if (result.status !== 0) throw new Error(result.stderr)
  const requestDir = mkdtempSync(join(tmpdir(), "ellamaka-runner-parser-"))
  const request = join(requestDir, "launch-request.json")
  writeFileSync(request, "{}")
  const runnerPath = join(dirname(path), "runner.js")
  const runnerInvocation = isCompiledBunMain(Bun.main)
    ? [process.execPath, runnerPath]
    : [
        process.execPath,
        "--preload",
        fileURLToPath(new URL("./bun-subprocess-preload.ts", import.meta.url)),
        runnerPath,
      ]
  const runnerScope = scopeArgs("test", runnerInvocation, process.argv.slice(2))
  const runnerAt = runnerScope.indexOf("--") + 1
  const runner = spawnSync(runnerScope[runnerAt], runnerScope.slice(runnerAt + 1), {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, DSH_SUBPROCESS_RUNNER: request },
  })
  if (!existsSync(join(requestDir, "startup-error.json")))
    throw new Error(`runner did not report startup error: ${runner.status} ${runner.signal} ${runner.stderr}`)
  const error = JSON.parse(readFileSync(join(requestDir, "startup-error.json"), "utf8"))
  process.stdout.write(
    JSON.stringify({
      argv: JSON.parse(result.stdout),
      status: runner.status,
      error,
      requestExists: existsSync(request),
    }),
  )
}
