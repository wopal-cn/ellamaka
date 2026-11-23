import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// Tests for scripts/lib/warn-report.awk. The filter runs in a bash subprocess
// over a fixture written to a scoped temp dir, so the assertions pin the
// output contract build.sh relies on: progress lines never reach the report,
// and real diagnostics do.

const REPO_ROOT = join(import.meta.dir, "../..")
const FILTER = join(import.meta.dir, "warn-report.awk")

async function runFilter(input: string, extraArgs: string[] = []): Promise<string[]> {
  const dir = await Bun.$`mktemp -d`.text()
  const path = join(dir.trim(), "input.log")
  try {
    await Bun.write(path, input)
    const proc = Bun.spawnSync(["awk", "-v", `root=${REPO_ROOT}/`, ...extraArgs, "-f", FILTER, path])
    if (proc.exitCode !== 0) {
      throw new Error(`awk failed: ${proc.stderr.toString().trim()}`)
    }
    // Only drop the trailing empty element after awk's final newline. Earlier
    // blanks are the filter's business: trimming them here would let a broken
    // blank-line rule pass unnoticed.
    const lines = proc.stdout.toString().split("\n")
    if (lines.at(-1) === "") lines.pop()
    return lines
  } finally {
    await Bun.$`rm -rf ${dir.trim()}`.quiet()
  }
}

describe("warn-report.awk — vite stderr", () => {
  test("drops the bun command banner, blank lines, and code frames", async () => {
    const lines = await runFilter(
      [
        "$ electron-vite build --logLevel warn",
        "",
        "1593 |  ",
        "1594 |  /**",
        "     |  ^",
        "     |",
        "  |  keep me",
      ].join("\n"),
    )
    expect(lines).toEqual([])
  })

  test("a blank line between diagnostics never reaches the report", async () => {
    const output = await Bun.$`printf 'first warning\n\n\nsecond warning\n' | awk -f ${FILTER} /dev/stdin`.text()
    expect(output).toBe("first warning\nsecond warning\n")
  })

  test("keeps every real diagnostic line", async () => {
    const lines = await runFilter(
      ["src/index.ts (12:3): Use of eval is discouraged.", '<script src="./x.js"> can\'t be bundled'].join("\n"),
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("Use of eval")
    expect(lines[1]).toContain("can't be bundled")
  })

  test("reports each occurrence instead of collapsing it", async () => {
    const input = ["a", "b", "c"]
      .map((name) => `(!) src/i18n/${name}.ts is dynamically imported by x.ts but also statically imported`)
      .join("\n")
    const lines = await runFilter(input)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("src/i18n/a.ts")
    expect(lines[2]).toContain("src/i18n/c.ts")
  })

  test("strips the project root so paths stay relative", async () => {
    const [line] = await runFilter(`${REPO_ROOT}/packages/app/src/x.ts: something`)
    expect(line).not.toContain(REPO_ROOT)
    expect(line).toContain("packages/app/src/x.ts")
  })
})

describe("warn-report.awk — electron-builder stdout (colored)", () => {
  const color = (code: number, text: string) => `\u001b[${code}m${text}\u001b[39m`

  test("keeps warn and error lines, drops progress lines", async () => {
    const input = [
      `  ${color(34, "•")} packaging       platform=darwin`,
      `  ${color(33, "•")} file source doesn't exist  from=native`,
      `  ${color(31, "⨯")} build failed`,
    ].join("\n")
    const lines = await runFilter(input, ["-v", "colored=1"])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("file source doesn't exist")
    expect(lines[1]).toContain("build failed")
  })

  test("strips colour codes from the reported text", async () => {
    const [line] = await runFilter(`  ${color(33, "•")} warning text`, ["-v", "colored=1"])
    expect(line).not.toContain("\u001b[")
    expect(line).toBe("  • warning text")
  })
})
