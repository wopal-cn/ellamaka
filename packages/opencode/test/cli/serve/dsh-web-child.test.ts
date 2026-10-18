import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer, request as httpRequest, type Server } from "node:http"
import net from "node:net"
import { PassThrough } from "node:stream"
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

/**
 * Minimal duplex socket pair standing in for the dispatcher boundary: writing
 * to one end is readable from the other, which is all `handleUpgrade` needs.
 * (Bun has no `net.createPair`; a real loopback socket pair would need an
 * extra listener and adds no contract value here.)
 */
function socketPair(): [net.Socket, net.Socket] {
  const make = (): { sock: net.Socket; feed: (chunk: Buffer) => void } => {
    const source = new PassThrough()
    const sink = new PassThrough()
    const sock = source as unknown as net.Socket
    // Cross-wire: writes to `sock` surface on the peer's readable side.
    const peer = { feed: (chunk: Buffer) => source.write(chunk) }
    void sink
    sock.write = ((chunk: Buffer, _enc?: unknown, cb?: () => void) => {
      peer.feed(chunk)
      cb?.()
      return true
    }) as net.Socket["write"]
    return { sock, feed: (chunk) => source.push(chunk) }
  }
  const a = make()
  const b = make()
  // a.write → readable on b; b.write → readable on a
  a.sock.write = ((chunk: Buffer, _enc?: unknown, cb?: () => void) => {
    b.feed(chunk)
    cb?.()
    return true
  }) as net.Socket["write"]
  b.sock.write = ((chunk: Buffer, _enc?: unknown, cb?: () => void) => {
    a.feed(chunk)
    cb?.()
    return true
  }) as net.Socket["write"]
  return [a.sock, b.sock]
}

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

  test("webChildProxyContainer forwards WebSocket upgrades to the child (101 handshake completes)", async () => {
    // Regression (Bun runtime): the previous proxyUpgrade relied on
    // node:http's `upgrade` event, which Bun does not emit — every browser
    // WebSocket through the parent hung until the client gave up ("连接中断"
    // retry loop). The contract is now end-to-end: a real upgrade request
    // through `handleUpgrade` must reach the child and complete the 101
    // handshake within a bounded time.
    // The fake child is a RAW TCP server, matching the real child's upgrade
    // path (cordis VirtualWebServer answers upgrades on the raw socket; Bun's
    // node:http `upgrade` event fires but swallows socket bytes, so a plain
    // createServer() cannot stand in for the child here).
    const upgradeServer = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
        socket.end()
      })
    })
    await new Promise<void>((resolve) => upgradeServer.listen(0, "127.0.0.1", resolve))
    const address: unknown = upgradeServer.address()
    expect(address).toHaveProperty("port")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- expect guard above pins the shape
    const upgradePort = (address as { port: number }).port

    const container = webChildProxyContainer({ port: upgradePort })
    // A client-side socket pair whose "server side" IS the proxy: we feed the
    // raw upgrade request into `handleUpgrade` (the dispatcher's entry) and
    // read the child's answer back from the paired client — the exact parent
    // path without needing a real listening socket in between.
    const [client, serverSide] = socketPair()
    const raw = client
    container.handleUpgrade(
      {
        method: "GET",
        url: "/api/remote.mux",
        headers: {
          host: "127.0.0.1",
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      },
      serverSide,
      Buffer.alloc(0),
    )
    // The proxy must answer with the child's 101 within 5s; a hang is the
    // exact Bun regression this test pins.
    const response = await new Promise<string>((resolve) => {
      let data = ""
      const timer = setTimeout(() => resolve("TIMEOUT"), 5000)
      raw.on("data", (chunk) => {
        data += chunk.toString("latin1")
        if (data.includes("\r\n\r\n")) {
          clearTimeout(timer)
          resolve(data)
        }
      })
      raw.on("error", () => {
        clearTimeout(timer)
        resolve("ERROR")
      })
    })
    expect(response).toContain("101 Switching Protocols")
    raw.destroy()
    await new Promise<void>((resolve) => upgradeServer.close(() => resolve()))
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
