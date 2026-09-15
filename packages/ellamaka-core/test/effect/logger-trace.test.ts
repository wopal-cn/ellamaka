import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import * as Log from "../../src/util/log"
import * as EffectLogger from "../../src/effect/logger"

/**
 * The Effect runtime has no TRACE level of its own: `Effect.logTrace` and
 * `Effect.logDebug` both reach the bridge as `Trace`/`Debug`. The bridge must
 * therefore keep them distinct, otherwise the session/LLM loops that dominate
 * the historical flood can never be moved to the opt-in level.
 */
describe("effect logger trace routing", () => {
  async function capture(run: () => Effect.Effect<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "effect-log-trace-"))
    const previousDir = process.env.WOPAL_DEBUG_LOG_DIR
    process.env.WOPAL_DEBUG_LOG_DIR = dir
    await Log.init({ print: false, dev: true, devFile: "trace.log", role: "serve", level: "TRACE", trace: "session" })
    try {
      await Effect.runPromise(run().pipe(Effect.provide(EffectLogger.layer)))
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

  test("routes a handle trace call to the selected category", async () => {
    const log = EffectLogger.create({ service: "session.prompt" })
    const content = await capture(() => log.trace("session", "effect-trace-record"))

    expect(content).toContain("TRACE")
    expect(content).toContain("category=session")
    expect(content).toContain("effect-trace-record")
  })

  test("keeps the trace category annotation off the written record", async () => {
    const log = EffectLogger.create({ service: "session.prompt" })
    const content = await capture(() => log.trace("session", "no-annotation-leak"))

    expect(content).toContain("category=session")
    expect(content).not.toContain("log.trace.category")
  })

  test("carries the base fields on a trace record", async () => {
    const log = EffectLogger.create({ service: "session.prompt" }).with({ sessionID: "ses_trace" })
    const content = await capture(() => log.trace("session", "with-fields"))

    expect(content).toContain("session.id=ses_trace")
    expect(content).toContain("with-fields")
  })
})
