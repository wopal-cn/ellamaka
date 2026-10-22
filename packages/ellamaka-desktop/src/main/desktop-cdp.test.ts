import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Regression lock for the Desktop CDP port wiring. The root cause of the
// 9222 collision was that three places disagreed: the free-port precheck, the
// environment handed to Electron, and the listener ledger. These tests pin the
// single resolver plus the call sites that must use it, without launching a
// GUI.

const REPO_ROOT = join(import.meta.dir, "../../../..")

function resolvePort(explicit: string, env: Record<string, string> = {}): string {
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")
  const script = `
    set -euo pipefail
    ${exports}
    source "${REPO_ROOT}/scripts/lib/desktop-cdp.sh"
    desktop_cdp_resolve_port "${explicit}"
  `
  const proc = Bun.spawnSync(["bash", "-c", script], { env: { ...process.env, REPO_ROOT } })
  if (proc.exitCode !== 0) throw new Error(`resolver failed: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

describe("desktop_cdp_resolve_port", () => {
  test("defaults to 9222", () => {
    expect(resolvePort("")).toBe("9222")
  })

  test("honours ELLAMAKA_DESKTOP_CDP_PORT", () => {
    expect(resolvePort("", { ELLAMAKA_DESKTOP_CDP_PORT: "9333" })).toBe("9333")
  })

  test("explicit --cdp-debug port wins over the environment", () => {
    expect(resolvePort("9444", { ELLAMAKA_DESKTOP_CDP_PORT: "9333" })).toBe("9444")
  })

  test("a non-numeric value is ignored rather than passed through", () => {
    expect(resolvePort("", { ELLAMAKA_DESKTOP_CDP_PORT: "abc" })).toBe("9222")
  })

  test("the env pair handed to Electron carries the resolved port", () => {
    const script = `
      set -euo pipefail
      REPO_ROOT="${REPO_ROOT}"
      source "${REPO_ROOT}/scripts/lib/desktop-cdp.sh"
      desktop_cdp_env_flags 9333
    `
    const proc = Bun.spawnSync(["bash", "-c", script], { env: { ...process.env, REPO_ROOT } })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toBe("ELLAMAKA_DESKTOP_CDP=1\nELLAMAKA_DESKTOP_CDP_PORT=9333\n")
  })
})

type DesktopPlan = { freePorts: string[]; env: string[]; ledger: string }

/**
 * Run the real `cmd_desktop` argument parsing and port planning with the
 * dry-run seam, so the assertions observe the values the launch path would
 * hand to require_free_ports, Electron, and the ledger — not the shape of the
 * source text.
 */
function planDesktop(args: string[], env: Record<string, string> = {}): DesktopPlan {
  const script = `
    set -euo pipefail
    WOPAL_DEV_PLAN_ONLY=1
    source ./scripts/dev.sh
    cmd_desktop "$@"
  `
  const proc = Bun.spawnSync(["bash", "-c", script, "scripts/dev.sh", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  })
  if (proc.exitCode !== 0) throw new Error(`desktop plan failed: ${proc.stderr.toString()}`)
  const lines = proc.stdout.toString().trim().split("\n")
  const read = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? ""
  return {
    freePorts: read("free_ports=").split(" ").filter(Boolean),
    env: lines.filter((line) => line.startsWith("env=")).map((line) => line.slice("env=".length)),
    ledger: read("ledger="),
  }
}

describe("dev.sh plans the port it will actually use", () => {
  const desktopIndex = readFileSync(join(REPO_ROOT, "packages/ellamaka-desktop/src/main/index.ts"), "utf8")

  test("a custom --cdp-debug port reaches the check, the env, and the ledger", () => {
    const plan = planDesktop(["--cdp-debug", "9333"])
    expect(plan.freePorts).toEqual(["5173", "9333"])
    expect(plan.env).toEqual(["ELLAMAKA_DESKTOP_CDP=1", "ELLAMAKA_DESKTOP_CDP_PORT=9333"])
    expect(plan.ledger).toBe("9333")
  })

  test("--cdp-debug without a port falls back to 9222 everywhere", () => {
    const plan = planDesktop(["--cdp-debug"])
    expect(plan.freePorts).toEqual(["5173", "9222"])
    expect(plan.env).toContain("ELLAMAKA_DESKTOP_CDP_PORT=9222")
    expect(plan.ledger).toBe("9222")
  })

  test("ELLAMAKA_DESKTOP_CDP_PORT is used when no port argument is given", () => {
    const plan = planDesktop(["--cdp-debug"], { ELLAMAKA_DESKTOP_CDP_PORT: "9444" })
    expect(plan.freePorts).toEqual(["5173", "9444"])
    expect(plan.ledger).toBe("9444")
  })

  test("without --cdp-debug only 5173 is reserved and no ledger entry is made", () => {
    const plan = planDesktop([])
    expect(plan.freePorts).toEqual(["5173"])
    expect(plan.env).toEqual([])
    expect(plan.ledger).toBe("-")
  })

  test("Electron reads the port from the environment", () => {
    expect(desktopIndex).toContain('app.commandLine.appendSwitch("remote-debugging-port"')
    expect(desktopIndex).toContain('process.env.ELLAMAKA_DESKTOP_CDP_PORT ?? "9222"')
  })
})
