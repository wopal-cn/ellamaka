import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@wopal/ellamaka-core/global"

describe("Global.ensure", () => {
  test("creates runtime directories explicitly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ellamaka-global-ensure-"))
    const dirs = {
      data: path.join(root, "data"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      log: path.join(root, "log"),
      bin: path.join(root, "bin"),
      repos: path.join(root, "repos"),
    }

    try {
      await Global.ensure(dirs)
      for (const dir of Object.values(dirs)) {
        expect((await fs.stat(dir)).isDirectory()).toBe(true)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
