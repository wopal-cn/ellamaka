import { expect, test } from "bun:test"
import path from "node:path"
import { stat } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"

test("auth persists API and OAuth credentials in a new isolated home", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  const script = `
    import { strict as assert } from "node:assert"
    import { Effect } from "effect"
    import { Auth } from "./src/auth"
    await Effect.runPromise(Effect.gen(function* () {
      const auth = yield* Auth.Service
      const api = { type: "api", key: "test-key" }
      const oauth = { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 12345 }
      yield* auth.set("api-provider", api)
      yield* auth.set("oauth-provider", oauth)
      assert.deepEqual(JSON.parse(JSON.stringify(yield* auth.get("api-provider"))), api)
      assert.deepEqual(JSON.parse(JSON.stringify(yield* auth.get("oauth-provider"))), oauth)
      assert.deepEqual(Object.keys(yield* auth.all()).sort(), ["api-provider", "oauth-provider"])
      yield* auth.remove("api-provider")
      assert.equal(yield* auth.get("api-provider"), undefined)
      assert.deepEqual(JSON.parse(JSON.stringify(yield* auth.get("oauth-provider"))), oauth)
    }).pipe(Effect.provide(Auth.defaultLayer)))
  `
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, WOPAL_HOME: home, OPENCODE_AUTH_CONTENT: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  const authFile = path.join(home, "ellamaka", "data", "auth.json")
  expect(await Bun.file(authFile).json()).toEqual({
    "oauth-provider": { type: "oauth", refresh: "test-refresh", access: "test-access", expires: 12345 },
  })
  if (process.platform !== "win32") expect((await stat(authFile)).mode & 0o777).toBe(0o600)
  expect(await Bun.file(path.join(home, "ellamaka", "data", "account.json")).exists()).toBe(false)
})
