import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Exercise the real launch wiring with process and persistent-state boundaries
// stubbed: no GUI, listener, user profile, or dev registry is touched.

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
  const proc = Bun.spawnSync(["bash", "-c", script], {
    env: { ...process.env, ELLAMAKA_DESKTOP_CDP_PORT: "", REPO_ROOT },
  })
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
    const proc = Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, ELLAMAKA_DESKTOP_CDP_PORT: "", REPO_ROOT },
    })
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toBe("ELLAMAKA_DESKTOP_CDP=1\nELLAMAKA_DESKTOP_CDP_PORT=9333\n")
  })
})

type DesktopPlan = { freePorts: string[]; env: string[]; ledger: string; sidecar: string }

/** Run cmd_desktop itself; stub only OS/process and persistent-state boundaries. */
function planDesktop(args: string[], env: Record<string, string> = {}): DesktopPlan {
  const dir = mkdtempSync(join(tmpdir(), "ellamaka-cdp-wiring-"))
  writeFileSync(join(dir, "desktop.log"), "server ready\n")
  const script = `
    set -euo pipefail
    ps() { printf '123\n'; }
    source ./scripts/dev.sh
    DEV_DIR="$CDP_TEST_DIR"
    DESKTOP_LOG="$CDP_TEST_DIR/desktop.log"
    require_stopped() { :; }
    require_free_ports() { echo "free_ports=$*"; }
    choose_free_port() { SELECTED_PORT=4097; }
    sync_min_wopal_cli_version() { :; }
    start_process() {
      for arg in "$@"; do
        case "$arg" in
          ELLAMAKA_DESKTOP_CDP=*) echo "env=$arg" ;;
          ELLAMAKA_DESKTOP_CDP_PORT=*) echo "env=$arg" ;;
        esac
      done
    }
    read_record() { RECORD_PID=123; RECORD_PGID=123; }
    service_running() { return 0; }
    pgrep() { echo 456; }
    lsof() {
      printf 'node 456 user 1u IPv4 0 0 TCP 127.0.0.1:5173\n'
      printf 'node 456 user 2u IPv4 0 0 TCP 127.0.0.1:9333\n'
      printf 'node 456 user 3u IPv4 0 0 TCP 127.0.0.1:4097\n'
    }
    write_record() { echo "sidecar=$2"; }
    record_listener() {
      if [ "$1" = desktop-devtools ]; then echo "ledger=$2"; fi
      return 0
    }
    record_crashpads() { :; }
    cmd_desktop "$@"
  `
  try {
    const proc = Bun.spawnSync(["bash", "-c", script, "scripts/dev.sh", ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ELLAMAKA_DESKTOP_CDP_PORT: "",
        WOPAL_HOME: dir,
        MIN_WOPAL_CLI_VERSION: "0.0.0",
        ...env,
        CDP_TEST_DIR: dir,
      },
    })
    if (proc.exitCode !== 0) throw new Error(`desktop wiring failed: ${proc.stderr.toString()}`)
    const lines = proc.stdout.toString().trim().split("\n")
    const read = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? ""
    return {
      freePorts: read("free_ports=").split(" ").filter(Boolean),
      env: lines.filter((line) => line.startsWith("env=")).map((line) => line.slice("env=".length)),
      ledger: read("ledger=") || "-",
      sidecar: read("sidecar="),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("dev.sh wires the selected port to the real consumers", () => {
  const desktopIndex = readFileSync(join(REPO_ROOT, "packages/ellamaka-desktop/src/main/index.ts"), "utf8")

  test("a custom --cdp-debug port reaches the check, the env, and the ledger", () => {
    const plan = planDesktop(["--cdp-debug", "9333"])
    expect(plan.freePorts).toEqual(["5173", "9333"])
    expect(plan.env).toEqual(["ELLAMAKA_DESKTOP_CDP=1", "ELLAMAKA_DESKTOP_CDP_PORT=9333"])
    expect(plan.ledger).toBe("9333")
    expect(plan.sidecar).toBe("4097,5173")
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
    expect(plan.env).toContain("ELLAMAKA_DESKTOP_CDP_PORT=9444")
    expect(plan.ledger).toBe("9444")
  })

  test("an explicit port overrides the environment throughout the launch", () => {
    const plan = planDesktop(["--cdp-debug", "9333"], { ELLAMAKA_DESKTOP_CDP_PORT: "9444" })
    expect(plan.freePorts).toEqual(["5173", "9333"])
    expect(plan.env).toContain("ELLAMAKA_DESKTOP_CDP_PORT=9333")
    expect(plan.ledger).toBe("9333")
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
