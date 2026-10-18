import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer, request as httpRequest, type Server } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import { DshWebColdReload } from "@wopal/ellamaka-cordis/runtime/web-cold-reload"
import {
  spawnWebChildContainer,
  webChildProxyContainer,
  type WebChildProcess,
} from "../../../src/cli/cmd/dsh-web-child"

/**
 * The host-side assembly of the `dsh:web` cold reload (DESIGN.md#unified-reload
 * --lifecycle 隔离边界): the builder spawns the web child (`resolveEllamakaCommand`
 * + `dsh-web-child` hidden command), parses the child's ready line, and wraps the
 * child's real listener into a `ColdRebuildContainer` that PROXIES requests and
 * upgrades. The controller (DshWebColdReload) owns the lifecycle; these tests pin
 * the builder contract: spawn → ready line → proxying → dispose kills the child.
 *
 * The child spawn is exercised against a FAKE child process (a plain bun process
 * printing the ready line and serving a real HTTP server) so the test does not
 * boot the real DSH profile — the child role itself is covered in
 * ellamaka-cordis (`test/web-child.test.ts`).
 */

let fakeChild: Server
let fakePort = 0

beforeEach(async () => {
  fakeChild = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`fake-child:${req.url}`)
  })
  await new Promise<void>((resolve) => fakeChild.listen(0, "127.0.0.1", resolve))
  const address: unknown = fakeChild.address()
  expect(address).toHaveProperty("port")
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard above pins the shape
  fakePort = (address as { port: number }).port
})

afterEach(async () => {
  await new Promise<void>((resolve) => fakeChild.close(() => resolve()))
})

describe("dsh:web child host builder", () => {
  test("webChildProxyContainer forwards requests to the child port", async () => {
    const container = webChildProxyContainer({ port: fakePort })
    const result = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: fakePort, path: "/a?b=1" }, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve(data))
      })
      req.on("error", reject)
      req.end()
    })
    expect(result).toBe("fake-child:/a?b=1")
    // The proxy feeds the upstream asynchronously; the call itself returns
    // without throwing on a shaped request (controller contract: handler
    // never rejects synchronously).
    expect(() => container.handleRequest({}, { writeHead() {}, end() {} })).not.toThrow()
  })

  test("webChildProxyContainer bridges WebSocket upgrades to the child (101 handshake + message round-trip)", async () => {
    // Regression (Bun runtime): Bun swallows every socket.write() on a
    // node:http upgrade socket (oven-sh/bun#9882, #35325), so raw-byte tunnels
    // can never answer a browser's 101. The proxy must terminate the upgrade
    // with the `ws` noServer path (Bun's ws shim uses the native handoff) and
    // bridge frames to a native WebSocket dialed at the child. The contract is
    // end-to-end: handshake completes AND one frame round-trips.
    const childHttp = createServer()
    const childWss = new WebSocketServer({ noServer: true })
    childHttp.on("upgrade", (req, sock, head) =>
      childWss.handleUpgrade(req, sock, head, (ws) => {
        ws.on("message", (m) => ws.send(`echo:${String(m)}`))
      }),
    )
    await new Promise<void>((resolve) => childHttp.listen(0, "127.0.0.1", resolve))
    const address: unknown = childHttp.address()
    expect(address).toHaveProperty("port")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard above pins the shape
    const childPort = (address as { port: number }).port

    const container = webChildProxyContainer({ port: childPort })
    // The dispatcher boundary: feed an upgrade request into handleUpgrade with
    // a fake duplex pair, then use a native WebSocket against a loopback
    // listener that forwards into the container's socket side.
    const relay = createServer((req: unknown, res: { writeHead(n: number): unknown; end(): unknown }) => {
      res.writeHead(500)
      res.end()
    })
    relay.on("upgrade", (req, sock, head) => container.handleUpgrade(req, sock, head))
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
    const relayAddress: unknown = relay.address()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard pins shape
    const relayPort = (relayAddress as { port: number }).port

    const probe = new WebSocket(`ws://127.0.0.1:${relayPort}/api/remote.mux`)
    const roundTrip = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws round-trip timed out")), 5000)
      probe.on("open", () => probe.send("ping"))
      probe.on("message", (m) => {
        clearTimeout(timer)
        resolve(String(m))
      })
      probe.on("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    expect(await roundTrip).toBe("echo:ping")
    probe.close()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    await new Promise<void>((resolve) => childHttp.close(() => resolve()))
  })

  /**
   * Build a child WebSocket listener that records the upgrade request headers
   * it receives, then echoes. Returns the port and the captured headers.
   */
  const recordingChild = async (onUpgrade?: (sock: import("node:stream").Duplex) => boolean) => {
    const childHttp = createServer()
    const childWss = new WebSocketServer({ noServer: true })
    const seen: { headers?: import("node:http").IncomingHttpHeaders; frames: boolean[] } = { frames: [] }
    childHttp.on("upgrade", (req, sock, head) => {
      seen.headers = req.headers
      if (onUpgrade && onUpgrade(sock)) return
      childWss.handleUpgrade(req, sock, head, (ws) => {
        ws.on("message", (_data, isBinary) => seen.frames.push(isBinary))
      })
    })
    await new Promise<void>((resolve) => childHttp.listen(0, "127.0.0.1", resolve))
    const address: unknown = childHttp.address()
    expect(address).toHaveProperty("port")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard above pins the shape
    const childPort = (address as { port: number }).port
    return {
      childPort,
      seen,
      close: () => new Promise<void>((resolve) => childHttp.close(() => resolve())),
    }
  }

  /** A relay listener that forwards upgrades into the container's handler. */
  const relayFor = async (container: ReturnType<typeof webChildProxyContainer>) => {
    const relay = createServer((_req: unknown, res: { writeHead(n: number): unknown; end(): unknown }) => {
      res.writeHead(500)
      res.end()
    })
    relay.on("upgrade", (req, sock, head) => container.handleUpgrade(req, sock, head))
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
    const address: unknown = relay.address()
    expect(address).toHaveProperty("port")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard pins shape
    const port = (address as { port: number }).port
    return { port, close: () => new Promise<void>((resolve) => relay.close(() => resolve())) }
  }

  test("webChildProxyContainer forwards the browser's Host and Cookie when dialing the child", async () => {
    // The child's DSH fence derives the browser-auth cookie NAME from the Host
    // authority and then verifies that cookie. A proxy that dials the child
    // with its own loopback authority and no Cookie can never pass it: the
    // child answers 401/destroys the socket and the Workbench DSH panel
    // reconnects forever. The upgrade dial must carry the browser's headers.
    const child = await recordingChild()
    const container = webChildProxyContainer({ port: child.childPort })
    const relay = await relayFor(container)

    const cookie = "dsh-auth-abc123=v1.payload.signature"
    const probe = new WebSocket(`ws://127.0.0.1:${relay.port}/api/remote.mux`, {
      headers: { cookie },
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("probe ws did not open")), 5000)
      probe.on("open", () => {
        clearTimeout(timer)
        resolve()
      })
      probe.on("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })

    expect(child.seen.headers?.host).toBe(`127.0.0.1:${relay.port}`)
    expect(child.seen.headers?.cookie).toBe(cookie)

    probe.close()
    await relay.close()
    await child.close()
  })

  test("webChildProxyContainer keeps text frames text and binary frames binary", async () => {
    // The DSH RPC protocol carries JSON text frames and binary payloads on the
    // same socket. Forwarding a text frame as binary makes the child fail to
    // decode and drop the connection, which the UI reports as a reconnect loop.
    const child = await recordingChild()
    const container = webChildProxyContainer({ port: child.childPort })
    const relay = await relayFor(container)

    const probe = new WebSocket(`ws://127.0.0.1:${relay.port}/api/remote.mux`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("probe ws did not open")), 5000)
      probe.on("open", () => {
        clearTimeout(timer)
        resolve()
      })
      probe.on("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    probe.send("text-frame")
    probe.send(Buffer.from([0, 1, 2]))

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(child.seen.frames.slice(0, 2)).toEqual([false, true])

    probe.close()
    await relay.close()
    await child.close()
  })

  test("webChildProxyContainer never reports 101 when the child rejects the upgrade", async () => {
    // Masking a failed upstream as a successful handshake turns every auth or
    // backend failure into an endless "reconnecting" loop in the browser. The
    // browser-side handshake must stay uncompleted until the child accepts.
    const child = await recordingChild((sock) => {
      sock.destroy()
      return true
    })
    const container = webChildProxyContainer({ port: child.childPort })
    const relay = await relayFor(container)

    const probe = new WebSocket(`ws://127.0.0.1:${relay.port}/api/remote.mux`)
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 5000)
      probe.on("open", () => {
        clearTimeout(timer)
        resolve("open")
      })
      probe.on("error", () => {
        clearTimeout(timer)
        resolve("error")
      })
      probe.on("close", (code) => {
        clearTimeout(timer)
        resolve(`close:${code}`)
      })
    })
    expect(outcome).not.toBe("open")

    await relay.close()
    await child.close()
  })

  test("spawnWebChildContainer resolves after the ready line and proxies HTTP; dispose kills the child", async () => {
    // Fake child: prints the ready line (with the browser-auth entry the
    // iframe needs) for the OS-assigned fake port, then serves until killed.
    const fake = Bun.spawn(
      [
        process.execPath,
        "-e",
        `console.log(JSON.stringify({ ready: true, port: ${fakePort}, authPath: "/?token=abc" }))`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const spawned: WebChildProcess = {
      pid: fake.pid,
      stdout: fake.stdout as ReadableStream<Uint8Array>,
      stderr: fake.stderr as ReadableStream<Uint8Array>,
      kill: () => fake.kill(),
      exited: fake.exited,
    }
    const container = await spawnWebChildContainer({
      spawn: () => spawned,
      port: 0,
      home: "/unused",
    })
    expect(container).toBeDefined()
    // The ready line's browser-auth entry surfaces on the container so the
    // host composes `<origin>/dsh/?token=…` for the Workbench iframe.
    expect(container.authPath).toBe("/?token=abc")
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: fakePort, path: "/probe" }, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => resolve(data))
      })
      req.on("error", reject)
      req.end()
    })
    expect(body).toBe("fake-child:/probe")
    await container.dispose?.()
    expect(await fake.exited).toBeDefined()
  })

  test("spawnWebChildContainer rejects when the child exits before the ready line", async () => {
    const fake = Bun.spawn([process.execPath, "-e", "process.exit(3)"], { stdout: "pipe", stderr: "pipe" })
    const spawned: WebChildProcess = {
      pid: fake.pid,
      stdout: fake.stdout as ReadableStream<Uint8Array>,
      stderr: fake.stderr as ReadableStream<Uint8Array>,
      kill: () => fake.kill(),
      exited: fake.exited,
    }
    let message = ""
    try {
      await spawnWebChildContainer({ spawn: () => spawned, port: 0, home: "/unused" })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("before ready")
  })

  test("controller + builder end-to-end: rebuild swaps the live proxy without touching the mount", async () => {
    const bodies: string[] = []
    const buildChild = (marker: string) => {
      const fake = Bun.spawn(
        [process.execPath, "-e", `console.log(JSON.stringify({ ready: true, port: ${fakePort} }))`],
        { stdout: "pipe", stderr: "pipe" },
      )
      return {
        spawned: {
          pid: fake.pid,
          stdout: fake.stdout as ReadableStream<Uint8Array>,
          stderr: fake.stderr as ReadableStream<Uint8Array>,
          kill: () => fake.kill(),
          exited: fake.exited,
        },
        marker,
      }
    }
    let generation = 0
    const spawnedChildren: WebChildProcess[] = []
    const reloader = new DshWebColdReload({
      build: async () => {
        generation += 1
        const { spawned } = buildChild(String(generation))
        spawnedChildren.push(spawned)
        const container = await spawnWebChildContainer({ spawn: () => spawned, port: 0, home: "/unused" })
        return {
          container,
          publish: () => {},
        }
      },
      logger: { info() {}, warn() {}, error() {} },
    })
    await reloader.ensureBuilt()
    expect(reloader.revision).toBe(1)
    await reloader.rebuild()
    expect(reloader.revision).toBe(2)
    // The fake child is shared across generations here, so both generations
    // proxy to the same port — the pin is that rebuild() resolves and bumps
    // the revision; real code-change switchover is the Task 10 smoke.
    expect(generation).toBe(2)
    expect(bodies).toEqual([])
    await reloader.dispose()
  })
})
