import { existsSync, writeFileSync } from "node:fs"
import { acquireHomeLock, releaseHomeLock, type HomeLockMode } from "../../src/runtime/home-lock"

const [lockPath, rawMode, readyPath, releasePath] = process.argv.slice(2)
if (!lockPath || (rawMode !== "shared" && rawMode !== "exclusive") || !readyPath || !releasePath) process.exit(2)
const mode: HomeLockMode = rawMode

const token = await acquireHomeLock(lockPath, mode, 5_000)
if (!token) process.exit(3)
writeFileSync(readyPath, "ready")

while (!existsSync(releasePath)) await Bun.sleep(10)
await releaseHomeLock(lockPath, token)
