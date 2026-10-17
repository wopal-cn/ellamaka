import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { runWebChildIfRequested, webChildReadyLine } from "../src/runtime/web-child"
import { prepareDshProfiles } from "./fixture/prepare-dsh-profiles"
import { prepareDshHome } from "../src/runtime/home-guard"
import { DEFAULT_DSH_RUNTIME_MANIFEST } from "../src/runtime/manager"

/**
 * The `dsh:web` child-process boundary (DESIGN.md#unified-reload--lifecycle,
 * 隔离边界): the web container runs in a NEW managed child process so a code
 * or package-version change gets a clean module graph. The child boots the
 * real web profile onto a REAL loopback `node:http` listener (the parent owns
 * the public socket and proxies `/dsh` to it), acquires its own shared Home
 * lease for the time it actually uses the Home, and reports readiness as one
 * JSON line on stdout.
 *
 * These tests exercise the child role directly (marker-argv entry) and the
 * controller-visible container surface the host builder wraps: an HTTP proxy
 * target that answers real requests and upgrades.
 */

beforeEach(() => {
  delete process.env.DSH_WEB_CHILD_READY
})

afterEach(() => {
  delete process.env.DSH_WEB_CHILD_READY
})

function childArgv(home: string): string[] {
  return [
    process.execPath,
    join(import.meta.dir, "fixtures/web-child-entry.ts"),
    "--ellamaka-dsh-web-child",
    "--home",
    home,
    "--port",
    "0",
  ]
}

describe("dsh:web child process boundary", () => {
  test("marker entry answers false for a normal CLI invocation", async () => {
    expect(await runWebChildIfRequested(["ellamaka", "serve"])).toBe(false)
  })

  test("webChildReadyLine is one JSON line with the bound port", () => {
    const line = webChildReadyLine(51234)
    expect(line).toContain("\n")
    const parsed: unknown = JSON.parse(line.trim())
    expect(parsed).toEqual({ ready: true, port: 51234 })
  })

  test("child boots the web profile on a real port and serves HTTP until shutdown", async () => {
    const wopalHome = mkdtempSync(join(tmpdir(), "web-child-"))
    const home = join(wopalHome, "dsh")
    // A managed Home (managed marker + current.json) so the child's shared
    // Home lease acquisition succeeds — the child does not prepare.
    const prepared = await prepareDshHome({ wopalHome, closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion })
    expect(prepared.ok).toBe(true)
    prepareDshProfiles(home)
    const child = Bun.spawn(childArgv(home), {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: { ...process.env, ELLAMAKA_DSH: "1" },
    })

    let exited = false
    const exitedOnce = child.exited.then(() => {
      exited = true
    })
    void exitedOnce

    // Read the ready line from the child's stdout.
    const reader = child.stdout.getReader()
    let buffer = ""
    const deadline = Date.now() + 60_000
    let ready: { ready: boolean; port: number } | undefined
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value)
      const lineEnd = buffer.indexOf("\n")
      if (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).trim()
        if (line.startsWith("{")) {
          const parsed: unknown = JSON.parse(line)
          expect(parsed).toMatchObject({ ready: true })
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard above pins the shape
          ready = parsed as { ready: boolean; port: number }
          break
        }
      }
    }
    expect(ready).toBeDefined()
    expect(ready!.ready).toBe(true)
    expect(ready!.port).toBeGreaterThan(0)
    expect(exited).toBe(false)

    // The child's real listener answers HTTP (browser-auth 401 for a plain
    // visit is the profile's own fail-closed fence — proves real serving).
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: ready!.port, path: "/" }, (res) => {
        void res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on("error", async (error) => {
        const err = await child.stderr.getReader().read()
        reject(
          new Error(
            `child HTTP probe failed: ${error.message}; stderr: ${new TextDecoder().decode(err.value ?? new Uint8Array())}`,
          ),
        )
      })
      req.end()
    })
    expect(status).toBeGreaterThan(0)

    // Graceful shutdown over stdin (the host-coordinated channel; the
    // profile's own signal path owns SIGTERM) releases the Home lease, exits 0.
    child.stdin.write("shutdown\n")
    await Promise.race([
      child.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error("child did not exit after shutdown")), 15_000)),
    ])
    const code = await child.exited
    expect(code).toBe(0)
  }, 90_000)

  test("child shuts down gracefully on the stdin shutdown line", async () => {
    const wopalHome = mkdtempSync(join(tmpdir(), "web-child-"))
    const home = join(wopalHome, "dsh")
    const prepared = await prepareDshHome({ wopalHome, closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion })
    expect(prepared.ok).toBe(true)
    prepareDshProfiles(home)
    const child = Bun.spawn(childArgv(home), {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: { ...process.env, ELLAMAKA_DSH: "1" },
    })
    const reader = child.stdout.getReader()
    let buffer = ""
    const deadline = Date.now() + 60_000
    let ready: { ready: boolean; port: number } | undefined
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value)
      const lineEnd = buffer.indexOf("\n")
      if (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).trim()
        if (line.startsWith("{")) {
          const parsed: unknown = JSON.parse(line)
          expect(parsed).toMatchObject({ ready: true })
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard above pins the shape
          ready = parsed as { ready: boolean; port: number }
          break
        }
      }
    }
    expect(ready).toBeDefined()
    child.stdin.write("shutdown\n")
    await Promise.race([
      child.exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("child did not exit after stdin shutdown")), 15_000),
      ),
    ])
    expect(await child.exited).toBe(0)
  }, 90_000)
})

/**
 * The controller-visible container: the host builder wraps the child into a
 * `ColdRebuildContainer` that PROXIES requests/upgrades to the child's real
 * listener. This pins the proxy contract the lifecycle relies on: request
 * bytes flow both ways and the proxy survives the child's port being
 * OS-assigned.
 */
describe("dsh:web child proxy container", () => {
  let upstream: Server

  beforeEach(async () => {
    upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(`upstream:${req.url}`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  test("the web-child module loads alongside an HTTP upstream (module graph sanity)", async () => {
    await import("../src/runtime/web-child")
    const address: unknown = upstream.address()
    expect(address).toHaveProperty("port")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard above pins the shape
    const port = (address as { port: number }).port

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/x?y=1" }, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve(data))
      })
      req.on("error", reject)
      req.end()
    })
    expect(body).toBe("upstream:/x?y=1")
  })
})
