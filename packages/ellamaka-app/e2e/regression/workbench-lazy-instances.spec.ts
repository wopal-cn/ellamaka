import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

const roots = ["/fixtures/alpha", "/fixtures/beta", "/fixtures/empty"]
const capturedRequests = new Map<Page, Array<{ path: string; directory: string }>>()
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) {
    console.log(
      "Runtime requests:",
      JSON.stringify(capturedRequests.get(page)?.filter((x) => instancePaths.test(x.path))),
    )
  }
  await info.attach("runtime-requests", {
    body: JSON.stringify(capturedRequests.get(page) ?? [], null, 2),
    contentType: "application/json",
  })
  capturedRequests.delete(page)
})
const tabs = roots.map((path, index) => ({
  id: `space-${index}`,
  name: ["Alpha", "Beta", "Empty"][index],
  path,
  type: "space",
}))
const sessions = [
  { id: "ses_alpha", title: "Alpha opened on demand", directory: `${roots[0]}/project` },
  { id: "ses_history", title: "History stays cold", directory: `${roots[0]}/historical` },
  { id: "ses_beta", title: "Beta restored on visit", directory: `${roots[1]}/project` },
].map((session) => ({
  ...session,
  projectID: "proj_fixture",
  slug: session.id,
  version: "dev",
  time: { created: 1700000000000, updated: 1700000000000 },
}))

async function setup(page: Page, initialBound: boolean, withCachedMessages = false) {
  const requests: Array<{ path: string; directory: string }> = []
  capturedRequests.set(page, requests)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockOpenCodeServer(page, {
    directory: roots[0],
    project: { id: "proj_fixture", worktree: roots[0], time: { created: 1 }, sandboxes: [] },
    provider: {
      all: [
        {
          id: "test",
          name: "Test",
          models: { model: { id: "model", name: "Fixture model", limit: { context: 200000 } } },
        },
      ],
      connected: ["test"],
      default: { test: "model" },
    },
    sessions,
    pageMessages: (sessionID) => ({ items: withCachedMessages ? [cachedMessage(sessionID)] : [] }),
    events: () => [{ directory: "global", payload: { id: "connected", type: "server.connected", properties: {} } }],
  })
  await page.route("**/*", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.startsWith("/dsh/")) return route.fulfill({ status: 200, contentType: "text/html", body: "" })
    if (url.port !== (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) return route.fallback()
    const directory =
      url.searchParams.get("directory") ?? decodeURIComponent(request.headers()["x-opencode-directory"] ?? "")
    requests.push({ path: url.pathname, directory })
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
    if (url.pathname === "/global/health") return json({ healthy: true, dsh: false, cli: { state: "ok" } })
    if (url.pathname === "/wopal-space/spaces") return json({ spaces: tabs })
    if (url.pathname === "/wopal-space/mode") return json({ isWopalSpace: true })
    if (url.pathname === "/path")
      return json({ state: directory, config: directory, worktree: directory, directory, home: "/fixtures/home" })
    if (url.pathname === "/workbench/session-statuses")
      return json([{ directory: sessions[1].directory, sessionID: sessions[1].id, status: { type: "busy" } }])
    if (url.pathname === "/workbench/session-tree")
      return json({
        scopes: tabs.map((tab) => {
          const items = sessions.filter((s) => s.directory.startsWith(tab.path + "/"))
          return {
            key: tab.path,
            kind: "space",
            name: tab.name,
            path: tab.path,
            sessionCount: items.length,
            truncated: false,
            locations: [
              {
                key: tab.path,
                kind: "space-root",
                name: tab.name,
                path: tab.path,
                sessionCount: items.length,
                sessions: items.map((s) => ({
                  ...s,
                  directoryHealth: "healthy",
                  marker: "directory",
                  timeCreated: s.time.created,
                  timeUpdated: s.time.updated,
                })),
              },
            ],
          }
        }),
      })
    if (url.pathname === "/workbench/locations")
      return json({ scopePath: url.searchParams.get("spacePath"), items: [] })
    if (url.pathname === "/workbench/files")
      return json([
        { name: "README.md", path: "README.md", absolute: roots[0] + "/README.md", type: "file", ignored: false },
      ])
    if (url.pathname === "/workbench/file-content")
      return json({ type: "text", content: "File browsing without a session runtime" })
    return route.fallback()
  })
  await page.addInitScript(
    ({ tabs, roots, sessions, initialBound }) => {
      localStorage.setItem(
        "workbench",
        JSON.stringify({
          schemaVersion: 2,
          tabs: [{ id: "General", name: "General", path: "", type: "general" }, ...tabs],
          activeTabPath: roots[0],
          display: { showTitlebar: true, showStatusbar: true, showSpaceRail: true, showFileViewer: false },
          spaces: Object.fromEntries(
            ["", ...roots].map((path, index) => [
              path,
              {
                activePanelID: `panel-${index}`,
                panels: [
                  {
                    id: `panel-${index}`,
                    directory: path === "" ? "/fixtures/old-general" : path,
                    slotState: path === roots[1] || (path === roots[0] && initialBound) ? "bound" : "empty",
                    boundSessionId:
                      path === roots[1]
                        ? sessions[2].id
                        : path === roots[0] && initialBound
                          ? sessions[0].id
                          : undefined,
                    ...(path === roots[1]
                      ? { directory: sessions[2].directory }
                      : path === roots[0]
                        ? { directory: sessions[0].directory }
                        : {}),
                    mode: "chat",
                    viewMode: "chat",
                    width: 1,
                  },
                ],
              },
            ]),
          ),
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: "/fixtures/old-project", expanded: true }] } }),
      )
    },
    { tabs, roots, sessions, initialBound },
  )
  return { requests, errors }
}

function cachedMessage(sessionID: string) {
  const messageID = `msg_${sessionID}`
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: 1700000000000 },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "test", modelID: "model" },
    },
    parts: [
      {
        id: `prt_${sessionID}`,
        sessionID,
        messageID,
        type: "text",
        text: "Restored after reconnect",
      },
    ],
  }
}

const instancePaths =
  /^(\/provider$|\/path$|\/project($|\/)|\/agent$|\/config$|\/lsp$|\/mcp$|\/session($|\/)|\/file($|\/)|\/wopal-space\/mode$)/
const loadedDirectories = (requests: Array<{ path: string; directory: string }>) =>
  [...new Set(requests.filter((x) => instancePaths.test(x.path)).map((x) => x.directory))].sort()

test("empty spaces, session rows, and file browsing do not acquire a runtime; opening a Panel does", async ({
  page,
}) => {
  const { requests, errors } = await setup(page, false)
  await page.goto("/workbench")
  await expect(page.getByRole("tab", { name: "ALPHA", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /History stays cold/ }).first()).toBeVisible()
  expect(loadedDirectories(requests)).toEqual([])

  await page
    .getByRole("button", { name: /文件|Files/i, exact: true })
    .first()
    .click()
  await expect(page.getByText("README.md", { exact: true }).first()).toBeVisible()
  await page.getByText("README.md", { exact: true }).first().click()
  await expect(page.getByText("File browsing without a session runtime").first()).toBeVisible()
  expect(loadedDirectories(requests)).toEqual([])

  await page.getByRole("button", { name: "Sessions", exact: true }).click()
  const row = page.getByRole("button", { name: sessions[0].title, exact: true }).first()
  await row.click()
  expect(loadedDirectories(requests)).toEqual([])
  await row.dblclick()
  await expect.poll(() => loadedDirectories(requests)).toEqual([sessions[0].directory])

  await page.getByRole("tab", { name: "BETA", exact: true }).click()
  await expect.poll(() => loadedDirectories(requests)).toEqual([sessions[0].directory, sessions[2].directory])
  await page.getByRole("tab", { name: "EMPTY", exact: true }).click()
  await expect(page.getByRole("tab", { name: "EMPTY", exact: true })).toHaveAttribute("aria-selected", "true")
  expect(loadedDirectories(requests)).toEqual([sessions[0].directory, sessions[2].directory])
  expect(errors).toEqual([])
})

test("initial load restores only current Space sessions and preserves Panel identity across visits", async ({
  page,
}) => {
  const { requests, errors } = await setup(page, true)
  await page.goto("/workbench")
  await expect(page.locator('[data-panel-id="panel-1"]')).toBeVisible()
  await expect.poll(() => loadedDirectories(requests)).toEqual([sessions[0].directory])
  const prompt = page.locator('[data-panel-id="panel-1"] [contenteditable="true"]').first()
  await prompt.fill("Keep this unsent draft")
  await page.locator('[data-panel-id="panel-1"]').evaluate((element) => element.setAttribute("data-kept", "yes"))
  await page.getByRole("tab", { name: "BETA", exact: true }).click()
  await expect.poll(() => loadedDirectories(requests)).toEqual([sessions[0].directory, sessions[2].directory])
  await page.getByRole("tab", { name: "ALPHA", exact: true }).click()
  await expect(page.locator('[data-panel-id="panel-1"]')).toHaveAttribute("data-kept", "yes")
  await expect(prompt).toContainText("Keep this unsent draft")
  expect(requests.some((x) => x.directory === sessions[1].directory)).toBe(false)
  expect(errors).toEqual([])
})

test("a server reconnect recovers only the visible Space and leaves its background panels cold", async ({ page }) => {
  const { requests, errors } = await setup(page, true, true)
  await page.goto("/workbench")
  await expect.poll(() => loadedDirectories(requests)).toEqual([sessions[0].directory])

  await page.getByRole("tab", { name: "BETA", exact: true }).click()
  await expect.poll(() => loadedDirectories(requests)).toEqual([sessions[0].directory, sessions[2].directory])
  await page.getByRole("tab", { name: "ALPHA", exact: true }).click()
  await expect(page.locator('[data-panel-id="panel-1"]')).toBeVisible()

  // The mocked SSE stream closes after each response, which produces a real
  // reconnect/resync. Start a fresh request window after both tabs have loaded
  // so only recovery traffic is being attributed here.
  await page.waitForTimeout(350)
  const recoveryStart = requests.length
  await expect.poll(() => loadedDirectories(requests.slice(recoveryStart))).toEqual([sessions[0].directory])
  await page.waitForTimeout(600)

  const recoveryDirectories = loadedDirectories(requests.slice(recoveryStart))
  expect(recoveryDirectories).toEqual([sessions[0].directory])
  expect(errors).toEqual([])
})
