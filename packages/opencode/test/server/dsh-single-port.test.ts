import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "node:net"
import { once } from "node:events"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import * as Log from "@wopal/ellamaka-core/util/log"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { seedDshClosure } from "../fixture/dsh-closure"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  initializeDshRuntime,
  resolveInstallAnchor,
} from "@wopal/ellamaka-cordis/runtime"
import { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"

void Log.init({ print: false })

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}
const auth = { username: "opencode", password: "listen-secret" }

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = original.envUsername
  await disposeAllInstances()
  await resetDatabase()
})

async function startListener() {
  Flag.OPENCODE_SERVER_PASSWORD = auth.password
  Flag.OPENCODE_SERVER_USERNAME = auth.username
  process.env.OPENCODE_SERVER_PASSWORD = auth.password
  process.env.OPENCODE_SERVER_USERNAME = auth.username
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

function authorization() {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

/**
 * Mount the DSH web profile onto a real Ellamaka listener under /dsh, mirroring
 * the serve.ts wiring (DESIGN-dsh-poc §2.1 single-port scheme). Runs the real
 * unified Runtime Manager: a complete closure is seeded under a temp WOPAL_HOME
 * (via `seedDshClosure`), the manager fast-path resolves it `ready`, and the
 * web profile mounts with the closure runtime injected — exactly what the CLI
 * serve/web entries do. A temp WOPAL_HOME keeps the test off the user's home.
 */
async function mountDsh(listener: Awaited<ReturnType<typeof startListener>>) {
  const wopalHome = mkdtempSync(join(tmpdir(), "dsh-single-port-"))
  const anchor = seedDshClosure(wopalHome)
  const manifest = DEFAULT_DSH_RUNTIME_MANIFEST
  const status = await initializeDshRuntime({
    wopalHome,
    logFile: join(wopalHome, "logs", "dsh-plugins.log"),
    entry: "serve",
    manifest,
    // The runtime manager gates on `ELLAMAKA_DSH` from its `env` (defaults to
    // process.env). A dev shell can carry `ELLAMAKA_DSH=0` (e.g. injected by
    // the wopal desktop launcher), which would flip every case here to
    // `disabled` before any closure work. Pin the flag explicitly so this
    // integration suite always exercises the real mount, regardless of the
    // ambient environment.
    env: { ...process.env, ELLAMAKA_DSH: "1" },
  })
  expect(status).toBe("ready")
  const resolved = resolveInstallAnchor(wopalHome, manifest)
  expect(resolved.path).toBe(anchor)
  const runtime = createDshRuntimeApi(resolved.path)
  const home = join(wopalHome, "dsh")

  const { CordisHub } = await import("@wopal/ellamaka-cordis")
  const { mountDshWeb } = await import("@wopal/ellamaka-cordis/dsh-web")
  const webHub = new CordisHub(null)
  const dsh = await mountDshWeb(webHub.ctx, {
    home,
    port: listener.port,
    logFile: join(home, "dsh-plugins.log"),
    installAnchor: resolved.path,
    runtime,
    // The test runs under bun, which lacks node:module.stripTypeScriptTypes.
    disableCodeRuntime: true,
  })
  const unmount = listener.mountNodeRoute({
    prefix: dsh.mountPath,
    request: (req, res) => dsh.webServer.request(req, res),
    upgrade: (req, socket, head) => dsh.webServer.upgrade(req, socket, head),
  })
  return {
    dsh,
    unmount,
    dispose: async () => {
      unmount()
      await webHub.dispose()
    },
  }
}

/**
 * Establish an authenticated DSH browser session (rc.1 browser-auth). The
 * first visit exchanges the launch-token entry (`/dsh/?token=...`) for a
 * persistent signed cookie (`Set-Cookie: dsh-auth-...; SameSite=Strict`),
 * then the index/API requests carry that cookie. Without the exchange every
 * `/dsh/*` request 401s — this mirrors how the Workbench iframe enters the
 * surface through `authenticatedPath`.
 */
async function dshCookie(dsh: { authenticatedPath: string }, base: string): Promise<string> {
  const res = await fetch(base + dsh.authenticatedPath, { redirect: "manual" })
  expect(res.status).toBe(303)
  const setCookie = res.headers.get("set-cookie")
  expect(setCookie).toBeTruthy()
  return setCookie!.split(";")[0]!
}

/** HTML-attribute URLs in the DSH index are entity-encoded (`&amp;`). */
function htmlAttr(value: string): string {
  return value.replace(/&amp;/g, "&")
}

describe("dsh single-port integration", () => {
  test("serves DSH index, assets, plugins, RPC and Ellamaka API on one port", async () => {
    const listener = await startListener()
    const mount = await mountDsh(listener)
    const base = listener.url.toString().replace(/\/$/, "")
    const cookie = await dshCookie(mount.dsh, base)
    const headers = { authorization: authorization(), cookie }

    try {
      // DSH index under /dsh.
      const index = await fetch(base + "/dsh/", { headers })
      expect(index.status).toBe(200)
      const html = await index.text()
      expect(html).toContain("__DSH_BOOT__")
      expect(html).toContain("/dsh/assets/")

      // DSH static asset under /dsh/assets.
      const assetMatch = html.match(/src="(\/dsh\/assets\/[^"]+)"/)
      expect(assetMatch).not.toBeNull()
      const asset = await fetch(base + htmlAttr(assetMatch![1]), { headers })
      expect(asset.status).toBe(200)

      // DSH plugin bundle under /dsh/plugins.
      const pluginMatch = html.match(/src="(\/dsh\/plugins\/[^"]+)"/)
      expect(pluginMatch).not.toBeNull()
      const plugin = await fetch(base + htmlAttr(pluginMatch![1]), { headers })
      expect(plugin.status).toBe(200)

      // Ellamaka API still served on the same port.
      const ellamaka = await fetch(base + "/global/health", { headers: { authorization: authorization() } })
      expect(ellamaka.status).toBe(200)
    } finally {
      await mount.dispose()
      await listener.stop()
    }
  }, 60_000)

  test("DSH web mount dispose returns /dsh to Ellamaka default 404 while other routes keep working", async () => {
    const listener = await startListener()
    const mount = await mountDsh(listener)
    const base = listener.url.toString().replace(/\/$/, "")
    const cookie = await dshCookie(mount.dsh, base)
    const headers = { authorization: authorization(), cookie }

    try {
      const before = await fetch(base + "/dsh/", { headers })
      expect(before.status).toBe(200)
    } finally {
      await mount.dispose()
    }

    // After dispose, /dsh falls back to Ellamaka default (404).
    const after = await fetch(base + "/dsh/", { headers: { authorization: authorization() } })
    expect(after.status).toBe(404)

    // Other routes keep working.
    const ellamaka = await fetch(base + "/global/health", { headers: { authorization: authorization() } })
    expect(ellamaka.status).toBe(200)

    await listener.stop()
  }, 60_000)

  test("upgrade /dsh/api/remote.mux routes to the DSH downlink and returns 101", async () => {
    const listener = await startListener()
    const mount = await mountDsh(listener)
    const port = listener.port
    const base = listener.url.toString().replace(/\/$/, "")
    const cookie = await dshCookie(mount.dsh, base)

    try {
      const socket = connect(port, "127.0.0.1")
      let response = ""
      socket.on("data", (chunk) => { response += chunk.toString() })
      socket.write(
        "GET /dsh/api/remote.mux HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Cookie: ${cookie}\r\n` +
          `Origin: ${base}\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n" +
          "\r\n",
      )
      // The DSH downlink must accept the upgrade (101) — not fall through to
      // the Ellamaka default or hang. Wait for the handshake response.
      await Promise.race([
        new Promise<void>((resolve) => {
          const check = () => {
            if (response.includes("101")) resolve()
            else setTimeout(check, 20)
          }
          check()
        }),
        once(socket, "close").then(() => {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error("upgrade handshake timed out")), 5000)),
      ])
      expect(response).toContain("101 Switching Protocols")
      expect(response).toContain("Upgrade: websocket")
      socket.destroy()
    } finally {
      await mount.dispose()
      await listener.stop()
    }
  }, 60_000)

  test("EventSource /dsh/plugins/events is served by the DSH HMR downlink", async () => {
    const listener = await startListener()
    const mount = await mountDsh(listener)
    const base = listener.url.toString().replace(/\/$/, "")
    const cookie = await dshCookie(mount.dsh, base)

    try {
      // The client-hmr plugin owns /plugins/events (an EventSource stream).
      // Under the single-port scheme it is served at /dsh/plugins/events.
      const res = await fetch(base + "/dsh/plugins/events", {
        headers: { authorization: authorization(), cookie, accept: "text/event-stream" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream")
      // Read the first chunk to prove the stream is live, then abort.
      const reader = res.body!.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      await reader.cancel()
    } finally {
      await mount.dispose()
      await listener.stop()
    }
  }, 60_000)

  test("rendered /dsh index carries the iframe adapter as an executable <script> node", async () => {
    const listener = await startListener()
    const mount = await mountDsh(listener)
    const base = listener.url.toString().replace(/\/$/, "")
    const cookie = await dshCookie(mount.dsh, base)

    try {
      const index = await fetch(base + "/dsh/", { headers: { authorization: authorization(), cookie } })
      expect(index.status).toBe(200)
      const html = await index.text()
      // The adapter must be injected as a real <script> node (a bare text
      // splice into </head> would not execute in a browser).
      const adapterMatch = html.match(/<script>\(\(\) => \{\n  const prefix = "\/dsh"[\s\S]*?<\/script>/)
      expect(adapterMatch).not.toBeNull()
      const adapterBody = adapterMatch![0].replace(/^<script>/, "").replace(/<\/script>$/, "")
      expect(adapterBody).toContain("const prefix = \"/dsh\"")
      expect(adapterBody).toContain("globalThis.fetch")
    } finally {
      await mount.dispose()
      await listener.stop()
    }
  }, 60_000)
})
