import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
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
 * widen diagnostics (event-bus publishes, permission decisions) without
 * restoring the per-decision INFO/DEBUG flood removed from normal operation.
 * A category selector keeps that widening bounded: `--trace permission,bus`
 * must emit only those categories.
 */
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

  test("treats an explicit TRACE level without a selector as every category", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE")
      const log = Log.create({ service: "trace-probe" })
      log.trace("bus", "all-categories-bus")
      log.trace("permission", "all-categories-permission")
    })

    expect(content).toContain("all-categories-bus")
    expect(content).toContain("all-categories-permission")
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
      log.trace("other", "csv-other")
    })

    expect(content).toContain("csv-permission")
    expect(content).toContain("csv-bus")
    expect(content).not.toContain("csv-other")
  })

  test("treats `all` as an explicit all-category selector", async () => {
    const content = await capture(() => {
      Log.setLevel("TRACE", "all")
      const log = Log.create({ service: "trace-probe" })
      log.trace("permission", "all-selector-permission")
      log.trace("bus", "all-selector-bus")
    })

    expect(content).toContain("all-selector-permission")
    expect(content).toContain("all-selector-bus")
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

    expect(content).toContain("reset-bus")
    expect(content).toContain("reset-permission")
  })
})
