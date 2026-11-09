import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { temporaryDirectory } from "./fixture/temp"

describe("dev log directory resolution", () => {
  test("outside a space, init falls back to the global log dir (no throw)", async () => {
    const probeDir = temporaryDirectory("log-dir-fallback-")
    try {
      const probeFile = path.join(probeDir, "log-dir-fallback-probe.test.ts")
      const logModule = pathToFileURL(path.resolve(import.meta.dir, "../src/util/log.ts")).href
      await fs.writeFile(
        probeFile,
        [
          `import { expect, test } from "bun:test"`,
          `import { Log } from ${JSON.stringify(logModule)}`,
          `test("init without space envs does not throw", async () => {`,
          `  await Log.init({ dev: true, devFile: "probe-dev.log", level: "INFO" })`,
          `})`,
        ].join("\n"),
      )
      const result = Bun.spawnSync({
        cmd: [process.execPath, "test", probeFile],
        cwd: import.meta.dir,
        env: { ...process.env, WOPAL_DEBUG_LOG_DIR: "", WOPAL_SPACE_ROOT: "" },
      })
      expect(result.stderr.toString()).not.toContain("requires WOPAL_DEBUG_LOG_DIR")
      expect(result.exitCode).toBe(0)
    } finally {
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  })
})
