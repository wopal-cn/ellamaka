import type { Page, Route } from "@playwright/test"

const emptyList = new Set([
  "/global/session/status",
  "/skill",
  "/command",
  "/lsp",
  "/formatter",
  "/permission",
  "/question",
  "/vcs/status",
  "/vcs/diff",
])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"])

export interface MockSpace {
  readonly name: string
  readonly displayName?: string
  readonly path: string
  readonly type?: string
}

export interface MockServerConfig {
  provider: unknown
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  events?: () => unknown[]
  /**
   * Registered Spaces served by the Public WopalSpace contract. The fixture
   * answers `/wopal-space/spaces`, `/wopal-space/spaces/resolve`,
   * `/wopal-space/spaces/:name/files` and the file content route from here.
   */
  spaces?: readonly MockSpace[]
  /** Official App BFF session-tree/locations override; defaults derive from `sessions`. */
  sessionTree?: unknown
  locations?: unknown
}

type TreeSession = {
  id: string
  title: string
  directory: string
  marker: "directory" | "worktree" | ""
  directoryHealth: string
  timeCreated: number
  timeUpdated: number
}

/** Minimal registry entry shape returned by the Public WopalSpace Space API. */
function publicSpace(space: MockSpace) {
  return {
    name: space.name,
    displayName: space.displayName ?? space.name,
    path: space.path,
    branch: "space/" + space.name,
    type: space.type ?? "local",
  }
}

/** SpaceListResult adds read-only disk facts to each registry entry. */
function publicSpaceItem(space: MockSpace) {
  return {
    ...publicSpace(space),
    facts: { present: true, snapshot: "ok", worktree: true, mismatch: [] },
  }
}

function treeSession(session: { id: string } & Record<string, unknown>): TreeSession {
  const time = (session.time ?? {}) as { created?: number; updated?: number }
  return {
    id: session.id,
    title: typeof session.title === "string" ? session.title : session.id,
    directory: typeof session.directory === "string" ? session.directory : "",
    marker: "directory",
    directoryHealth: "healthy",
    timeCreated: time.created ?? 0,
    timeUpdated: time.updated ?? 0,
  }
}

/**
 * Route the Ellamaka Server surface the Workbench actually consumes: Runtime
 * paths as before, plus the Public WopalSpace contract and the App BFF
 * projections. Unknown operations are refused instead of answered with `{}`,
 * so a contract drift fails the test instead of silently rendering nothing.
 */
export async function mockOpenCodeServer(page: Page, config: MockServerConfig) {
  const staticRoutes: Record<string, unknown> = {
    "/provider": config.provider,
    "/path": {
      state: config.directory,
      config: config.directory,
      worktree: config.directory,
      directory: config.directory,
      home: "C:/OpenCode",
    },
    "/project": [config.project],
    "/project/current": config.project,
    "/agent": [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessions,
  }
  const spaces = config.spaces ?? []

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const requestPath = url.pathname
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    if (url.port !== targetPort) return route.fallback()
    if (requestPath === "/wopal-space/setup/inspect") {
      return json(route, {
        home: { binding: { locked: true } },
        state: { status: "ok", completed: true, currentStep: "done", steps: {} },
      })
    }
    if (requestPath === "/global/event" || requestPath === "/event") return sse(route, config.events?.())
    if (requestPath === "/global/health") return json(route, { healthy: true })
    if (requestPath.startsWith("/global/session/") && requestPath !== "/global/session/status") {
      const id = requestPath.slice("/global/session/".length)
      return json(route, config.sessions.find((session) => session.id === id) ?? null)
    }
    if (emptyObject.has(requestPath)) return json(route, {})
    if (emptyList.has(requestPath)) return json(route, [])

    // ── Public WopalSpace contract ────────────────────────────────────────
    if (requestPath === "/wopal-space/mode") return json(route, { isWopalSpace: spaces.length > 0 })
    if (requestPath === "/wopal-space/spaces")
      return json(route, { items: spaces.map(publicSpaceItem), total: spaces.length })
    if (requestPath === "/wopal-space/spaces/resolve") {
      // space.resolve is a POST whose payload carries the directory or name.
      const payload = resolvePayload(route.request().postData())
      const space = payload.directory
        ? spaces.find((item) => item.path === payload.directory)
        : spaces.find((item) => item.name === payload.name)
      if (!space) {
        const requested = payload.directory ?? payload.name ?? ""
        return json(route, { code: "SPACE_NOT_FOUND", message: "Unknown Space " + requested }, 404)
      }
      return json(route, {
        name: space.name,
        path: space.path,
        space: publicSpace(space),
        source: payload.directory ? "directory" : "name",
      })
    }
    const spaceFiles = requestPath.match(/^\/wopal-space\/spaces\/([^/]+)\/files$/)
    if (spaceFiles) {
      const name = decodeURIComponent(spaceFiles[1])
      const space = spaces.find((item) => item.name === name)
      if (!space) return json(route, { code: "SPACE_NOT_FOUND", message: "Unknown Space " + name }, 404)
      const root = url.searchParams.get("path") ?? ""
      const file = { name: "README.md", path: "README.md", absolute: space.path + "/README.md", type: "file" }
      return json(route, { items: root === "" || root === "." ? [file] : [], total: 1 })
    }
    const spaceFileContent = requestPath.match(/^\/wopal-space\/spaces\/([^/]+)\/files\/content$/)
    if (spaceFileContent) {
      const name = decodeURIComponent(spaceFileContent[1])
      const space = spaces.find((item) => item.name === name)
      if (!space) return json(route, { code: "SPACE_NOT_FOUND", message: "Unknown Space " + name }, 404)
      if (url.searchParams.get("path") !== "README.md") {
        return json(route, { code: "SPACE_FILE_NOT_FOUND", message: "Unknown file" }, 404)
      }
      return json(route, { type: "text", content: "File browsing without a session runtime" })
    }

    // ── Official App BFF projections ──────────────────────────────────────
    if (requestPath === "/config-v2") {
      return json(route, {
        effective: { ellamaka: {}, wopal: { dsh: { web: { enabled: false } }, pluginConfig: {} } },
      })
    }
    // The private BFF is fixed to createSession/sessionTree/locations/dshEntry;
    // Runtime status and session metadata come from the public Runtime routes.
    if (requestPath === "/workbench/session-tree") {
      return json(route, config.sessionTree ?? defaultSessionTree(config.sessions, spaces))
    }
    if (requestPath === "/workbench/locations") {
      return json(route, config.locations ?? { scopePath: url.searchParams.get("spacePath") ?? "", items: [] })
    }
    // WorkbenchDshUrlResponse is a struct with an optional url, not a bare null.
    if (requestPath === "/workbench/dsh-url") return json(route, {})

    if (requestPath in staticRoutes) return json(route, staticRoutes[requestPath])

    const projectMatch = requestPath.match(/^\/project\/([^/]+)$/)
    if (projectMatch && route.request().method() === "PATCH") {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Playwright config fixture is external input
      const project = config.project as { id?: string }
      if (project.id !== decodeURIComponent(projectMatch[1])) return json(route, {})
      return json(route, config.project)
    }

    const sessionMatch = requestPath.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      const session = config.sessions.find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(requestPath)) return json(route, [])

    const messagesMatch = requestPath.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const limit = Number(url.searchParams.get("limit") ?? 80)
      const before = url.searchParams.get("before") ?? undefined
      const pageData = config.pageMessages(messagesMatch[1], limit, before)
      // Cursor headers are the fourth argument: the third one is the status.
      const headers = pageData.cursor ? { "x-next-cursor": pageData.cursor } : undefined
      return json(route, pageData.items, 200, headers)
    }

    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "E2E_UNMOCKED_ROUTE", message: "No fixture for " + requestPath }),
    })
  })
}

type ResolvePayload = { directory?: string; name?: string }

/** Body of POST /wopal-space/spaces/resolve; a malformed body resolves to nothing. */
function resolvePayload(body: string | null): ResolvePayload {
  if (!body) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  // Narrow through the declared payload type instead of asserting the object.
  return {
    ...("directory" in parsed && typeof parsed.directory === "string" ? { directory: parsed.directory } : {}),
    ...("name" in parsed && typeof parsed.name === "string" ? { name: parsed.name } : {}),
  } satisfies ResolvePayload
}

/** General first, then every registered Space even when it has no sessions. */
function defaultSessionTree(sessions: MockServerConfig["sessions"], spaces: readonly MockSpace[]) {
  return {
    scopes: spaces.map((space) => {
      const items = sessions.filter((session) =>
        typeof session.directory === "string" ? session.directory.startsWith(space.path + "/") : false,
      )
      return {
        key: space.path,
        kind: "space",
        name: space.displayName ?? space.name,
        path: space.path,
        sessionCount: items.length,
        truncated: false,
        locations: [
          {
            key: space.path,
            kind: "space-root",
            name: space.displayName ?? space.name,
            path: space.path,
            sessionCount: items.length,
            sessions: items.map(treeSession),
          },
        ],
      }
    }),
  }
}

function json(route: Route, body: unknown, status = 200, headers?: Record<string, string>) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[]) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n",
  })
}
