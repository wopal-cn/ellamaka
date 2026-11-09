import { expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { stat } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const packageRoot = path.resolve(import.meta.dir, "../..")
const cliEntry = path.join(packageRoot, "src/index.ts")
const authEntry = path.join(packageRoot, "src/auth/index.ts")
// Pin the workspace copy so the probe never mixes a second Effect instance
// resolved from a different node_modules chain.
const effectEntry = path.join(packageRoot, "../../node_modules/effect/dist/index.js")

/** A local OpenAI-compatible endpoint; no provider account or network is used. */
async function fakeModelServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end()
      return
    }
    request.resume()
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"restart-ok"},"finish_reason":null}]}\n\n',
    )
    response.write(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    )
    response.end("data: [DONE]\n\n")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fake model server did not bind")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

function isolatedEnv(home: string, config: Record<string, unknown>) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    WOPAL_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    ELLAMAKA_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
  }
}

async function run(command: string[], env: Record<string, string>, cwd: string) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exit, stdout, stderr }
}

test("credentials written once survive a fresh CLI process and still serve a model call", async () => {
  await using temp = await tmpdir()
  const home = path.join(temp.path, "home")
  const { server, url } = await fakeModelServer()
  try {
    const loginScript = path.join(temp.path, "login.ts")
    await Bun.write(
      loginScript,
      [
        `import { Effect } from ${JSON.stringify(effectEntry)}`,
        `import { Auth } from ${JSON.stringify(authEntry)}`,
        "await Effect.runPromise(",
        "  Effect.gen(function* () {",
        "    const auth = yield* Auth.Service",
        '    yield* auth.set("test", { type: "api", key: "local-test-key" })',
        "  }).pipe(Effect.provide(Auth.defaultLayer)),",
        ")",
      ].join("\n"),
    )

    const config = {
      formatter: false,
      lsp: false,
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { baseURL: url },
        },
      },
    }
    const env = isolatedEnv(home, config)

    const login = await run([process.execPath, "run", loginScript], env, packageRoot)
    expect(login.stderr, login.stderr).not.toContain("error:")
    expect(login.exit).toBe(0)

    const authFile = path.join(home, "ellamaka", "data", "auth.json")
    expect(await Bun.file(authFile).json()).toEqual({ test: { type: "api", key: "local-test-key" } })
    if (process.platform !== "win32") expect((await stat(authFile)).mode & 0o777).toBe(0o600)
    expect(await Bun.file(path.join(home, "ellamaka", "data", "account.json")).exists()).toBe(false)

    const list = await run([process.execPath, "run", cliEntry, "providers", "list"], env, packageRoot)
    expect(list.exit, list.stderr).toBe(0)
    expect(list.stdout).toContain("test")
    expect(list.stdout).toContain("api")

    const call = await run(
      [process.execPath, "run", cliEntry, "run", "--model", "test/test-model", "say hello"],
      env,
      packageRoot,
    )
    expect(call.exit, call.stderr).toBe(0)
    expect(call.stdout).toContain("restart-ok")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
