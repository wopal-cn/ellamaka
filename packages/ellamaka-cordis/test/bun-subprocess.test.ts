import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  rewriteSubprocessScopeArgs,
  rewriteSubprocessStdioFlags,
  rewriteSubprocessUtilImport,
} from "../src/runtime/bun-subprocess"

const OFFICIAL =
  'import { getSystemErrorMessage, getSystemErrorName, inspect } from "node:util";\n' +
  "const detail = getSystemErrorMessage(uvError);"

describe("Bun subprocess compatibility", () => {
  test("normalizes stdio at the exact native execve boundary and rejects drift", () => {
    const seam =
      "\t\tnativeExecve(file, [...argv, null], [...Object.entries(env).map(([key, value]) => `${key}=${value}`), null]);"
    const rewritten = rewriteSubprocessStdioFlags(seam)
    expect(rewritten).toContain("for (const fd of STANDARD_FILE_DESCRIPTORS)")
    expect(rewritten).toContain("flags & ~2048")
    expect(rewritten.endsWith(seam)).toBe(true)
    expect(() => rewriteSubprocessStdioFlags("changed upstream")).toThrow("stdio seam changed")
    expect(() => rewriteSubprocessStdioFlags(seam + "\n" + seam)).toThrow("stdio seam changed")
  })
  test("replaces the Node-only named import with an equivalent local helper", () => {
    const rewritten = rewriteSubprocessUtilImport(OFFICIAL)
    expect(rewritten).toContain('import { getSystemErrorName, inspect } from "node:util";')
    expect(rewritten).toContain("const getSystemErrorMessage = (code) => getSystemErrorName(code);")
    expect(rewritten).toContain("const detail = getSystemErrorMessage(uvError);")
    expect(rewritten).not.toContain("import { getSystemErrorMessage")
  })

  test("fails loudly when the upstream import seam changes", () => {
    expect(() => rewriteSubprocessUtilImport('import { inspect } from "node:util";')).toThrow("util import changed")
    expect(() =>
      rewriteSubprocessUtilImport(
        'import { getSystemErrorMessage, getSystemErrorName, inspect } from "node:util";\n' +
          'import { getSystemErrorMessage, getSystemErrorName, inspect } from "node:util";',
      ),
    ).toThrow("util import changed")
  })
})

const fixture = fileURLToPath(new URL("./fixtures/bun-subprocess-argv-probe.ts", import.meta.url))
const provider = import.meta.resolve("@deepseek-ai/dsh-subprocess-local")
const targetArgv = ["target executable", "--flag", "", "--", "argument with spaces", "中文"]

function expectRunnerArgs(executable: string, args: string[]) {
  const result = spawnSync(executable, args, {
    env: { ...process.env, ELLAMAKA_SUBPROCESS_TEST_PROVIDER: fileURLToPath(provider) },
    encoding: "utf8",
    timeout: 10_000,
  })
  if (result.status !== 0)
    throw new Error(
      `runner probe failed: status=${result.status} signal=${result.signal} ${result.error ?? ""}\n${result.stderr}`,
    )
  expect(result.status).toBe(0)
  const evidence = JSON.parse(result.stdout)
  expect(evidence.argv).toEqual(["--", ...targetArgv])
  expect(evidence.status).toBe(127)
  expect(evidence.error.error.message).toContain("invalid Linux launch request")
  expect(evidence.requestExists).toBe(false)
}

describe("Bun private runner arguments", () => {
  test("source Bun preserves the private delimiter and every target argument", () => {
    expectRunnerArgs(process.execPath, [fixture, ...targetArgv])
  })

  test("compiled Bun preserves exactly one private delimiter", async () => {
    const outfile = join(mkdtempSync(join(tmpdir(), "ellamaka-runner-argv-")), "probe")
    const result = await Bun.build({
      entrypoints: [fixture],
      target: "bun",
      compile: {
        outfile,
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: true,
        autoloadPackageJson: true,
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.logs.map((entry) => entry.message).join("\n"))
    expectRunnerArgs(outfile, targetArgv)
  })

  test("rejects absent or ambiguous upstream scope argument seams", () => {
    expect(() => rewriteSubprocessScopeArgs("function scopeArgs() {} ")).toThrow("scope argv changed")
    const seam = '\t\t...invocation,\n\t\t"--",\n\t\t...argv'
    expect(() => rewriteSubprocessScopeArgs(seam + "\n" + seam)).toThrow("scope argv changed")
  })
})
