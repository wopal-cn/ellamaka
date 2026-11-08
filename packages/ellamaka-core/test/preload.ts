// IMPORTANT: Set WOPAL_HOME BEFORE any imports from src/ directory.
// global.ts reads WOPAL_HOME at import time, so we must redirect it first.
import os from "os"
import path from "path"
import fs from "fs/promises"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "ellamaka-core-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
process.env["WOPAL_HOME"] = dir
process.env["OPENCODE_TEST_HOME"] = path.join(dir, "home")
await fs.mkdir(process.env["OPENCODE_TEST_HOME"], { recursive: true })
delete process.env["OPENCODE_CLIENT"]
delete process.env["WOPAL_SPACE"]
delete process.env["WOPAL_SPACE_ROOT"]

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
