import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DshInitCommand, runDshInit } from "@/cli/cmd/dsh-init"

const dirs: string[] = []

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-init-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("dsh init CLI command definition", () => {
  test("command configuration matches contract (dsh-group subcommand)", () => {
    // A relative command name: the parent `dsh` group (src/index.ts) prefixes
    // it, so `ellamaka dsh init` is the full invocation.
    expect(String(DshInitCommand.command)).toBe("init")
    expect(DshInitCommand.describe).toContain("materialise")
    expect(DshInitCommand.describe).toContain("closure")
  })
})

describe("runDshInit", () => {
  test("returns disabled with zero filesystem access when dsh is switched off", async () => {
    const home = tmpHome()
    // The gate short-circuits before any logger construction or file write, so
    // even the log file must not be created under an ELLAMAKA_DSH=0 home.
    expect(existsSync(join(home, "logs"))).toBe(false)
    const status = await runDshInit({
      wopalHome: home,
      logFile: join(home, "logs", "dsh-plugins.log"),
      env: { ELLAMAKA_DSH: "0" },
    })
    expect(status).toBe("disabled")
    expect(existsSync(join(home, "logs"))).toBe(false)
    expect(existsSync(join(home, "dsh"))).toBe(false)
  })
})
