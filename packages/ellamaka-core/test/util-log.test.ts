import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

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