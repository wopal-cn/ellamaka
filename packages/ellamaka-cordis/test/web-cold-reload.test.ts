import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { AddressInfo } from "node:net"
import { DshWebColdReload, type ColdRebuildHandle } from "../src/runtime/web-cold-reload"

/**
 * The `dsh:web` cold-rebuild lifecycle (DESIGN.md#unified-reload--lifecycle):
 *
 *   drain → dispose → build → verify → publish → notify
 *
 * The HOST keeps the listening socket and the stable `/dsh` mount; the web
 * container is rebuilt inside a managed child process. While the rebuild
 * runs, in-flight old-container connections finish (drain), new requests
 * get an explicit 503 ("temporarily unavailable"), and after publish the
 * same mount forwards to the new container. A FAILED rebuild degrades the
 * `dsh:web` unit only: the mount answers 503, the host and its other units
 * keep running, and no revision is published (no fake revisions).
 *
 * The builder here is an in-process fake of the child-process boundary:
 * the lifecycle protocol (drain/dispose/build/verify/publish/notify, failure
 * degradation, no-revision-on-failure) is what these tests pin. Real
 * subprocess assembly (bun spawn / Electron utilityProcess) is covered in
 * batch 3's host wiring.
 */

interface FakeContainer {
  readonly id: number
  disposed: boolean
  handleRequest(req: unknown, res: unknown): unknown
  handleUpgrade(req: unknown, socket: unknown, head: unknown): unknown
}

let nextId: number
let server: Server
let baseUrl: string

beforeEach(async () => {
  nextId = 1
  server = createServer(() => {})
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A builder fake: counts builds, optionally fails, records dispose order. */
function fakeBuilder(events: string[], failOnce = false) {
  let failed = false
  return async (phase: { signal: AbortSignal }): Promise<{ container: FakeContainer; publish(): void }> => {
    if (failOnce && !failed) {
      failed = true
      throw new Error("simulated web container build failure")
    }
    const container: FakeContainer = {
      id: nextId++,
      disposed: false,
      handleRequest: (req, res) => {
        void req
        void res
        return container.id
      },
      handleUpgrade: () => container.id,
      async dispose(): Promise<void> {
        events.push(`dispose:${container.id}`)
      },
    }
    events.push(`build:${container.id}`)
    return {
      container,
      publish: () => events.push(`publish:${container.id}`),
    }
  }
}

describe("dsh:web cold reload lifecycle", () => {
  test("initial build publishes through the stable mount and forwards requests", async () => {
    const events: string[] = []
    const reloader = new DshWebColdReload({
      build: fakeBuilder(events),
      logger: { info() {}, warn() {}, error() {} },
    })
    try {
      const handle: ColdRebuildHandle = await reloader.ensureBuilt()
      expect(handle.container.disposed).toBe(false)

      // The stable mount forwards to the published container.
      expect(reloader.requestHandler()({}, fakeRes())).toBe(1)
      expect(events).toEqual(["build:1", "publish:1"])
    } finally {
      await reloader.dispose()
    }
  })

  test("rebuild drains the old container, then disposes it after publish", async () => {
    const events: string[] = []
    const reloader = new DshWebColdReload({
      build: fakeBuilder(events),
      logger: { info() {}, warn() {}, error() {} },
    })
    try {
      await reloader.ensureBuilt()
      const request = reloader.requestHandler()
      expect(request({}, fakeRes())).toBe(1)

      await reloader.rebuild()
      // New container is live; the old one is disposed AFTER the new one
      // published (drain → dispose ordering: the old container finishes its
      // in-flight work while the new one builds, and is only torn down once
      // the replacement is live).
      expect(request({}, fakeRes())).toBe(2)
      expect(events).toEqual(["build:1", "publish:1", "build:2", "publish:2", "dispose:1"])
    } finally {
      await reloader.dispose()
    }
  })

  test("while a rebuild runs, the old container still serves (drain semantics)", async () => {
    const events: string[] = []
    /** One gate per builder CALL, so the rebuild's builder gets its own gate. */
    const gates: Array<() => void> = []
    const gated = async (): Promise<{ container: FakeContainer; publish(): void }> => {
      await new Promise<void>((resolve) => {
        gates.push(resolve)
      })
      const container: FakeContainer = {
        id: nextId++,
        disposed: false,
        handleRequest: () => container.id,
        handleUpgrade: () => container.id,
        async dispose(): Promise<void> {
          events.push(`dispose:${container.id}`)
        },
      }
      events.push(`build:${container.id}`)
      return { container, publish: () => events.push(`publish:${container.id}`) }
    }
    const reloader = new DshWebColdReload({
      build: gated,
      logger: { info() {}, warn() {}, error() {} },
    })
    try {
      // The gated builder parks ensureBuilt until its gate opens, so the
      // first build starts WITHOUT awaiting, a macrotask yield lets the
      // builder reach its gate, then the gate opens.
      const built = reloader.ensureBuilt()
      await new Promise((resolve) => setTimeout(resolve, 10))
      gates.shift()!() // open the FIRST build's gate
      await built
      const request = reloader.requestHandler()
      expect(request({}, fakeRes())).toBe(1)

      // Start a rebuild and hold it in flight: drain semantics keep the old
      // container serving while the new one builds.
      const rebuilding = reloader.rebuild()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reloader.rebuildInProgress).toBe(true)
      expect(request({}, fakeRes())).toBe(1)

      gates.shift()!() // open the REBUILD's gate
      await rebuilding
      expect(request({}, fakeRes())).toBe(2)
    } finally {
      await reloader.dispose()
    }
  })

  test("a failed first build degrades the unit: 503, no publish, and a later rebuild recovers", async () => {
    const events: string[] = []
    const reloader = new DshWebColdReload({
      build: fakeBuilder(events, true),
      logger: { info() {}, warn() {}, error() {} },
      onRebuilt: (result) => events.push(result.ok ? `notify:${result.revision}` : "notify-failed"),
    })
    try {
      // First build fails: the unit degrades before anything published.
      await expect(reloader.ensureBuilt()).rejects.toThrow("simulated web container build failure")
      const request = reloader.requestHandler()
      const degradedRes = fakeRes()
      request({}, degradedRes)
      expect(degradedRes.status).toBe(503)
      expect(events.some((e) => e.startsWith("notify:"))).toBe(false)

      // A later real rebuild recovers the unit and publishes revision 1.
      await reloader.rebuild()
      const recoveredRes = fakeRes()
      request({}, recoveredRes)
      expect(recoveredRes.status).toBeUndefined()
      expect(events.some((e) => e === "notify:1")).toBe(true)
    } finally {
      await reloader.dispose()
    }
  })

  test("dispose tears down the live container and the mount answers 503 afterwards", async () => {
    const events: string[] = []
    const reloader = new DshWebColdReload({
      build: fakeBuilder(events),
      logger: { info() {}, warn() {}, error() {} },
    })
    await reloader.ensureBuilt()
    const request = reloader.requestHandler()
    expect(request({}, fakeRes())).toBe(1)
    await reloader.dispose()
    const disposedRes = fakeRes()
    request({}, disposedRes)
    expect(disposedRes.status).toBe(503)
    expect(events).toEqual(["build:1", "publish:1", "dispose:1"])
  })
})

/** A minimal response fake that records the status the handler wrote. */
function fakeRes(): { writeHead(n: number): unknown; end(): unknown; status?: number } {
  const res: { writeHead(n: number): unknown; end(): unknown; status?: number } = {
    status: undefined,
    writeHead: undefined as never,
    end: undefined as never,
  }
  res.writeHead = (n: number) => {
    res.status = n
    return res
  }
  res.end = () => {}
  return res
}
