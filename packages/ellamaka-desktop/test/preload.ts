// IMPORTANT: Set WOPAL_HOME BEFORE any import from src/ or
// @wopal/ellamaka-core/global. Global.Path is computed once at module load,
// so a later assignment would leave the process on the real user Home.
import os from "os"
import path from "path"
import fs from "fs/promises"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "ellamaka-desktop-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
process.env["WOPAL_HOME"] = dir

// Keep Desktop tests off the developer's real Space/plugin logs the same way
// the OpenCode preload does.
process.env["WOPAL_PLUGIN_LOG_FILE"] = path.join(dir, "wopal-plugin.log")

// A leftover desktop CDP/trace setting would make tests try to open a port.
delete process.env["WOPAL_DEV"]

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
