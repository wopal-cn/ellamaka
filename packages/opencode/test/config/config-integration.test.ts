import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { infra, testFlock, wellKnownAuth } from "./config-fixtures"

// Live-I/O counterpart to `config.test.ts`. The well-known fetch below binds a
// real Bun server and drives a real HTTP client, so it lives under the
// `*-integration.test.ts` convention and runs via `test:integration` rather than
// on every unit pass. The shared layer fixtures live in `./config-fixtures`.

test("remote well-known config can use FetchHttpClient layer", async () => {
  let fetchedUrl: string | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      fetchedUrl = request.url
      return new Response(
        JSON.stringify({
          config: {
            mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe(`${server.url.origin}/.well-known/opencode`)
            expect(config.mcp?.jira?.enabled).toBe(true)
          }),
        ),
      { git: true },
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Config.layer.pipe(
          Layer.provide(testFlock),
          Layer.provide(AppFileSystem.defaultLayer),
          Layer.provide(Env.defaultLayer),
          Layer.provide(wellKnownAuth(server.url.origin)),
          Layer.provide(AccountTest.empty),
          Layer.provideMerge(infra),
          Layer.provide(NpmTest.noop),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Effect.runPromise,
    )
  } finally {
    await server.stop(true)
  }
})
