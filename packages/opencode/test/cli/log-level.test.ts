import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { resolveLogLevel, resolveTrace } from "@/cli/log-level"
import { cleanupProbes, makeProbe, probeEnv, runCli } from "../lib/log-probe"

/**
 * The engine entry resolves one effective level (DESIGN-config-settings.md
 * "Logging Level"): `--log-level` > `--trace` promotion > `ELLAMAKA_LOG_LEVEL`
 * > `wopal.logging.level` > INFO. There is no implicit dev promotion — the dev
 * toolchain asks for DEBUG explicitly.
 */
describe("engine level resolution", () => {
  const dirs: string[] = []

  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function settings(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-level-"))
    dirs.push(dir)
    const file = join(dir, "settings.jsonc")
    writeFileSync(file, content)
    return file
  }

  const missingConfig = () => join("/nonexistent-ellamaka", "settings.jsonc")

  test("explicit --log-level wins over env, config and trace", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "DEBUG" } } }`)
    expect(resolveLogLevel({ requested: "ERROR", trace: "bus", env: { ELLAMAKA_LOG_LEVEL: "WARN" }, configFile })).toBe(
      "ERROR",
    )
  })

  test("env wins over config", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "DEBUG" } } }`)
    expect(resolveLogLevel({ env: { ELLAMAKA_LOG_LEVEL: "WARN" }, configFile })).toBe("WARN")
  })

  test("config applies when no env is set", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "DEBUG" } } }`)
    expect(resolveLogLevel({ env: {}, configFile })).toBe("DEBUG")
  })

  test("defaults to INFO without env and config", () => {
    expect(resolveLogLevel({ env: {}, configFile: missingConfig() })).toBe("INFO")
  })

  test("a trace selector promotes the level unless an explicit level is given", () => {
    expect(resolveLogLevel({ trace: "bus", env: {}, configFile: missingConfig() })).toBe("TRACE")
    expect(resolveLogLevel({ trace: "bus", requested: "INFO", env: {}, configFile: missingConfig() })).toBe("INFO")
  })

  test("invalid values fall back to INFO without blocking", () => {
    expect(resolveLogLevel({ env: { ELLAMAKA_LOG_LEVEL: "nonsense" }, configFile: missingConfig() })).toBe("INFO")
    const invalidConfig = settings(`{ "wopal": { "logging": { "level": "verbose" } } }`)
    expect(resolveLogLevel({ env: {}, configFile: invalidConfig })).toBe("INFO")
  })
})

/**
 * `--trace permission,bus` is the operator escape hatch for the bounded
 * diagnostics removed from normal operation. It promotes the effective level
 * to TRACE so the selected categories actually emit, but an explicit
 * `--log-level` always wins: a caller who asked for INFO must not be silently
 * upgraded to TRACE by a leftover trace selector.
 */
describe("trace selector resolution", () => {
  test("promotes the effective level to TRACE when a selector is present", () => {
    expect(resolveLogLevel({ trace: "permission,bus", env: {}, configFile: "/nonexistent/settings.jsonc" })).toBe(
      "TRACE",
    )
    expect(resolveLogLevel({ trace: "bus", env: {}, configFile: "/nonexistent/settings.jsonc" })).toBe("TRACE")
  })

  test("leaves the resolved level untouched when no selector is present", () => {
    expect(resolveLogLevel({ env: {}, configFile: "/nonexistent/settings.jsonc" })).toBe("INFO")
    expect(resolveLogLevel({ trace: "", env: {}, configFile: "/nonexistent/settings.jsonc" })).toBe("INFO")
  })

  test("lets an explicit requested level win over trace promotion", () => {
    expect(resolveLogLevel({ requested: "INFO", trace: "permission" })).toBe("INFO")
    expect(resolveLogLevel({ requested: "DEBUG", trace: "bus" })).toBe("DEBUG")
    expect(resolveLogLevel({ requested: "TRACE", trace: "bus" })).toBe("TRACE")
  })

  test("accepts TRACE as an explicit requested level", () => {
    expect(resolveLogLevel({ requested: "TRACE" })).toBe("TRACE")
  })
})

/**
 * TRACE must name its categories. The level alone is a configuration error,
 * not an implicit "everything": that default is what flooded the operator log.
 * `--trace` with no value is the discovery path, so the caller can learn the
 * available categories without reading the source.
 */
describe("forced trace selection", () => {
  test("rejects a bare TRACE level with no selector", () => {
    const result = resolveTrace({ requested: "TRACE" })
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.message).toContain("--trace")
      // The error must teach the caller which categories exist.
      for (const category of ["bus", "permission", "session", "llm", "plugin", "io"]) {
        expect(result.message).toContain(category)
      }
    }
  })

  test("treats a value-less --trace as a discovery request", () => {
    expect(resolveTrace({ trace: true }).kind).toBe("list")
  })

  test("rejects a selector with no known category", () => {
    const result = resolveTrace({ trace: "not-a-category" })
    expect(result.kind).toBe("error")
    if (result.kind === "error") expect(result.message).toContain("not-a-category")
  })

  test("accepts a selector that names known categories", () => {
    const result = resolveTrace({ trace: "bus,permission" })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.level).toBe("TRACE")
      expect(result.categories).toBe("bus,permission")
    }
  })

  test("accepts an explicit all selector", () => {
    const result = resolveTrace({ trace: "all" })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.categories).toBe("all")
  })

  test("does not require a selector when trace is not used", () => {
    expect(resolveTrace({ requested: "INFO" }).kind).toBe("ok")
    expect(resolveTrace({}).kind).toBe("ok")
  })
})

/**
 * The env-name contract of the unified mechanism: the only level variable is
 * `ELLAMAKA_LOG_LEVEL`, and the Desktop variables use the double-L prefix that
 * the onboarding reader already expects. A source scan keeps a future caller
 * from reintroducing an upstream name or a second desktop prefix.
 */
describe("unified level env contract", () => {
  const root = resolve(import.meta.dir, "../../../..")
  const files = [
    ...new Bun.Glob("packages/*/src/**/*.ts").scanSync({ cwd: root }),
    ...new Bun.Glob("packages/*/*/src/**/*.ts").scanSync({ cwd: root }),
  ]

  test("no legacy level variables remain in package sources", () => {
    const forbidden = ["OPENCODE_LOG_LEVEL", "OPENCODE_TRACE", "ELAMAKA_DESKTOP_LOG_LEVEL", "ELAMAKA_DESKTOP_"]
    const hits: string[] = []
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8")
      for (const token of forbidden) {
        if (text.includes(token)) hits.push(`${file}: ${token}`)
      }
    }
    expect(hits).toEqual([])
  })

  test("desktop main and onboarding share the double-L desktop prefix", () => {
    const sidecar = readFileSync(join(root, "packages/ellamaka-desktop/src/main/sidecar.ts"), "utf8")
    const onboarding = readFileSync(join(root, "packages/ellamaka-onboarding/src/machine-runner.ts"), "utf8")
    const desktopIndex = readFileSync(join(root, "packages/ellamaka-desktop/src/main/index.ts"), "utf8")
    expect(sidecar).toContain("ELLAMAKA_DESKTOP_DEV")
    expect(onboarding).toContain("ELLAMAKA_DESKTOP_DEV")
    expect(desktopIndex).toContain("ELLAMAKA_DESKTOP_CDP")
  })
})

/** True when any written record carries the given level prefix. */
function hasLevel(text: string, level: string): boolean {
  return text.split("\n").some((line) => line.startsWith(level))
}

/**
 * Real-entry probes: the resolved level is observable in what the process
 * actually writes. `debug config` emits INFO records (instance bootstrap) and a
 * WARN record (space without settings), so each source is provable by which
 * records appear.
 */
describe("engine entry level probe", () => {
  afterAll(cleanupProbes)

  function runDebugConfig(extraEnv: Record<string, string> = {}, settings?: string) {
    const { root, home } = makeProbe()
    if (settings !== undefined) {
      const settingsPath = join(home, "config", "settings.jsonc")
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, settings)
    }
    const result = runCli(["debug", "config"], { cwd: root, env: probeEnv(home, extraEnv) })
    const logFile = join(root, ".wopal-space", "logs", "ellamaka-dev-tui.log")
    const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : ""
    return { result, text, logFile }
  }

  test("ELLAMAKA_LOG_LEVEL bounds the records the entry writes", () => {
    const { result, text, logFile } = runDebugConfig({ ELLAMAKA_LOG_LEVEL: "WARN" })
    expect(result.exitCode).toBe(0)
    expect(existsSync(logFile)).toBe(true)
    expect(hasLevel(text, "INFO")).toBe(false)
    expect(hasLevel(text, "WARN")).toBe(true)
  })

  test("an explicit --log-level overrides the environment", () => {
    const { root, home } = makeProbe()
    const result = runCli(["debug", "config", "--log-level", "DEBUG"], {
      cwd: root,
      env: probeEnv(home, { ELLAMAKA_LOG_LEVEL: "WARN" }),
    })
    expect(result.exitCode).toBe(0)
    const text = readFileSync(join(root, ".wopal-space", "logs", "ellamaka-dev-tui.log"), "utf8")
    expect(hasLevel(text, "INFO")).toBe(true)
  })

  test("wopal.logging.level applies when no environment override is set", () => {
    const { result, text } = runDebugConfig(
      {},
      // The shared user-global settings file carries the engine's `ellamaka`
      // section alongside the CLI-owned `wopal` section; the level read is a
      // raw JSONC read, independent of the engine's section parse.
      `{ "ellamaka": {}, "wopal": { "logging": { "level": "WARN" } } }`,
    )
    expect(result.exitCode).toBe(0)
    // The default level (INFO) would have emitted INFO records; the persisted
    // WARN level must suppress them.
    expect(hasLevel(text, "INFO")).toBe(false)
  })

  test("an invalid value falls back to INFO and does not block startup", () => {
    const { result, text } = runDebugConfig({ ELLAMAKA_LOG_LEVEL: "nonsense" })
    expect(result.exitCode).toBe(0)
    expect(hasLevel(text, "INFO")).toBe(true)
  })
})
