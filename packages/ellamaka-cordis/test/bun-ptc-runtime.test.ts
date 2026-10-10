import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { isCompiledBunMain } from "../src/runtime/bun-ptc"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, "fixtures", "bun-ptc-runtime-probe.ts")
const anchor = createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json")

function readProbe(stdout: string) {
  const line = stdout.split("\n").find((entry) => entry.startsWith("__PTC_PROBE__"))
  if (!line) throw new Error(`PTC probe did not emit evidence:\n${stdout}`)
  return JSON.parse(line.slice("__PTC_PROBE__".length))
}

function expectProbe(evidence: any) {
  expect(evidence.language).toBe("typescript")
  expect(evidence.isolation).toBe("process")
  expect(evidence.typed.error).toBeUndefined()
  expect(evidence.typed.value).toEqual({ answer: 42 })
  expect(evidence.staticImport.error).toMatchObject({
    kind: "exception",
    message: expect.stringContaining("'import', and 'export' cannot be used outside of module code"),
  })
  expect(evidence.allowed.error).toBeUndefined()
  expect(evidence.allowed.value).toEqual({ wrote: true })
  expect(evidence.allowed.sandbox).toMatchObject({ mode: "workspace-write", denied: false })
  if (process.platform === "darwin") expect(evidence.allowed.sandbox.enforcement).toBe("full")
  expect(evidence.allowedExists).toBe(true)
  expect(evidence.denied.error?.kind).toBe("exception")
  expect(evidence.denied.sandbox).toMatchObject({ mode: "read-only", denied: true })
  expect(evidence.deniedExists).toBe(false)
  expect(evidence.stress).toHaveLength(8)
  for (const [i, result] of evidence.stress.entries()) {
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ value: i })
  }
  expect(evidence.aborted.error?.kind).toBe("abort")
}

function run(executable: string, args: string[] = []) {
  return spawnSync(executable, args, {
    cwd: join(here, "../../.."),
    env: { ...process.env, ELLAMAKA_PTC_TEST_ANCHOR: anchor },
    encoding: "utf8",
    timeout: 60_000,
  })
}

describe("Bun PTC compatibility", () => {
  test("recognizes compiled Bun virtual entry paths", () => {
    expect(isCompiledBunMain("/$bunfs/root/ellamaka")).toBe(true)
    expect(isCompiledBunMain("B:/~BUN/root/ellamaka.exe")).toBe(true)
    expect(isCompiledBunMain("/repo/packages/opencode/src/index.ts")).toBe(false)
  })

  test("source Bun preserves TypeScript, sandbox and cancellation semantics", () => {
    const result = run(process.execPath, [fixture])
    expect(result.status).toBe(0)
    if (result.status !== 0) throw new Error(result.stderr)
    expectProbe(readProbe(result.stdout))
  }, 60_000)

  test("compiled Bun re-enters the same executable as the private PTC child", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ellamaka-bun-ptc-build-")), "ptc-probe")
    const build = await Bun.build({
      entrypoints: [fixture],
      format: "esm",
      target: "bun",
      compile: {
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: true,
        autoloadPackageJson: true,
        outfile: out,
      },
    })
    expect(build.success).toBe(true)
    if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"))

    const result = run(out)
    expect(result.status).toBe(0)
    if (result.status !== 0) throw new Error(result.stderr)
    expectProbe(readProbe(result.stdout))
  }, 60_000)
})
