/**
 * Lock child-process helper (lock.test.ts, B-04). Runs in a real `bun` child
 * so `process.pid` and `process.kill(pid, 0)` behave like two independent
 * processes competing for the same materialisation guard.
 *
 * CLI contract:
 *   lock-child.ts <lockPath> <command> [args...]
 *
 * Commands:
 *   acquire <holdMs>          acquire the lock, hold it `holdMs` ms, then
 *                             release with its own token, then exit 0.
 *   acquireAndHold            acquire the lock, signal readiness on stdout
 *                             ("READY\n"), hold forever (until killed).
 *   release <tokenTime>       release the lock using token {pid: process.pid,
 *                             time: <tokenTime>} — used to simulate a delayed
 *                             release racing another process's re-acquire.
 */
import { acquireMaterializeLock, releaseMaterializeLock } from "../lock.js"

const [lockPath, command, ...rest] = process.argv.slice(2)

switch (command) {
  case "acquire": {
    const holdMs = Number(rest[0])
    const token = await acquireMaterializeLock(lockPath, 10_000)
    if (!token) process.exit(2)
    await new Promise((r) => setTimeout(r, holdMs))
    await releaseMaterializeLock(lockPath, token)
    process.exit(0)
  }
  case "acquireAndHold": {
    const token = await acquireMaterializeLock(lockPath, 10_000)
    if (!token) process.exit(2)
    process.stdout.write("READY\n")
    await new Promise(() => {})
  }
  case "release": {
    const tokenTime = Number(rest[0])
    await releaseMaterializeLock(lockPath, { pid: process.pid, time: tokenTime })
    process.exit(0)
  }
  default:
    process.stderr.write(`unknown command: ${command}\n`)
    process.exit(2)
}
