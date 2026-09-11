import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// sidecar.ts reads process.parentPort at module scope; bun test runs without
// an Electron utility-process parent, so stub it before the import resolves.
;(process as unknown as { parentPort: unknown }).parentPort = {
  postMessage: () => {},
  on: () => {},
}

const { resolveEllamakaInstallCommand } = await import("./sidecar")

/**
 * The dshmarket install-worker command resolution on the Desktop sidecar:
 * ELLAMAKA_DSH_INSTALL_COMMAND (dev launcher override) wins, then the
 * engine binary install.sh lays down under <WOPAL_HOME>/bin, then undefined
 * (the market keeps its CLI-spawn fallback and the web mount logs the
 * no-install-worker warning). See dsh-mount-audit.test.ts (ellamaka-cordis)
 * for the wiring gate that keeps `bootDshWeb` receiving this value.
 */
describe("resolveEllamakaInstallCommand", () => {
  let home: string
  const savedEnv: Record<string, string | undefined> = {}

  const capture = (keys: string[]) => {
    for (const key of keys) savedEnv[key] = process.env[key]
  }
  const restore = () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  afterEach(() => {
    restore()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  test("ELLAMAKA_DSH_INSTALL_COMMAND pointing at an existing file wins", async () => {
    capture(["ELLAMAKA_DSH_INSTALL_COMMAND", "WOPAL_HOME"])
    home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const bin = join(home, "engine")
    writeFileSync(bin, "#!/bin/sh\n")
    process.env.ELLAMAKA_DSH_INSTALL_COMMAND = bin
    delete process.env.WOPAL_HOME
    await expect(resolveEllamakaInstallCommand()).resolves.toEqual([bin])
  })

  test("ELLAMAKA_DSH_INSTALL_COMMAND splits 'bun <entry>' into executable + prefix args", async () => {
    capture(["ELLAMAKA_DSH_INSTALL_COMMAND", "WOPAL_HOME"])
    home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const entry = join(home, "src", "index.ts")
    process.env.ELLAMAKA_DSH_INSTALL_COMMAND = `bun ${entry}`
    // `bun` resolves through PATH when the worker calls spawn(). An explicit
    // dev command must never silently fall through to ~/.wopal/bin/ellamaka.
    await expect(resolveEllamakaInstallCommand()).resolves.toEqual(["bun", entry])
  })

  test("an explicit missing command is preserved instead of falling through to another engine", async () => {
    capture(["ELLAMAKA_DSH_INSTALL_COMMAND", "WOPAL_HOME"])
    home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const missing = join(home, "missing-binary")
    process.env.ELLAMAKA_DSH_INSTALL_COMMAND = missing
    process.env.WOPAL_HOME = home
    // The explicit command is authoritative. spawn() then returns a clear
    // ENOENT error instead of the worker silently invoking an older engine
    // whose CLI might interpret `dsh plugin …` as TUI arguments.
    await expect(resolveEllamakaInstallCommand()).resolves.toEqual([missing])
  })

  test("falls back to <WOPAL_HOME>/bin/ellamaka when no override", async () => {
    capture(["ELLAMAKA_DSH_INSTALL_COMMAND", "WOPAL_HOME"])
    home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const engine = join(home, "bin", process.platform === "win32" ? "ellamaka.exe" : "ellamaka")
    mkdirSync(join(home, "bin"), { recursive: true })
    writeFileSync(engine, "#!/bin/sh\n")
    delete process.env.ELLAMAKA_DSH_INSTALL_COMMAND
    process.env.WOPAL_HOME = home
    await expect(resolveEllamakaInstallCommand()).resolves.toEqual([engine])
  })

  test("returns undefined when neither override nor engine binary exists", async () => {
    capture(["ELLAMAKA_DSH_INSTALL_COMMAND", "WOPAL_HOME"])
    home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    delete process.env.ELLAMAKA_DSH_INSTALL_COMMAND
    process.env.WOPAL_HOME = join(home, "empty-home")
    await expect(resolveEllamakaInstallCommand()).resolves.toBeUndefined()
  })

  test("wopalHomeOverride (from the start command) wins over process.env.WOPAL_HOME", async () => {
    capture(["ELLAMAKA_DSH_INSTALL_COMMAND", "WOPAL_HOME"])
    home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const engine = join(home, "bin", process.platform === "win32" ? "ellamaka.exe" : "ellamaka")
    mkdirSync(join(home, "bin"), { recursive: true })
    writeFileSync(engine, "#!/bin/sh\n")
    delete process.env.ELLAMAKA_DSH_INSTALL_COMMAND
    // The env points somewhere WITHOUT an engine; the start-command override
    // (custom WOPAL_HOME user on a packaged desktop) must still resolve.
    process.env.WOPAL_HOME = join(home, "env-home")
    await expect(resolveEllamakaInstallCommand(home)).resolves.toEqual([engine])
  })
})
