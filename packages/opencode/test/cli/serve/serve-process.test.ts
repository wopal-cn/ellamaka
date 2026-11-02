// Subprocess integration tests for `opencode serve`. Spawns the real CLI in
// headless mode and exercises it over HTTP — this is the only test tier that
// catches bugs spanning argv → server boot → routing → instance loading.
//
// `serve` is long-lived: the harness returns a handle (url/port/kill/exited)
// and kills the process when the test scope closes. The OS-assigned port is
// parsed off the "listening on http://..." line.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { isRecord } from "@/util/record"

describe("opencode serve (subprocess)", () => {
  // Smoke test: server starts, binds a port, and /global/health responds.
  // If this fails, all other serve tests likely will too — debug here first.
  cliIt.live(
    "starts, binds a port, and serves /global/health",
    ({ opencode }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve()
        expect(server.port).toBeGreaterThan(0)
        expect(server.url).toMatch(/^http:\/\//)

        const client = yield* HttpClient.HttpClient
        const res = yield* client.get(`${server.url}/global/health`)
        expect(res.status).toBe(200)
        // GlobalHealth schema is { success: true, ... } | { success: false, error }.
        // We don't lock in further shape here — any 200 with parseable JSON is
        // enough proof the routing + auth-bypass + instance loading is alive.
        const body = yield* res.json
        expect(body).toBeDefined()
      }),
    60_000,
  )

  cliIt.live(
    "treats the default Home as an editable candidate when normal mode has no explicit WOPAL_HOME",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const candidateHome = path.join(home, ".wopal")
        const stateDir = path.join(candidateHome, ".setup")
        const configDir = path.join(candidateHome, "config")
        mkdirSync(stateDir, { recursive: true })
        mkdirSync(configDir, { recursive: true })
        writeFileSync(
          path.join(stateDir, "ellamaka.json"),
          JSON.stringify({
            version: 1,
            currentStep: "complete",
            steps: {},
            errors: {},
            completed: true,
            startedAt: null,
            updatedAt: null,
          }),
        )
        writeFileSync(
          path.join(configDir, "settings.jsonc"),
          JSON.stringify({ wopal: { dsh: { web: { enabled: false } } } }),
        )

        const server = yield* opencode.serve({
          env: { WOPAL_HOME: "", WOPAL_DEV: "0", OPENCODE_DB: "", ELLAMAKA_DSH_TOOLS: "0" },
        })
        const inspected = yield* Effect.promise(() => fetch(`${server.url}/wopal-space/setup/inspect`))
        expect(inspected.status).toBe(200)
        const facts = yield* Effect.promise(() => inspected.json())
        expect(facts).toMatchObject({ home: { binding: { locked: false, selectable: true } } })
        expect(existsSync(path.join(candidateHome, "ellamaka"))).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "treats a completed launch Home as an editable candidate in development mode",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const candidateHome = path.join(home, "completed-candidate-home")
        const stateDir = path.join(candidateHome, ".setup")
        const candidateConfigDir = path.join(candidateHome, "config")
        mkdirSync(stateDir, { recursive: true })
        mkdirSync(candidateConfigDir, { recursive: true })
        writeFileSync(
          path.join(stateDir, "ellamaka.json"),
          JSON.stringify({
            version: 1,
            currentStep: "complete",
            steps: {},
            errors: {},
            completed: true,
            startedAt: null,
            updatedAt: null,
          }),
        )
        writeFileSync(
          path.join(candidateConfigDir, "settings.jsonc"),
          JSON.stringify({
            ellamaka: {
              provider: {
                "stale-home-provider": {
                  name: "Stale Home Provider",
                  npm: "@ai-sdk/openai-compatible",
                  api: "https://stale.example.test/v1",
                  models: { "stale-model": { name: "Stale Model" } },
                  options: { apiKey: "stale-key" },
                },
              },
            },
          }),
        )

        const server = yield* opencode.serve({
          env: { WOPAL_HOME: candidateHome, WOPAL_DEV: "1", OPENCODE_DB: "", ELLAMAKA_DSH_TOOLS: "0" },
        })

        // In development mode the launch Home is only the first-page candidate.
        // Its previous completion state must not boot Runtime storage before the
        // user confirms the effective Home for this Host lifecycle.
        expect(existsSync(path.join(candidateHome, "ellamaka"))).toBe(false)

        // A stray pre-selection read is stateless: selecting another Home must
        // make the next read resolve from that effective Home, not old memory.
        const beforeSelect = yield* Effect.promise(() => fetch(`${server.url}/global/config`))
        expect(beforeSelect.status).toBe(200)
        const beforeSelectConfig: unknown = yield* Effect.promise(() => beforeSelect.json())
        expect(
          isRecord(beforeSelectConfig) &&
            isRecord(beforeSelectConfig.provider) &&
            beforeSelectConfig.provider["stale-home-provider"] !== undefined,
        ).toBe(true)

        const selectedHome = path.join(home, "selected-home")
        const configDir = path.join(selectedHome, "config")
        mkdirSync(configDir, { recursive: true })
        writeFileSync(
          path.join(configDir, "settings.jsonc"),
          JSON.stringify({ wopal: { dsh: { web: { enabled: false } } } }),
        )

        const selected = yield* Effect.promise(() =>
          fetch(`${server.url}/wopal-space/setup/home`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: selectedHome }),
          }),
        )
        expect(selected.status).toBe(200)

        const rebound = yield* Effect.promise(() => fetch(`${server.url}/global/config`))
        expect(rebound.status).toBe(200)
        const reboundConfig: unknown = yield* Effect.promise(() => rebound.json())
        expect(
          isRecord(reboundConfig) &&
            (!isRecord(reboundConfig.provider) || reboundConfig.provider["stale-home-provider"] === undefined),
        ).toBe(true)

        const providers = yield* Effect.promise(() => fetch(`${server.url}/provider`))
        expect(providers.status).toBe(200)
        const providerList: unknown = yield* Effect.promise(() => providers.json())
        const all = isRecord(providerList) && Array.isArray(providerList.all) ? providerList.all : []
        const connected = isRecord(providerList) && Array.isArray(providerList.connected) ? providerList.connected : []
        expect(all.some((provider) => isRecord(provider) && provider.id === "stale-home-provider")).toBe(false)
        expect(connected).not.toContain("stale-home-provider")

        const prepared = yield* Effect.promise(() => fetch(`${server.url}/global/runtime/prepare`, { method: "POST" }))
        expect(prepared.status).toBe(200)
        expect(existsSync(path.join(candidateHome, "ellamaka"))).toBe(false)
        const dataDir = path.join(selectedHome, "ellamaka", "data")
        expect(existsSync(dataDir)).toBe(true)
        const tree = yield* Effect.promise(() => fetch(`${server.url}/workbench/session-tree`))
        expect(tree.status).toBe(200)
        const entries = readdirSync(dataDir)
        expect(entries.some((name) => /^ellamaka(?:-[^.]+)?\.db$/.test(name))).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "does not create the Ellamaka Runtime tree while onboarding is still pending",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const wopalHome = path.join(home, "wopal-home")
        const server = yield* opencode.serve({ env: { WOPAL_HOME: wopalHome, WOPAL_DEV: "1" } })

        const client = yield* HttpClient.HttpClient
        const config = yield* client.get(`${server.url}/config`)
        expect(config.status).toBe(200)

        expect(existsSync(path.join(wopalHome, "ellamaka"))).toBe(false)
      }),
    60_000,
  )

  // The scope-close finalizer must actually terminate the child. Without this
  // test a regression in the kill path (e.g. a future refactor that forgets
  // to wire the finalizer) would leak processes on every test run.
  cliIt.live(
    "kills the subprocess on scope close",
    ({ opencode }) =>
      Effect.gen(function* () {
        // Inner scope so we can observe `.exited` resolving after it closes.
        const exitedPromise = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* opencode.serve()
            // Capture the Promise, not the resolved value — scope closes after
            // this gen returns, at which point the finalizer kills the child.
            return server.exited
          }),
        )
        // After scope close: finalizer fired, process must have exited.
        const code = yield* Effect.promise(() => exitedPromise)
        // Bun reports the exit code; SIGTERM-killed processes return non-null
        // (typically 143 on POSIX). We just require resolution within a sane
        // window — anything else means the kill didn't take.
        expect(typeof code === "number" || code === null).toBe(true)
      }),
    60_000,
  )
})
