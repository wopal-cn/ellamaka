import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import path from "path"
import os from "os"
import { Log } from "@wopal/ellamaka-core/util/log"

describe("safe log value formatting", () => {
  test("summarizes transport errors without serializing request or response bodies", () => {
    const requestPayload = "request-payload-must-never-reach-a-log"
    const responsePayload = "response-payload-must-never-reach-a-log"

    const result = Log.formatLogValue({
      name: "AI_APICallError",
      url: "https://api.example.test/v1/chat/completions?api_key=secret",
      statusCode: 429,
      isRetryable: true,
      requestBodyValues: {
        messages: [{ role: "user", content: requestPayload }],
      },
      responseBody: responsePayload,
    })

    expect(result).toContain('"name":"AI_APICallError"')
    expect(result).toContain('"statusCode":429')
    expect(result).toContain('"isRetryable":true')
    expect(result).toContain('"url":"https://api.example.test/v1/chat/completions"')
    expect(result).not.toContain(requestPayload)
    expect(result).not.toContain(responsePayload)
    expect(result).not.toContain("requestBodyValues")
    expect(result).not.toContain("responseBody")
  })

  test("bounds arbitrary serialized values", () => {
    const result = Log.formatLogValue({ output: "x".repeat(16 * 1024) })

    expect(result.length).toBeLessThanOrEqual(4096)
    expect(result).toContain("[truncated]")
  })

  test("keeps scalar values on one bounded line", () => {
    const result = Log.formatLogValue("\n".repeat(16 * 1024))

    expect(result.length).toBeLessThanOrEqual(4096)
    expect(result).not.toContain("\n")
    expect(result).toContain("[truncated]")
  })
})

/**
 * The dev-mode log directory resolution (ellamaka-core/src/util/log.ts `dir`)
 * must never throw: outside a WopalSpace (`WOPAL_DEBUG_LOG_DIR` and
 * `WOPAL_SPACE_ROOT` both unset) it falls back to the global log directory
 * (`Global.Path.log`), keeping machine commands like `ellamaka dsh` working
 * from ANY working directory (Plan 223: the official dsh alias surface).
 *
 * The module is process-global (module state), so the behavior is pinned
 * through a spawned `bun test` subprocess, the same pattern as
 * global.test.ts "$WOPAL_HOME/.env isolation".
 */
describe("dev log directory resolution", () => {
  test("outside a space, init falls back to the global log dir (no throw)", async () => {
    const probeDir = path.join(process.cwd(), ".tmp")
    await fs.mkdir(probeDir, { recursive: true })
    const probeFile = path.join(probeDir, "log-dir-fallback-probe.test.ts")
    await fs.writeFile(
      probeFile,
      [
        `import { expect, test } from "bun:test"`,
        `import { Log } from "@wopal/ellamaka-core/util/log"`,
        `test("init without space envs does not throw", async () => {`,
        `  await Log.init({ dev: true, devFile: "probe-dev.log", level: "INFO" })`,
        `})`,
      ].join("\n"),
    )
    const r = Bun.spawnSync({
      cmd: ["bun", "test", probeFile],
      cwd: import.meta.dir,
      env: {
        ...process.env,
        WOPAL_DEBUG_LOG_DIR: "",
        WOPAL_SPACE_ROOT: "",
      },
    })
    try {
      expect(r.stderr.toString()).not.toContain("requires WOPAL_DEBUG_LOG_DIR")
      expect(r.exitCode).toBe(0)
    } finally {
      await fs.rm(probeFile, { force: true })
      await fs.rm(path.join(os.homedir(), ".wopal", "logs", "probe-dev.log"), { force: true }).catch(() => {})
    }
  })
})

/**
 * TRACE is the fifth, opt-in level below DEBUG. It exists so operators can
 * widen diagnostics (event-bus publishes, permission decisions, session/LLM
 * runtime loops) without restoring the flood removed from normal operation.
 *
 * The categories are a closed registry: a caller cannot invent one, and the
 * level alone never emits anything. `--trace` must name what it wants, so an
 * accidental `--log-level TRACE` cannot open every category at once.
 */
describe("trace category registry", () => {
  test("exposes the built-in categories as a stable list", () => {
    expect(Log.traceCategories()).toEqual(["bus", "permission", "session", "llm", "plugin", "io"])
  })

  test("resolves a known category", () => {
    expect(Log.isTraceCategory("bus")).toBe(true)
    expect(Log.isTraceCategory("permission")).toBe(true)
    expect(Log.isTraceCategory("io")).toBe(true)
  })

  test("rejects an unknown category", () => {
    expect(Log.isTraceCategory("nope")).toBe(false)
    expect(Log.isTraceCategory("")).toBe(false)
  })

  test("selectors normalize case and whitespace against the registry", () => {
    expect([...Log.normalizeTraceCategories(" BUS , Permission ")].sort()).toEqual(["bus", "permission"])
    expect([...Log.normalizeTraceCategories("all")].sort()).toEqual(["all"])
  })
})

describe("trace level and category filtering", () => {
  async function capture(run: () => void) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "log-trace-"))
    await Log.init({ print: false, dev: true, devFile: "trace.log", role: "serve", level: "INFO" })
    const previousDir = process.env.WOPAL_DEBUG_LOG_DIR
    process.env.WOPAL_DEBUG_LOG_DIR = dir
    try {
      await Log.init({ print: false, dev: true, devFile: "trace.log", role: "serve", level: "INFO" })
      run()
      // Writes are fire-and-forget; wait for the stream to flush.
      for (let attempt = 0; attempt < 50; attempt++) {
        const content = await fs.readFile(path.join(dir, "trace.log"), "utf8").catch(() => "")
        if (content.length > 0) return content
        await Bun.sleep(10)
      }
      return ""
    } finally {
      if (previousDir === undefined) delete process.env.WOPAL_DEBUG_LOG_DIR
      else process.env.WOPAL_DEBUG_LOG_DIR = previousDir
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  test("suppresses trace records at DEBUG", async () => {
    const content = await capture(() => {
      Log.setLevel("DEBUG")
      Log.create({ service: "trace-probe" }).trace("bus", "at-debug")
    })

    expect(content).not.toContain("at-debug")
  })

  test("emits nothing at TRACE when no category was selected", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE")
      const log = Log.create({ service: "trace-probe" })
      log.trace("bus", "no-selector-bus")
      log.trace("permission", "no-selector-permission")
      log.trace("session", "no-selector-session")
    })

    expect(content).not.toContain("no-selector-bus")
    expect(content).not.toContain("no-selector-permission")
    expect(content).not.toContain("no-selector-session")
  })

  test("emits only the selected categories when a selector is set", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE", ["permission"])
      const log = Log.create({ service: "trace-probe" })
      log.trace("bus", "selector-bus")
      log.trace("permission", "selector-permission")
    })

    expect(content).toContain("selector-permission")
    expect(content).not.toContain("selector-bus")
  })

  test("marks each record with its bounded category", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE", ["bus"])
      Log.create({ service: "trace-probe" }).trace("bus", "categorized-record")
    })

    expect(content).toContain("TRACE")
    expect(content).toContain("categorized-record")
    expect(content).toContain("bus")
  })

  test("accepts comma-separated selectors and normalizes case and whitespace", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE", " Permission , BUS ")
      const log = Log.create({ service: "trace-probe" })
      log.trace("permission", "csv-permission")
      log.trace("bus", "csv-bus")
      log.trace("session", "csv-session")
    })

    expect(content).toContain("csv-permission")
    expect(content).toContain("csv-bus")
    expect(content).not.toContain("csv-session")
  })

  test("treats `all` as an explicit all-category selector", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE", "all")
      const log = Log.create({ service: "trace-probe" })
      log.trace("permission", "all-selector-permission")
      log.trace("bus", "all-selector-bus")
      log.trace("session", "all-selector-session")
      log.trace("llm", "all-selector-llm")
    })

    expect(content).toContain("all-selector-permission")
    expect(content).toContain("all-selector-bus")
    expect(content).toContain("all-selector-session")
    expect(content).toContain("all-selector-llm")
  })

  test("ignores an unknown category in the selector without emitting it", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE", ["bus", "not-a-category"])
      const log = Log.create({ service: "trace-probe" })
      log.trace("bus", "known-category")
      // Deliberately bypass the type: untyped callers (or a future refactor)
      // must still be stopped by the runtime registry check.
      // @ts-expect-error unknown categories are not part of the registry
      log.trace("not-a-category", "unknown-category")
    })

    expect(content).toContain("known-category")
    expect(content).not.toContain("unknown-category")
  })

  test("resets the selector on re-init so it never leaks across runs", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE", ["permission"])
      Log.setLevel("INFO")
      Log.setLevel("TRACE")
      const log = Log.create({ service: "trace-probe" })
      log.trace("bus", "reset-bus")
      log.trace("permission", "reset-permission")
    })

    // The selector was cleared with the non-TRACE level, so a bare TRACE
    // level now emits nothing.
    expect(content).not.toContain("reset-bus")
    expect(content).not.toContain("reset-permission")
  })
})

/**
 * The unified level mechanism (DESIGN-config-settings.md "Logging Level"):
 * `requested` > `ELLAMAKA_LOG_LEVEL` > `wopal.logging.level` (global
 * `settings.jsonc`) > `INFO`. Each source is tried in order; an invalid value
 * is not a hit and the next source is consulted; an unreadable config falls
 * back to INFO and never blocks startup. TRACE is legal only as an explicit
 * (command-line / env) value — the persistent config domain is the four
 * operational levels.
 */
describe("effective log level resolution", () => {
  const levelDirs: string[] = []

  afterAll(() => {
    for (const dir of levelDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function settings(content: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ellamaka-level-"))
    levelDirs.push(dir)
    const file = path.join(dir, "settings.jsonc")
    writeFileSync(file, content)
    return file
  }

  test("explicit level wins over env and config", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "DEBUG" } } }`)
    expect(Log.resolveEffectiveLevel({ requested: "ERROR", env: { ELLAMAKA_LOG_LEVEL: "WARN" }, configFile })).toBe(
      "ERROR",
    )
  })

  test("env wins over config", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "DEBUG" } } }`)
    expect(Log.resolveEffectiveLevel({ env: { ELLAMAKA_LOG_LEVEL: "WARN" }, configFile })).toBe("WARN")
  })

  test("reads wopal.logging.level when no env is set", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "DEBUG" } } }`)
    expect(Log.resolveEffectiveLevel({ env: {}, configFile })).toBe("DEBUG")
  })

  test("defaults to INFO without env and config", () => {
    expect(Log.resolveEffectiveLevel({ env: {} })).toBe("INFO")
  })

  test("an invalid value is skipped in favor of the next source", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "WARN" } } }`)
    expect(Log.resolveEffectiveLevel({ env: { ELLAMAKA_LOG_LEVEL: "nonsense" }, configFile })).toBe("WARN")
    expect(Log.resolveEffectiveLevel({ env: { ELLAMAKA_LOG_LEVEL: "nonsense" } })).toBe("INFO")
  })

  test("an invalid config value falls back to INFO", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "verbose" } } }`)
    expect(Log.resolveEffectiveLevel({ env: {}, configFile })).toBe("INFO")
  })

  test("rejects TRACE in the config domain but accepts it from the env", () => {
    const configFile = settings(`{ "wopal": { "logging": { "level": "TRACE" } } }`)
    expect(Log.resolveEffectiveLevel({ env: {}, configFile })).toBe("INFO")
    expect(Log.resolveEffectiveLevel({ env: { ELLAMAKA_LOG_LEVEL: "TRACE" } })).toBe("TRACE")
  })

  test("an unreadable or malformed config falls back to INFO", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ellamaka-level-"))
    levelDirs.push(dir)
    // A directory as the settings path cannot be read; malformed JSONC is
    // parsed as an empty document. Neither may throw or block startup.
    expect(Log.resolveEffectiveLevel({ env: {}, configFile: dir })).toBe("INFO")
    const malformed = settings(`{ "wopal": { "logging": `)
    expect(Log.resolveEffectiveLevel({ env: {}, configFile: malformed })).toBe("INFO")
  })

  test("a syntactically invalid document never yields a configured level", () => {
    // jsonc-parser is fault-tolerant: a document with trailing garbage or a
    // trailing comma still parses to a recoverable tree, but the file is not
    // valid JSONC — the level inside it must be ignored (INFO), not honored.
    const trailingGarbage = settings(`{ "wopal": { "logging": { "level": "DEBUG" } } } garbage`)
    expect(Log.resolveEffectiveLevel({ env: {}, configFile: trailingGarbage })).toBe("INFO")
    const trailingComma = settings(`{ "wopal": { "logging": { "level": "DEBUG", } } }`)
    expect(Log.resolveEffectiveLevel({ env: {}, configFile: trailingComma })).toBe("INFO")
  })
})
