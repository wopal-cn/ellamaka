import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CorePreparationEvent } from "@wopal/ellamaka-core/preparation"
import { getCorePreparationHealth, prepareDshHost } from "@/core/preparation"
import { GlobalBus } from "@/bus/global"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("product CorePreparation host wiring", () => {
  test("DSH disabled publishes one skipped fact and performs zero DSH filesystem work", async () => {
    const wopalHome = mkdtempSync(join(tmpdir(), "core-preparation-disabled-"))
    dirs.push(wopalHome)
    const progress: CorePreparationEvent[] = []
    const global: CorePreparationEvent[] = []
    const listener = (event: { payload?: { type?: string; properties?: CorePreparationEvent } }) => {
      if (event.payload?.type === "core.preparation" && event.payload.properties) global.push(event.payload.properties)
    }
    GlobalBus.on("event", listener)
    try {
      const outcome = await prepareDshHost({
        wopalHome,
        runtimeLogFile: join(wopalHome, "logs", "dsh-runtime.log"),
        env: { ELLAMAKA_DSH: "0" },
        onProgress: (event) => progress.push(event),
      })
      expect(outcome.status).toBe("disabled")
      const health = await getCorePreparationHealth()
      expect(health.dshRuntime).toEqual({ closureVersion: expect.any(Number) })
      expect(health.preparation).toBeUndefined()
      expect(progress).toHaveLength(1)
      expect(progress[0]).toMatchObject({ step: "dsh", phase: "skipped", state: "READY", sequence: 1 })
      expect(global).toHaveLength(1)
      expect(global[0]).toEqual(progress[0])
      expect(existsSync(join(wopalHome, "dsh"))).toBe(false)
      expect(existsSync(join(wopalHome, "logs"))).toBe(false)
    } finally {
      GlobalBus.off("event", listener)
    }
  })
})
