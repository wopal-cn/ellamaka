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

describe("dev.sh and Electron consume the resolved port", () => {
  const dev = readFileSync(join(REPO_ROOT, "scripts/dev.sh"), "utf8")
  const desktopIndex = readFileSync(join(REPO_ROOT, "packages/ellamaka-desktop/src/main/index.ts"), "utf8")

  test("dev.sh resolves through the shared helper, not a hard-coded 9222", () => {
    expect(dev).toContain('source "$root/scripts/lib/desktop-cdp.sh"')
    expect(dev).toContain('cdp_port="$(desktop_cdp_resolve_port "$2")"')
    expect(dev).toContain('cdp_port="$(desktop_cdp_resolve_port)"')
  })

  test("free-port precheck, Electron env, and ledger use the selected port", () => {
    expect(dev).toContain('require_free_ports 5173 "$cdp_port"')
    expect(dev).toContain('desktop_cdp_env_flags "$cdp_port"')
    expect(dev).toContain('record_listener desktop-devtools "$cdp_port"')
  })

  test("sidecar port detection excludes the selected CDP port, not only 9222", () => {
    expect(dev).toContain('$cdp_debug && reserved_ports="5173|$cdp_port"')
    expect(dev).toContain('grep -vE ":($reserved_ports)$"')
  })

  test("Electron reads the port from the environment", () => {
    expect(desktopIndex).toContain('app.commandLine.appendSwitch("remote-debugging-port"')
    expect(desktopIndex).toContain('process.env.ELLAMAKA_DESKTOP_CDP_PORT ?? "9222"')
  })
})
