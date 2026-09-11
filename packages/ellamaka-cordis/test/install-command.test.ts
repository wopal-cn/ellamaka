import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveInstallCommand, type InstallCommandProbe } from "../src/plugins/install-command"

/**
 * The install-command contract shared by every host that mounts the dsh web
 * profile (CLI `serve`/`web`, the Desktop sidecar, and any library mount).
 *
 * The market re-launches `<command> dsh plugin --profile <name> …` for every
 * install/remove/update, so a wrong prefix arg does not fail loudly at the
 * mount — it fails later, inside the spawned child, as a yargs usage dump the
 * market reports as "install failed". These tests pin the ONE resolution that
 * every runtime mode must agree on (2026-09-10: the compiled binary advertised
 * `process.versions.bun`, so the old runtime-feature probe mistook it for a
 * bun source launch and forwarded Bun's `/$bunfs/root/<name>` virtual entry
 * path as a prefix arg — every market install then died in argument parsing).
 */
describe("resolveInstallCommand", () => {
  /** A probe with the defaults of a real process, overridable per case. */
  const probe = (overrides: Partial<InstallCommandProbe> = {}): InstallCommandProbe => ({
    argv: ["/usr/local/bin/ellamaka", "serve", "--port", "8888"],
    execPath: "/usr/local/bin/ellamaka",
    isBun: false,
    env: {},
    ...overrides,
  })

  test("compiled binary (bunfs argv entry) yields the executable alone", () => {
    // Measured shape of a `bun build --compile` product: argv[1] is Bun's
    // virtual bundle path, NOT a file on disk and NOT the CLI entry.
    const result = resolveInstallCommand(
      probe({
        argv: ["bun", "/$bunfs/root/ellamaka", "serve", "--port", "8888"],
        execPath: "/Users/sam/.wopal/bin/ellamaka",
        isBun: true,
      }),
    )
    expect(result).toEqual(["/Users/sam/.wopal/bin/ellamaka"])
  })

  test("compiled binary on Windows (B:/~BUN/root/ argv entry) is recognised too", () => {
    const result = resolveInstallCommand(
      probe({
        argv: ["bun", "B:/~BUN/root/ellamaka.exe", "serve"],
        execPath: "C:\\wopal\\bin\\ellamaka.exe",
        isBun: true,
      }),
    )
    expect(result).toEqual(["C:\\wopal\\bin\\ellamaka.exe"])
  })

  test("bun source launch keeps the entry as a prefix arg", () => {
    const result = resolveInstallCommand(
      probe({
        argv: ["/Users/sam/.bun/bin/bun", "/repo/packages/opencode/src/index.ts", "serve"],
        execPath: "/Users/sam/.bun/bin/bun",
        isBun: true,
      }),
    )
    expect(result).toEqual(["/Users/sam/.bun/bin/bun", "/repo/packages/opencode/src/index.ts"])
  })

  test("node host (Desktop sidecar) yields the executable alone", () => {
    const result = resolveInstallCommand(
      probe({
        argv: ["node", "/app/out/main/sidecar.js"],
        execPath: "/Applications/Ellamaka.app/Contents/MacOS/Ellamaka",
        isBun: false,
      }),
    )
    expect(result).toEqual(["/Applications/Ellamaka.app/Contents/MacOS/Ellamaka"])
  })

  test("explicit ELLAMAKA_DSH_INSTALL_COMMAND wins over every probe", () => {
    const result = resolveInstallCommand(
      probe({
        argv: ["bun", "/$bunfs/root/ellamaka", "serve"],
        execPath: "/compiled/ellamaka",
        isBun: true,
        env: { ELLAMAKA_DSH_INSTALL_COMMAND: "bun /repo/packages/opencode/src/index.ts" },
      }),
    )
    expect(result).toEqual(["bun", "/repo/packages/opencode/src/index.ts"])
  })

  test("a blank override falls through to the probe instead of yielding an empty command", () => {
    const result = resolveInstallCommand(
      probe({
        argv: ["bun", "/$bunfs/root/ellamaka"],
        execPath: "/compiled/ellamaka",
        isBun: true,
        env: { ELLAMAKA_DSH_INSTALL_COMMAND: "   " },
      }),
    )
    expect(result).toEqual(["/compiled/ellamaka"])
  })

  test("an override with surrounding whitespace is split on runs of whitespace", () => {
    const result = resolveInstallCommand(
      probe({ env: { ELLAMAKA_DSH_INSTALL_COMMAND: "  bun   /entry.ts  " } }),
    )
    expect(result).toEqual(["bun", "/entry.ts"])
  })

  test("falls back to the engine binary when the compiled host is not the CLI", () => {
    // Desktop's utility process: execPath is Electron's helper, argv[1] is the
    // sidecar bundle. Neither can run `dsh plugin`, so a legacy install under
    // WOPAL_HOME/bin is the only usable launcher.
    const home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const binDir = join(home, "bin")
    mkdirSync(binDir, { recursive: true })
    const engine = join(binDir, process.platform === "win32" ? "ellamaka.exe" : "ellamaka")
    writeFileSync(engine, "#!/bin/sh\n", "utf-8")

    const result = resolveInstallCommand(
      probe({
        argv: ["node", "/app/out/main/sidecar.js"],
        execPath: "/Applications/Ellamaka.app/Contents/MacOS/Ellamaka",
        isBun: false,
        env: { WOPAL_HOME: home },
        allowEngineFallback: true,
      }),
    )
    expect(result).toEqual([engine])
  })

  test("returns undefined when no launcher can be resolved", () => {
    const result = resolveInstallCommand(
      probe({
        argv: ["node", "/app/out/main/sidecar.js"],
        execPath: "/Applications/Ellamaka.app/Contents/MacOS/Ellamaka",
        isBun: false,
        env: { WOPAL_HOME: join(tmpdir(), "ellamaka-missing-home-xyz") },
        allowEngineFallback: true,
      }),
    )
    expect(result).toBeUndefined()
  })

  test("a fallback host ignores its own runtime argv entirely", () => {
    // The Desktop sidecar is a Node host in production, but its tests (and any
    // bundler-driven evaluation) run under bun, whose argv describes the
    // RUNNER — not the CLI to re-launch. Resolving from that argv would emit
    // `[bun, <the caller's file>]`, which is never a launcher. A host that set
    // allowEngineFallback has already declared its argv unusable, so it must
    // reach the engine binary regardless of which runtime executes it.
    const home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const binDir = join(home, "bin")
    mkdirSync(binDir, { recursive: true })
    const engine = join(binDir, process.platform === "win32" ? "ellamaka.exe" : "ellamaka")
    writeFileSync(engine, "#!/bin/sh\n", "utf-8")

    const result = resolveInstallCommand(
      probe({
        argv: ["/Users/sam/.bun/bin/bun", "/repo/packages/ellamaka-desktop/src/main/sidecar.ts"],
        execPath: "/Users/sam/.bun/bin/bun",
        isBun: true,
        env: { WOPAL_HOME: home },
        allowEngineFallback: true,
      }),
    )
    expect(result).toEqual([engine])
  })

  test("a host that refuses the engine fallback never inspects the filesystem", () => {
    // The CLI host must answer from its own process alone: a stale
    // WOPAL_HOME/bin/ellamaka from an older install would otherwise win over
    // the binary that is actually running.
    const home = mkdtempSync(join(tmpdir(), "ellamaka-install-cmd-"))
    const binDir = join(home, "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, "ellamaka"), "#!/bin/sh\n", "utf-8")

    const result = resolveInstallCommand(
      probe({
        argv: ["bun", "/$bunfs/root/ellamaka"],
        execPath: "/running/ellamaka",
        isBun: true,
        env: { WOPAL_HOME: home },
        allowEngineFallback: false,
      }),
    )
    expect(result).toEqual(["/running/ellamaka"])
  })

  test("never emits a bunfs virtual path as a prefix arg in any mode", () => {
    const modes: InstallCommandProbe[] = [
      probe({ argv: ["bun", "/$bunfs/root/ellamaka", "serve"], isBun: true }),
      probe({ argv: ["bun", "B:/~BUN/root/ellamaka.exe", "serve"], isBun: true }),
      probe({ argv: ["bun", "/$bunfs/root/ellamaka", "serve"], isBun: true, env: { ELLAMAKA_DSH_INSTALL_COMMAND: "bun /x.ts" } }),
    ]
    for (const mode of modes) {
      const resolved = resolveInstallCommand(mode)
      expect(resolved).toBeDefined()
      for (const part of resolved!) expect(part).not.toContain("$bunfs")
    }
  })
})
