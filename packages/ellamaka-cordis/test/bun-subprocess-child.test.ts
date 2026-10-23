import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixtures", "bun-subprocess-child-probe.ts")
const officialRunner = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-subprocess-local/runner")
let executable: string
let runner: string

function run(args: string[], selection?: string, env: Record<string, string> = {}, source = false) {
  const childEnv = { ...process.env }
  Reflect.deleteProperty(childEnv, "DSH_SUBPROCESS_RUNNER")
  Reflect.deleteProperty(childEnv, "DSH_PTC_RUNTIME_NODE")
  return spawnSync(source ? process.execPath : executable, source ? [fixture, ...args] : args, {
    env: { ...childEnv, ...env, ...(selection === undefined ? {} : { DSH_SUBPROCESS_RUNNER: selection }) },
    encoding: "utf8",
    timeout: 10_000,
  })
}

function evidence(stdout: string, prefix: string) {
  const line = stdout.split("\n").find((entry) => entry.startsWith(prefix))
  if (!line) throw new Error(`Missing ${prefix} evidence:\n${stdout}`)
  return JSON.parse(line.slice(prefix.length))
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "ellamaka runner #"))
  executable = join(root, "bootstrap")
  runner = join(root, "node_modules", "@deepseek-ai", "dsh-subprocess-local", "lib", "runner.js")
  mkdirSync(dirname(runner), { recursive: true })
  // This stub proves the bootstrap contract, not native Linux execve or IPC.
  writeFileSync(
    runner,
    `const markerAtImport = process.env.DSH_SUBPROCESS_RUNNER ?? null
export async function runSelectedSubprocessRunner(selection) {
  console.log("__RUNNER__" + JSON.stringify({
    selection, argv: process.argv, markerAtImport,
    markerAtCall: process.env.DSH_SUBPROCESS_RUNNER ?? null,
    main: import.meta.main,
  }))
  process.exitCode = 23
}
`,
  )
  const build = await Bun.build({
    entrypoints: [fixture],
    format: "esm",
    target: "bun",
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      outfile: executable,
    },
  })
  if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"))
}, 60_000)

describe("compiled Bun subprocess child bootstrap", () => {
  test.each([false, true])("native library cleanup survives forced GC (source=%s)", (source) => {
    const result = run([], undefined, { ELLAMAKA_SUBPROCESS_GC_ANCHOR: officialRunner }, source)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(evidence(result.stdout, "__BOOTSTRAP__").handled).toBe(false)
  })

  test("ordinary startup returns false without a nonempty runner selection", () => {
    for (const selection of [undefined, ""]) {
      for (const args of [[], [runner, "--", "target"]]) {
        const result = run(args, selection)
        expect(result.status).toBe(0)
        expect(evidence(result.stdout, "__BOOTSTRAP__").handled).toBe(false)
        expect(result.stdout).not.toContain("__RUNNER__")
      }
    }
  })

  test("consumes the selection before import and preserves the compiled delimiter and target argv", () => {
    const target = ["target", "with spaces", "", "--", "--flag", "中文"]
    const result = run([runner, "--", ...target], "linux-locator")
    expect(result.stderr).toBe("")
    expect(result.status).toBe(23)
    const bootstrap = evidence(result.stdout, "__BOOTSTRAP__")
    expect(bootstrap.originalArgv[1]).toMatch(/^(?:\/\$bunfs\/|[A-Za-z]:\/~BUN\/)/)
    expect(bootstrap.originalArgv.slice(2)).toEqual([runner, "--", ...target])
    expect(bootstrap.handled).toBe(true)
    expect(bootstrap.selection).toBeNull()
    expect(bootstrap.argv).toEqual([bootstrap.execPath, runner, "--", ...target])
    expect(evidence(result.stdout, "__RUNNER__")).toEqual({
      selection: "linux-locator",
      argv: bootstrap.argv,
      markerAtImport: null,
      markerAtCall: null,
      main: false,
    })
  })

  test("dispatches the runner before interpreting PTC markers in target arguments", () => {
    const target = ["target", "--ellamaka-dsh-ptc-child", "invalid-ptc-path", "bad-cap"]
    const result = run([runner, "--", ...target], "windows", { DSH_PTC_RUNTIME_NODE: "1" })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(23)
    expect(evidence(result.stdout, "__BOOTSTRAP__")).toMatchObject({ handled: true, ptcMarker: "1" })
    expect(evidence(result.stdout, "__RUNNER__").argv.slice(2)).toEqual(["--", ...target])
  })

  test.each([
    ["missing runner", () => []],
    ["relative runner", () => [relative(process.cwd(), runner), "--", "target"]],
    ["different package", () => [runner.replace("dsh-subprocess-local", "dsh-subprocess-other"), "--", "target"]],
    ["different scope", () => [runner.replace("@deepseek-ai", "@other"), "--", "target"]],
    ["different entry", () => [runner.replace("runner.js", "index.js"), "--", "target"]],
    ["entry suffix", () => [runner + ".bak", "--", "target"]],
    ["runner in a later position", () => ["serve", runner, "--", "target"]],
    ["missing delimiter", () => [runner, "target"]],
    ["wrong delimiter", () => [runner, "-", "target"]],
    ["delimiter in a later position", () => [runner, "unexpected", "--", "target"]],
    ["missing target", () => [runner, "--"]],
  ] as const)("rejects %s instead of falling through to product startup", (_name, args) => {
    const result = run(args(), "windows")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("invalid Bun subprocess runner invocation")
    expect(result.stdout).toBe("")
  })

  test("source Bun does not enter the compiled runner role", () => {
    const result = run([runner, "--", "target"], "windows", {}, true)
    expect(result.status).toBe(0)
    expect(evidence(result.stdout, "__BOOTSTRAP__")).toMatchObject({ handled: false, selection: "windows" })
    expect(result.stdout).not.toContain("__RUNNER__")
  })

  test("delegates to the installed official runner and preserves its missing-IPC failure status", () => {
    const result = run([officialRunner, "--", "target"], "windows")
    expect(result.stderr).toBe("")
    expect(result.status).toBe(127)
    expect(evidence(result.stdout, "__BOOTSTRAP__")).toMatchObject({ handled: true, selection: null })
  })

  test("preserves official launch-request validation before any native execution", () => {
    const root = mkdtempSync(join(tmpdir(), "ellamaka-invalid-launch-"))
    const request = join(root, "launch-request.json")
    writeFileSync(request, "{}", { mode: 0o600 })
    const result = run([officialRunner, "--", "must-not-execute"], request)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(127)
    expect(evidence(result.stdout, "__BOOTSTRAP__")).toMatchObject({ handled: true, selection: null })
    expect(existsSync(request)).toBe(false)
    expect(JSON.parse(readFileSync(join(root, "startup-error.json"), "utf8"))).toEqual({
      type: "error",
      error: { name: "Error", message: "subprocess runner received an invalid Linux launch request" },
    })
  })
})
