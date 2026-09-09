import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { connect } from "node:net"
import { Context } from "@deepseek-ai/cordis"
import {
  bootDshWeb,
  migrateToolsProfileApprovalPatch,
  mountDshWeb,
  mountDshTools,
} from "../src/dsh-web"

/** Attach a VirtualWebServer to a raw server and return its base URL. */
async function attachAndListen(webServer: { attach(server: Server): void }) {
  const server = createServer()
  webServer.attach(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

/**
 * Run the official browser-auth flow against a virtually mounted host: GET the
 * authenticated entry URL (the token exchange), assert the 303 and its
 * mount-prefixed Location, and return the minted signed cookie for follow-up
 * requests. `baseUrl + query` mirrors the Ellamaka listener mounting the
 * VirtualWebServer under /dsh — the mount strips the prefix, so the exchange
 * lands on the webserver's index as `/?token=...`.
 */
async function loginCookie(baseUrl: string, authenticatedPath: string): Promise<string> {
  const entry = new URL(authenticatedPath, "http://dsh.invalid")
  const res = await fetch(baseUrl + entry.search, { redirect: "manual" })
  expect(res.status).toBe(303)
  expect(res.headers.get("location")).toBe("/dsh/")
  const setCookie = res.headers.get("set-cookie")
  expect(setCookie).toBeDefined()
  expect(setCookie).toContain("HttpOnly")
  return setCookie!.split(";")[0]!
}

/**
 * Run a browser script in an isolated VM with fake fetch/WebSocket/EventSource.
 */
function runInIsolatedVm(script: string, calls: { fetch: unknown[]; ws: unknown[]; es: unknown[] }) {
  const sandbox = {
    fetch: (...args: unknown[]) => {
      calls.fetch.push(args)
      return Promise.resolve({ ok: true })
    },
    WebSocket: class {
      constructor(...args: unknown[]) {
        calls.ws.push(args)
      }
    },
    EventSource: class {
      constructor(...args: unknown[]) {
        calls.es.push(args)
      }
    },
    console,
  }
  const vm = require("node:vm")
  vm.runInNewContext(script, sandbox)
  return sandbox
}

/**
 * A per-call session fake carrying the rc.1 session face the sandbox chain
 * reads: `snapshotEvents(fromSeq, toSeqExclusive)` for the sandbox-mode
 * projection (LAST-wins over the seeded `events`), plus `append` and the seq
 * accessors the audit-pair appends rely on. Mirrors the official tool-fs test
 * fake's shape.
 */
function makeSessionFake(id: string, cwd: string, seeded: { type: string; data: Record<string, unknown> }[] = []) {
  const events: { type: string; seq: number; time: number; data: Record<string, unknown> }[] = seeded.map(
    (record, index) => ({ type: record.type, seq: index, time: index, data: record.data ?? {} }),
  )
  return {
    header: { id, cwd },
    get seq() {
      return events.length
    },
    eventAt: (seq: number) => events[seq],
    snapshotEvents: (fromSeq = 0, toSeqExclusive = events.length) => events.slice(fromSeq, toSeqExclusive),
    append: (type: string, data: Record<string, unknown>) => {
      const event = { type, seq: events.length, time: events.length, data }
      events.push(event)
      return event
    },
    events,
  }
}

/**
 * Mount the dsh web engine virtually: the official web profile registers its
 * routes on a VirtualWebServer instead of a second listening socket (final
 * scheme, DESIGN-dsh-poc §2.1). Uses a temp DSH_HOME so the test never touches
 * the user's ~/.dsh.
 */
describe("dsh web engine", () => {
  test("mountDshWeb activates the web profile without creating a listening socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-host-"))
    const ctx = new Context()
    const host = await mountDshWeb(ctx, {
      home,
      port: 4097,
      disableCodeRuntime: true,
      ellamakaCommand: [process.execPath],
    })

    try {
      // The virtual host reports the Ellamaka public address and mount path.
      expect(host.mountPath).toBe("/dsh")
      expect(host.webServer.host).toBe("127.0.0.1")
      expect(host.webServer.port).toBe(4097)

      // The official web profile registered its routes on the VirtualWebServer.
      const { server, baseUrl } = await attachAndListen(host.webServer)
      try {
      // rc.1 browser-auth: a tokenless index request is 401; the launch-token
      // entry URL exchanges the token for a signed cookie (official flow).
      const unauth = await fetch(baseUrl + "/", { redirect: "manual" })
      expect(unauth.status).toBe(401)

      // The handle exposes the authenticated iframe entry path with a token.
      const entry = new URL(host.authenticatedPath, "http://dsh.invalid")
      expect(entry.pathname).toBe("/dsh/")
      expect(entry.searchParams.get("token")).toBeTruthy()

      const cookie = await loginCookie(baseUrl, host.authenticatedPath)

      // The minted cookie serves the index; static asset URLs carry /dsh and
      // the manifest link stays dropped.
      const root = await fetch(baseUrl + "/", { headers: { cookie } })
      expect(root.status).toBe(200)
      const html = await root.text()
      expect(html).toContain("__DSH_BOOT__")
      expect(html).toContain("/dsh/assets/")
      expect(html).toContain("/dsh/favicon.svg")
      expect(html).not.toContain("manifest.webmanifest")

      // The /api RPC channel routes through the virtual server once the
      // cookie rides along (the official Host/Origin fence + browserAuth).
      // rc.1 ships no host.describe (ApiProxy removed); the exact Fetch route
      // /api/session.export answers 400 on a missing sessionId — any server
      // answer other than 401/403/404 proves the authenticated path reaches
      // the route owner.
      const rpc = await fetch(baseUrl + "/api/session.export", { headers: { cookie } })
      expect(rpc.status).toBe(400)
      } finally {
        server.close()
      }

      // The SHIPPED agent-preset root is assembled, so the default `standard`
      // preset is discoverable.
      const presets = await ctx.agentPresets.list()
      expect(presets.map((p) => p.id)).toContain("standard")

      // A3: the install-worker contract services are provided on the web
      // container before the Loader mounts plugin rows, so dshmarket's
      // `apply()` probe sees desktopProfiles and takes its Desktop path
      // (which calls desktopPnpm.runPlugin instead of spawning the CLI).
      const desktopProfiles = ctx.get("desktopProfiles") as
        | { current: { name: string; dir: string } }
        | undefined
      expect(desktopProfiles).toBeDefined()
      expect(desktopProfiles!.current.name).toBe("web")
      expect(desktopProfiles!.current.dir).toBe(join(home, "home", "profiles", "web"))
      const desktopPnpm = ctx.get("desktopPnpm") as { runPlugin?: unknown } | undefined
      expect(desktopPnpm).toBeDefined()
      expect(typeof desktopPnpm!.runPlugin).toBe("function")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("mountDshWeb with an explicit installAnchor discovers presets from that closure", async () => {
    // Packaged-CLI scheme: the anchor lives in the materialised closure under
    // the dsh home, not in the module graph (DESIGN-dsh-poc §2.2). The preset
    // roster itself is bundled inside @deepseek-ai/dsh-agent-presets (rc.1);
    // this test pins that the mounted roster resolves from the mount's own
    // closure and carries the shipped `standard` preset.
    const home = mkdtempSync(join(tmpdir(), "dsh-host-anchor-"))
    const req = createRequire(import.meta.url)
    const anchor = req.resolve("@deepseek-ai/dsh/package.json")
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, installAnchor: anchor, disableCodeRuntime: true })

    try {
      const presets = await ctx.agentPresets.list()
      const standard = presets.find((p) => p.id === "standard")
      expect(standard).toBeDefined()
      // rc.1 bundles the shipped roster inside dsh-agent-presets; the shipped
      // set must come from that package, not an anchor-relative directory.
      expect(standard!.path.includes("@deepseek-ai/dsh-agent-presets")).toBe(true)
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("bootDshWeb owns a fresh context and disposes it", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-host-"))
    const host = await bootDshWeb({ home, port: 4097, disableCodeRuntime: true })

    try {
      expect(host.mountPath).toBe("/dsh")
      const { server, baseUrl } = await attachAndListen(host.webServer)
      try {
        const cookie = await loginCookie(baseUrl, host.authenticatedPath)
        const root = await fetch(baseUrl + "/", { headers: { cookie } })
        expect(root.status).toBe(200)
      } finally {
        server.close()
      }
    } finally {
      await host.dispose()
    }
  }, 30_000)

  test("mountDshWeb injects the iframe adapter as a real <script> node that executes", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-host-"))
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, disableCodeRuntime: true })

    try {
      const { server, baseUrl } = await attachAndListen(host.webServer)
      try {
        // The rendered index must carry the adapter inside a <script> node, not
        // as a bare text splice (a bare splice would not execute in a browser).
        const cookie = await loginCookie(baseUrl, host.authenticatedPath)
        const root = await fetch(baseUrl + "/", { headers: { cookie } })
        const html = await root.text()
        const adapterMatch = html.match(/<script>\(\(\) => \{\n  const prefix = "\/dsh"[\s\S]*?<\/script>/)
        expect(adapterMatch).not.toBeNull()
        const adapterBody = adapterMatch![0].replace(/^<script>/, "").replace(/<\/script>$/, "")
        expect(adapterBody).toContain("const prefix = \"/dsh\"")
        expect(adapterBody).toContain("globalThis.fetch")

        // Extract the adapter body and run it in an isolated VM with fake
        // fetch/WebSocket/EventSource, then drive the wrapped calls to prove
        // the injected script actually adapts same-origin URLs to /dsh.
        const calls = { fetch: [], ws: [], es: [] }
        runInIsolatedVm(
          adapterBody +
            `;fetch("/api/x"); new WebSocket("/api/events.mux"); new EventSource("/plugins/events");`,
          calls,
        )
        expect(calls.fetch[0][0]).toBe("/dsh/api/x")
        expect(calls.ws[0][0]).toBe("/dsh/api/events.mux")
        expect(calls.es[0][0]).toBe("/dsh/plugins/events")
      } finally {
        server.close()
      }
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("mountDshWeb dispose closes upgrade sockets dispatched through the virtual webserver", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-host-"))
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, disableCodeRuntime: true })

    const { server, baseUrl } = await attachAndListen(host.webServer)
    const port = (server.address() as { port: number }).port
    let socketClosed = false
    try {
      // rc.1 upgrade surface: the official mux lives at /api/remote.mux behind
      // browserAuth, so this test mounts its own upgrade route on the virtual
      // webserver — the invariant under test is "any socket dispatched through
      // the VirtualWebServer is closed on host dispose", not the official
      // route's protocol.
      host.webServer.registerUpgrade({
        path: "/test/events.mux",
        handler: (req, socket) => {
          socket.once("close", () => { socketClosed = true })
        },
      })
      const socket = connect(port, "127.0.0.1")
      socket.once("close", () => { socketClosed = true })
      socket.write(
        "GET /test/events.mux HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "\r\n",
      )
      await once(socket, "connect")
      // Give the upgrade dispatch a tick to register the socket.
      await new Promise((r) => setTimeout(r, 20))
      expect(socketClosed).toBe(false)

      // Host dispose must close the upgraded socket (D-12 / DESIGN §2.1 item 10).
      // The VirtualWebServer is disposed FIRST in the handle's dispose chain,
      // so the socket close — the invariant under test — lands while the
      // loader teardown is still settling; await the close first, then the
      // full dispose.
      const disposePromise = host.dispose()
      await once(socket, "close")
      expect(socketClosed).toBe(true)
      await disposePromise
    } finally {
      server.close()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("mountDshWeb writes dsh plugin logs to the dedicated log file", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-host-"))
    const logFile = join(home, "dsh-plugins.log")
    const ctx = new Context()
    const host = await mountDshWeb(ctx, { home, port: 4097, logFile, disableCodeRuntime: true })

    try {
      // The dsh engine boots a webServer service; its startup logs should
      // land in the dedicated file via the registered Exporter.
      const { server, baseUrl } = await attachAndListen(host.webServer)
      try {
        const cookie = await loginCookie(baseUrl, host.authenticatedPath)
        const root = await fetch(baseUrl + "/", { headers: { cookie } })
        expect(root.status).toBe(200)
      } finally {
        server.close()
      }
      // Emit a log through the host context's logger — the Exporter routes it
      // to the dedicated file (dsh plugins log via the same ctx.logger path).
      ctx.logger("dsh-web-test").info("exporter probe")
      // Give the async Exporter a tick to flush.
      await new Promise((r) => setTimeout(r, 200))
      const content = readFileSync(logFile, "utf-8")
      expect(content).toContain("exporter probe")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)
})

/**
 * The tool-container profile: a dedicated dsh profile for ellamaka's direct
 * tool adoption. It initializes a user-editable profile entry whose patch
 * layer disables the agent-loop-only plugins, so tools execute with a
 * lightweight per-call context without live dsh sessions.
 */
describe("dsh tools profile", () => {
  test("approval patch migration removes only the obsolete host row", () => {
    const input = [
      "# user comment",
      "- { id: user-questions, disabled: true }",
      "- { id: approval, disabled: true }",
      "- { id: custom-plugin, disabled: true }",
      "",
    ].join("\n")

    expect(migrateToolsProfileApprovalPatch(input)).toBe(
      [
        "# user comment",
        "- { id: user-questions, disabled: true }",
        "- { id: custom-plugin, disabled: true }",
        "",
      ].join("\n"),
    )
  })

  test("mountDshTools migrates a persisted legacy profile and composes approval", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const seedCtx = new Context()
    const seedHost = await mountDshTools(seedCtx, { home, port: 0 })
    await seedHost.dispose()
    await seedCtx.fiber.dispose()

    const patchPath = join(home, "home", "profiles", "ellamaka-tools", "cordis.patch.yml")
    const current = readFileSync(patchPath, "utf-8")
    writeFileSync(patchPath, `${current}\n- { id: approval, disabled: true }\n# user-tail\n`)

    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })
    try {
      expect(readFileSync(patchPath, "utf-8")).not.toContain("id: approval, disabled: true")
      expect(readFileSync(patchPath, "utf-8")).toContain("# user-tail")
      expect(ctx.get("approval")).toBeDefined()
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  test("mountDshTools mounts the tool profile on a context and disposes cleanly", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const tools = ctx.get("tools") as { schemas(): { name: string }[] }
      const names = tools.schemas().map((t) => t.name)
      expect(names).toContain("grep")
      expect(names).toContain("glob")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("mountDshTools disables session-checkpoint-policy via the profile patch layer", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const ws = mkdtempSync(join(tmpdir(), "dsh-tools-ws-"))
      for (let i = 0; i < 400; i++) {
        writeFileSync(join(ws, `f${i}.txt`), `needle line ${i}\n`)
      }

      const tools = ctx.get("tools") as {
        execute(exec: unknown): Promise<{ isError: boolean; content?: { type: string; text?: string }[] }>
      }
      const facade = { session: { header: { id: `tools-${Date.now()}`, cwd: ws } } }
      const result = await tools.execute({
        callId: "tools-profile-call",
        name: "grep",
        arguments: { pattern: "needle", path: ws },
        signal: new AbortController().signal,
        agent: facade,
      })
      const text = (result.content ?? []).map((b) => b.text ?? "").join("\n")
      expect(result.isError).toBe(false)
      expect(text).toContain("250 of 400")

      // No live session was created.
      const sessions = ctx.get("sessions") as { list(): unknown[] } | undefined
      expect(sessions?.list() ?? []).toEqual([])
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  test("mountDshTools runs read, write, and edit through the sandboxed filesystem", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const workspace = mkdtempSync(join(tmpdir(), "dsh-tools-ws-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const tools = ctx.get("tools") as {
        schemas(): { name: string }[]
        execute(exec: unknown): Promise<{
          isError: boolean
          error?: { info?: { code?: string } }
        }>
      }
      const session = makeSessionFake("tools-fs-session", workspace)
      const execute = (name: string, arguments_: Record<string, unknown>) =>
        tools.execute({
          callId: `tools-fs-${name}`,
          name,
          arguments: arguments_,
          signal: new AbortController().signal,
          agent: { session },
        })

      expect((ctx.get("fs") as { sandboxMode?: string }).sandboxMode).toBe("workspace-write")
      expect(tools.schemas().map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "write", "edit"]))

      expect((await execute("write", { file_path: "created.txt", content: "created" })).isError).toBe(false)
      expect((await execute("read", { file_path: "created.txt" })).isError).toBe(false)

      writeFileSync(join(workspace, "edit.txt"), "before")
      const unreadEdit = await execute("edit", { file_path: "edit.txt", old_string: "before", new_string: "after" })
      expect(unreadEdit.isError).toBe(true)
      expect(unreadEdit.error?.info?.code).toBe("FS_NOT_OBSERVED")

      expect((await execute("read", { file_path: "edit.txt" })).isError).toBe(false)
      expect((await execute("edit", { file_path: "edit.txt", old_string: "before", new_string: "after" })).isError).toBe(false)
      expect(readFileSync(join(workspace, "edit.txt"), "utf-8")).toBe("after")

      const denied = await execute("write", {
        file_path: join(homedir(), `.dsh-tools-denied-${Date.now()}.txt`),
        content: "denied",
      })
      expect(denied.isError).toBe(true)
      expect(denied.error?.info?.code).toBe("FS_SANDBOX_DENIED")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  test("read-only session mode denies write inside the workspace", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const workspace = mkdtempSync(join(tmpdir(), "dsh-tools-readonly-ws-"))
    const target = join(workspace, "forbidden.txt")
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const tools = ctx.get("tools") as {
        execute(exec: unknown): Promise<{
          isError: boolean
          error?: { info?: { code?: string } }
        }>
      }
      const session = makeSessionFake("tools-readonly-session", workspace, [{ type: "sandbox/mode", data: { mode: "read-only" } }])
      const result = await tools.execute({
        callId: "tools-readonly-write",
        name: "write",
        arguments: { file_path: target, content: "must not exist" },
        signal: new AbortController().signal,
        agent: { session },
      })

      expect(result.isError).toBe(true)
      expect(result.error?.info?.code).toBe("FS_SANDBOX_DENIED")
      expect(existsSync(target)).toBe(false)
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  test("mountDshTools runs str_replace_editor through the sandboxed filesystem", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const workspace = mkdtempSync(join(tmpdir(), "dsh-tools-editor-ws-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const tools = ctx.get("tools") as {
        schemas(): { name: string }[]
        execute(exec: unknown): Promise<{
          isError: boolean
          content?: { type: string; text?: string }[]
          error?: { info?: { code?: string } }
        }>
      }
      const session = makeSessionFake("tools-editor-session", workspace)
      let call = 0
      const execute = (arguments_: Record<string, unknown>) =>
        tools.execute({
          callId: `tools-editor-${++call}`,
          name: "str_replace_editor",
          arguments: arguments_,
          signal: new AbortController().signal,
          agent: { session },
        })
      const editorPath = join(workspace, "editor.txt")

      expect(tools.schemas().map((tool) => tool.name)).toContain("str_replace_editor")
      expect((await execute({ command: "create", path: editorPath, file_text: "one\ntwo" })).isError).toBe(false)
      expect((await execute({ command: "view", path: editorPath })).isError).toBe(false)
      expect((await execute({ command: "str_replace", path: editorPath, old_str: "two", new_str: "TWO" })).isError).toBe(false)
      expect((await execute({ command: "insert", path: editorPath, insert_line: 1, new_str: "between" })).isError).toBe(false)
      expect(readFileSync(editorPath, "utf-8")).toBe("one\nbetween\nTWO")

      writeFileSync(join(workspace, "unseen.txt"), "before")
      const unseen = await execute({ command: "str_replace", path: join(workspace, "unseen.txt"), old_str: "before", new_str: "after" })
      expect(unseen.isError).toBe(true)
      expect(unseen.error?.info?.code).toBe("FS_NOT_OBSERVED")
      expect((await execute({ command: "view", path: "relative.txt" })).isError).toBe(true)

      const denied = await execute({
        command: "create",
        path: join(homedir(), `.dsh-tools-editor-denied-${Date.now()}.txt`),
        file_text: "denied",
      })
      expect(denied.isError).toBe(true)
      expect(denied.error?.info?.code).toBe("FS_SANDBOX_DENIED")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  // Parameterized across sandbox modes: `workspace-write` confines the
  // container's bash to the workspace (external writes denied), while
  // `danger-full-access` (the adapter's "sandbox off" mapping, DESIGN §4.10)
  // lets the same tool write outside the workspace. Both run in the real
  // tool container — only the facade `sandbox/mode` event differs.
  test.each([
    { name: "workspace-write", mode: "workspace-write", outside: "denied" },
    { name: "danger-full-access", mode: "danger-full-access", outside: "allowed" },
  ])("mountDshTools runs foreground bash under $name sandbox mode", async ({ mode, outside }) => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const workspace = mkdtempSync(join(tmpdir(), "dsh-tools-bash-ws-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const tools = ctx.get("tools") as {
        schemas(): { name: string; parameters: { properties: Record<string, unknown> } }[]
        execute(exec: unknown): Promise<{
          isError: boolean
          content?: { type: string; text?: string }[]
        }>
      }
      const session = makeSessionFake("tools-bash-session", workspace, [{ type: "sandbox/mode", data: { mode } }])
      let call = 0
      const execute = (arguments_: Record<string, unknown>) =>
        tools.execute({
          callId: `tools-bash-${++call}`,
          name: "bash",
          arguments: arguments_,
          signal: new AbortController().signal,
          agent: { session },
        })
      const allowed = join(workspace, "allowed.txt")
      const bash = tools.schemas().find((tool) => tool.name === "bash")

      expect(tools.schemas().map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["read", "write", "edit", "grep", "glob", "bash", "str_replace_editor"]),
      )
      expect((ctx.get("shell") as { sandboxMode?: string }).sandboxMode).toBe("workspace-write")
      expect(ctx.get("shellEnv")).toBeDefined()
      expect(bash).toBeDefined()
      expect(bash?.parameters.properties).not.toHaveProperty("run_in_background")
      const pwd = await execute({ command: "pwd", description: "Print sandbox workspace directory" })
      expect((pwd.content ?? []).map((block) => block.text ?? "").join("\n")).toContain(workspace)
      expect((await execute({ command: `printf bash-ok > "${allowed}"`, description: "Write sandbox proof file" })).isError).toBe(false)
      expect(readFileSync(allowed, "utf-8")).toBe("bash-ok")

      // homedir is used (not /tmp) because dsh's `workspace-write` sandbox
      // allows host /tmp but denies homedir — so the external write probe is
      // only denied under `workspace-write` and only allowed under
      // `danger-full-access`.
      const outsidePath = join(homedir(), `.dsh-tools-bash-${mode}-${Date.now()}.txt`)
      const result = await execute({ command: `printf outside > "${outsidePath}"`, description: "Write outside the workspace" })
      if (outside === "denied") {
        expect(result.isError).toBe(false)
        expect((result.content ?? []).map((block) => block.text ?? "").join("\n")).toContain(
          "[sandbox: file access denied under workspace-write mode]",
        )
      } else {
        expect(result.isError).toBe(false)
        expect(readFileSync(outsidePath, "utf-8")).toBe("outside")
      }
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 60_000)

  // Task 2 (Plan feature-dsh-dsh-escalation-approval-bridge-and-sandbox-mode-ui):
  // the approval plugin is re-enabled in the tool container so dsh's native
  // escalation choreography runs against a per-call facade. The host (adapter
  // / assembly layer) bridges `approval/request` to ellamaka Permission; these
  // tests verify the container side: service presence, the end-to-end ask flow
  // through a registered answerer, and the deterministic `never` short-circuit.
  test("mountDshTools composes the approval service into the tool container", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const approval = ctx.get("approval") as { request(req: unknown): Promise<string> } | undefined
      expect(approval).toBeDefined()
      expect(typeof approval?.request).toBe("function")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("mountDshTools resolves escalation through an approval/request answerer", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const workspace = mkdtempSync(join(tmpdir(), "dsh-tools-esc-ws-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const approval = ctx.get("approval") as { request(req: unknown): Promise<string> }
      expect(approval).toBeDefined()

      // The host-side answerer: resolve everything as allowed-once.
      ctx.on("approval/request", (_req, next) => {
        void next
        return Promise.resolve("allowed-once")
      })

      const session = makeSessionFake("esc-session-1", workspace, [
        { type: "sandbox/mode", data: { mode: "workspace-write" } },
        { type: "turn/start", data: {} },
      ])
      // ApproveEscalation's ordered fail-closed sequence: the strictly-wider
      // check passes (workspace-write -> danger-full-access), the approval
      // channel resolves, the answerer maps to allowed-once, and the granted
      // mode comes back.
      const granted = await approval.request({
        agent: { session },
        toolName: "bash",
        callId: "esc-call-1",
        reason: "escalate sandbox to danger-full-access: write outside the workspace",
        signal: new AbortController().signal,
      })
      expect(granted).toBe("allowed-once")

      // The audit pair landed on the facade inside the open turn.
      const types = session.events.map((event: { type: string }) => event.type)
      expect(types).toContain("approval/asked")
      expect(types).toContain("approval/decided")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("mountDshTools rejects escalation without an open turn (fail-closed precondition)", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const workspace = mkdtempSync(join(tmpdir(), "dsh-tools-esc-ws2-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const approval = ctx.get("approval") as { request(req: unknown): Promise<string> }
const session = makeSessionFake("esc-session-2", workspace, [{ type: "sandbox/mode", data: { mode: "workspace-write" } }])
      // No turn/start: the service must refuse before appending anything.
      await expect(
        approval.request({
          agent: { session },
          toolName: "bash",
          callId: "esc-call-2",
          reason: "escalate sandbox to danger-full-access: no turn",
        }),
      ).rejects.toThrow("outside an open turn")
      expect(session.events.map((event: { type: string }) => event.type)).not.toContain("approval/asked")
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)

  test("mountDshTools never policy rejects escalation before answerer dispatch", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-tools-host-"))
    const workspace = mkdtempSync(join(tmpdir(), "dsh-tools-esc-ws3-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home, port: 0 })

    try {
      const approval = ctx.get("approval") as { request(req: unknown): Promise<string> }
      let answered = 0
      ctx.on("approval/request", (_req, next) => {
        answered += 1
        void next
        return Promise.resolve("allowed-once")
      })

      // The adapter seeds the policy override for `escalation: "never"`:
      // the LAST approval/policy event is the session's effective policy.
      const session = makeSessionFake("esc-session-3", workspace, [
        { type: "sandbox/mode", data: { mode: "workspace-write" } },
        { type: "approval/policy", data: { policy: "never" } },
        { type: "turn/start", data: {} },
      ])
      const outcome = await approval.request({
        agent: { session },
        toolName: "bash",
        callId: "esc-call-3",
        reason: "escalate sandbox to danger-full-access: never policy",
      })
      expect(outcome).toBe("rejected")
      // Service-level short-circuit: no answerer saw the ask.
      expect(answered).toBe(0)
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
    }
  }, 30_000)
})
