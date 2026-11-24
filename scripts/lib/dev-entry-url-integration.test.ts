import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../..")

async function runDevEntryUrl(opts: {
  frontendPort: number
  backendPort?: number
  backendLogPath: string
  password?: string
  username?: string
}): Promise<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    REPO_ROOT,
    ELLAMAKA_SERVER_PASSWORD: opts.password,
    ELLAMAKA_SERVER_USERNAME: opts.username,
  }
  if (opts.password === undefined) delete env.ELLAMAKA_SERVER_PASSWORD
  if (opts.username === undefined) delete env.ELLAMAKA_SERVER_USERNAME

  const arg2 = opts.backendPort !== undefined ? String(opts.backendPort) : ""
  const script = `
    set -euo pipefail
    source "$REPO_ROOT/scripts/dev.sh"
    BACKEND_LOG=${JSON.stringify(opts.backendLogPath)}
    dev_entry_url ${JSON.stringify(String(opts.frontendPort))} ${JSON.stringify(arg2)}
  `
  const proc = Bun.spawn(["bash", "-c", script], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`dev_entry_url failed (${exitCode}): ${stderr.trim()}`)
  }
  return stdout.trim()
}

function withTempLog(initial?: string): { dir: string; logPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "dev-entry-url-"))
  const logPath = join(dir, "backend.log")
  if (initial !== undefined) writeFileSync(logPath, initial)
  return { dir, logPath }
}

describe("dev.sh dev_entry_url", () => {
  test("queries live backend setup state during initial serve even before log flush", async () => {
    let locked = true
    let completed = true
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/wopal-space/setup/inspect") {
          return Response.json({ home: { binding: { locked } }, state: { completed } })
        }
        return new Response("Not Found", { status: 404 })
      },
    })
    const { dir, logPath } = withTempLog()
    try {
      // Missing backend log, completed & locked -> /workbench
      expect(await runDevEntryUrl({ frontendPort: 3000, backendPort: server.port, backendLogPath: logPath })).toBe(
        "http://127.0.0.1:3000/workbench",
      )

      // Empty backend log, uncompleted -> /onboarding
      writeFileSync(logPath, "")
      completed = false
      expect(await runDevEntryUrl({ frontendPort: 3000, backendPort: server.port, backendLogPath: logPath })).toBe(
        "http://127.0.0.1:3000/onboarding",
      )
    } finally {
      await server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("prefers live backend state over stale onboarding log during restart frontend", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (new URL(req.url).pathname === "/wopal-space/setup/inspect") {
          return Response.json({ home: { binding: { locked: true } }, state: { completed: true } })
        }
        return new Response("Not Found", { status: 404 })
      },
    })
    const { dir, logPath } = withTempLog(
      "ellamaka server listening on http://127.0.0.1:4096\nonboarding: http://127.0.0.1:4096/onboarding\n",
    )
    try {
      expect(await runDevEntryUrl({ frontendPort: 3001, backendPort: server.port, backendLogPath: logPath })).toBe(
        "http://127.0.0.1:3001/workbench",
      )
    } finally {
      await server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("authenticates Basic probe and preserves or synthesizes auth_token when password is set", async () => {
    const expectedAuth = `Basic ${Buffer.from("admin:s3cret").toString("base64")}`
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.headers.get("authorization") !== expectedAuth) {
          return new Response("Unauthorized", { status: 401 })
        }
        if (new URL(req.url).pathname === "/wopal-space/setup/inspect") {
          return Response.json({ home: { binding: { locked: false } }, state: { completed: false } })
        }
        return new Response("Not Found", { status: 404 })
      },
    })
    const { dir, logPath } = withTempLog()
    try {
      // No log yet: probe authenticates via Basic Auth and synthesizes ?auth_token=
      const token = Buffer.from("admin:s3cret").toString("base64")
      expect(
        await runDevEntryUrl({
          frontendPort: 3000,
          backendPort: server.port,
          backendLogPath: logPath,
          username: "admin",
          password: "s3cret",
        }),
      ).toBe(`http://127.0.0.1:3000/onboarding?auth_token=${token}`)

      // With log token present: preserves token from log
      writeFileSync(logPath, `onboarding: http://127.0.0.1:${server.port}/onboarding?auth_token=from-log-token\n`)
      expect(
        await runDevEntryUrl({
          frontendPort: 3000,
          backendPort: server.port,
          backendLogPath: logPath,
          username: "admin",
          password: "s3cret",
        }),
      ).toBe("http://127.0.0.1:3000/onboarding?auth_token=from-log-token")
    } finally {
      await server.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to backend log or /startup when backend is unreachable rather than guessing /workbench", async () => {
    const closedServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") })
    const closedPort = closedServer.port
    await closedServer.stop(true)

    const { dir, logPath } = withTempLog()
    try {
      // Neither reachable backend nor log -> /startup
      expect(await runDevEntryUrl({ frontendPort: 3000, backendPort: closedPort, backendLogPath: logPath })).toBe(
        "http://127.0.0.1:3000/startup",
      )

      // Unreachable backend but valid log -> honors log entry and token
      writeFileSync(logPath, "onboarding: http://127.0.0.1:4096/onboarding?auth_token=abc123\n")
      expect(await runDevEntryUrl({ frontendPort: 3000, backendPort: closedPort, backendLogPath: logPath })).toBe(
        "http://127.0.0.1:3000/onboarding?auth_token=abc123",
      )

      writeFileSync(logPath, "workbench: http://127.0.0.1:4096/workbench\n")
      expect(await runDevEntryUrl({ frontendPort: 3000, backendPort: closedPort, backendLogPath: logPath })).toBe(
        "http://127.0.0.1:3000/workbench",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
