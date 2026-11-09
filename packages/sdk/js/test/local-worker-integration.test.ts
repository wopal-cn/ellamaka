import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEllamakaLocalClient } from "../dist/local.js"
import { createCompatibilityFixture } from "../../../wopalspace/test/fixtures/compatibility/git-space"
import { scopedEnv } from "./fixture/process-env"

test("local Worker serves real Ontology/Space file and Git facts without mutating them", async () => {
  const fixture = createCompatibilityFixture(join(tmpdir(), "ellamaka-local-worker-fixture-"))
  const restoreEnv = scopedEnv({
    GIT_CONFIG_GLOBAL: fixture.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: fixture.env.GIT_CONFIG_NOSYSTEM,
    GIT_AUTHOR_NAME: fixture.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: fixture.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: fixture.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: fixture.env.GIT_COMMITTER_EMAIL,
  })
  const before = fixture.snapshot()
  const local = await createEllamakaLocalClient({ wopalHome: fixture.home, directory: fixture.space })
  try {
    expect(Object.keys(local.client)).toEqual(["wopalSpace"])
    const spaces = await local.client.wopalSpace.space.list()
    expect(spaces.data?.items[0]).toMatchObject({ name: "demo-space", path: fixture.space, type: "coding" })
    const projects = await local.client.wopalSpace.space.projects.list({ name: "demo-space" })
    expect(projects.error).toBeUndefined()
    const status = await local.client.wopalSpace.space.status({ name: "demo-space" })
    expect(status.data?.space.branch).toBe("space/demo-space")
    const files = await local.client.wopalSpace.space.files.list({ name: "demo-space", path: "." })
    expect(files.data?.items.length).toBeGreaterThan(0)
    const content = await local.client.wopalSpace.space.files.read({
      name: "demo-space",
      path: ".wopal-space/space-meta.json",
    })
    expect(content.data?.content.length).toBeGreaterThan(0)
    const ontologies = await local.client.wopalSpace.ontology.list()
    expect(ontologies.data?.items[0]?.name).toBe("test-onto")
  } finally {
    await local.dispose()
    expect(fixture.snapshot()).toEqual(before)
    fixture.dispose()
    restoreEnv()
  }
})

test("dispose waits for in-flight requests and rejects later use without leaving a Worker", async () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-local-worker-dispose-"))
  const local = await createEllamakaLocalClient({ wopalHome: home, directory: home })
  const pending = local.client.wopalSpace.space.list()
  await local.dispose()
  const result = await pending
  expect(result.data ?? result.error).toBeDefined()
  const after = await local.client.wopalSpace.space.list()
  expect(after.error).toMatchObject({ name: "LocalClientDisposed" })
  rmSync(home, { recursive: true, force: true })
})

test("dispose waits for an in-flight space.init write before closing the Worker", async () => {
  const fixture = createCompatibilityFixture(join(tmpdir(), "ellamaka-local-worker-init-"))
  const restoreEnv = scopedEnv({
    GIT_CONFIG_GLOBAL: fixture.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: fixture.env.GIT_CONFIG_NOSYSTEM,
    GIT_AUTHOR_NAME: fixture.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: fixture.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: fixture.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: fixture.env.GIT_COMMITTER_EMAIL,
  })
  const root = join(fixture.root, "new-space")
  mkdirSync(root)
  const local = await createEllamakaLocalClient({ wopalHome: fixture.home, directory: fixture.space })
  try {
    const pending = local.request("/wopal-space/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new-space", root, type: "coding" }),
    })
    await local.dispose()
    const created = await pending
    expect(created.status).toBe(200)
    expect((await created.json()).space.path).toBe(root)
    expect(existsSync(join(root, ".wopal"))).toBe(true)
    expect(existsSync(join(root, ".wopal-space", "space-meta.json"))).toBe(true)
  } finally {
    await local.dispose()
    fixture.dispose()
    restoreEnv()
  }
})

test("explicit cancel aborts an in-flight request without terminating the Worker", async () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-local-worker-cancel-"))
  const local = await createEllamakaLocalClient({ wopalHome: home, directory: home })
  try {
    const controller = new AbortController()
    const request = local.client.wopalSpace.space.list({ signal: controller.signal })
    controller.abort()
    const result = await request
    expect(result.error ?? result.data).toBeDefined()
    const after = await local.client.wopalSpace.space.list()
    expect(after.data).toEqual({ items: [], total: 0 })
  } finally {
    await local.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test("Worker rejects Setup before entering business handlers", async () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-local-worker-setup-"))
  const local = await createEllamakaLocalClient({ wopalHome: home, directory: home })
  try {
    const setup = await local.request("/wopal-space/setup/inspect")
    expect(setup.status).toBe(400)
    expect(await setup.json()).toMatchObject({ data: { code: "LOCAL_OPERATION_UNSUPPORTED" } })
  } finally {
    await local.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
