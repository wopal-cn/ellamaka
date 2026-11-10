// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- tests inspect the SDK dynamic OpenAPI and generated method surface.
import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@wopal/ellamaka-sdk/v2"
import { pluginClientOperations } from "@wopal/ellamaka-plugin/client-compat"
import { createPluginClient } from "../../src/plugin/client-compat"
import { publicOpenApi } from "../../src/server/routes/instance/httpapi/openapi"
import legacyOperations from "./fixtures/legacy-client-operations.json"

type Mapping = {
  target: string | null
  method: string
  legacyPath: string
  targetPath?: string
  path?: Readonly<Record<string, string>>
  query?: readonly string[]
  body?: readonly string[]
  whole?: string | null
  params?: boolean
  direct?: boolean
}

type JsonRecord = Record<string, unknown>
function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object")
  return Object.fromEntries(Object.entries(value))
}
function methodAt(value: unknown, path: string): (options?: unknown) => unknown {
  let current = asRecord(value)
  const parts = path.split(".")
  for (const part of parts.slice(0, -1)) current = asRecord(current[part])
  const invoke = current[parts.at(-1)!]
  return (options?: unknown) => {
    if (typeof invoke !== "function") throw new Error(`missing method ${path}`)
    return invoke(options)
  }
}

describe("plugin client compatibility", () => {
  test("maps every supported legacy operation to the same live public method and path", () => {
    const spec = publicOpenApi()
    const canonical = createOpencodeClient({ baseUrl: "http://localhost:4096" })
    const legacy = createPluginClient(canonical)
    const mappingByName = pluginClientOperations as Record<string, Mapping>
    for (const legacyOperation of legacyOperations) {
      const mapping = mappingByName[legacyOperation.name]
      expect(mapping?.legacyPath).toBe(legacyOperation.path)
      expect(mapping?.method).toBe(legacyOperation.method)
      if (mapping?.target) {
        expect(mapping.targetPath?.replace(/\{[^}]+\}/g, "{}")).toBe(legacyOperation.path.replace(/\{[^}]+\}/g, "{}"))
      }
    }
    for (const [name, mapping] of Object.entries(pluginClientOperations) as [string, Mapping][]) {
      if (!mapping.target) {
        expect(() => methodAt(legacy, name)()).toThrow(/unsupported by this Runtime/)
        continue
      }
      expect((spec.paths[mapping.targetPath!] as JsonRecord | undefined)?.[mapping.method]).toBeDefined()
      let received: Record<string, unknown> | undefined
      let verb = ""
      const capture = (method: string) => (input: Record<string, unknown>) => {
        verb = method
        received = input
        return input
      }
      const transport = {
        get: capture("get"),
        post: capture("post"),
        put: capture("put"),
        patch: capture("patch"),
        delete: capture("delete"),
        sse: { get: capture("get") },
      }
      const path = Object.fromEntries(Object.keys(mapping.path ?? {}).map((key) => [key, `value-${key}`]))
      const query = Object.fromEntries((mapping.query ?? []).map((key) => [key, `query-${key}`]))
      const body = mapping.whole
        ? { marker: "body" }
        : Object.fromEntries((mapping.body ?? []).map((key) => [key, `body-${key}`]))
      const input = { path, query, ...(mapping.whole || mapping.body?.length ? { body } : {}), client: transport }
      methodAt(legacy, name)(input)
      expect(verb).toBe(mapping.method)
      expect(received?.url).toBe(mapping.targetPath)
      for (const [oldName, canonicalName] of Object.entries(mapping.path ?? {})) {
        expect(asRecord(received?.path ?? {})[canonicalName]).toBe(`value-${oldName}`)
      }
      for (const key of mapping.query ?? []) expect(asRecord(received?.query ?? {})[key]).toBe(`query-${key}`)
      if (mapping.whole) expect(received?.body).toEqual(body)
      else if (mapping.body?.length) expect(received?.body).toEqual(body)
    }
  })

  test("preserves client options and forwards legacy auth and session parameters", async () => {
    const seen: Request[] = []
    const fetch = (async (request: Request) => {
      seen.push(request)
      return new Response(JSON.stringify({ id: "ses_example" }), { headers: { "content-type": "application/json" } })
    }) as typeof globalThis.fetch
    const client = createPluginClient(
      createOpencodeClient({
        baseUrl: "http://localhost:4096",
        directory: "/tmp/project",
        headers: { authorization: "Basic sample" },
        fetch,
      }),
    )
    await client.auth.set({
      path: { id: "example-provider" },
      body: { type: "api", key: "sample" },
      headers: { "x-example": "one" },
    })
    await client.session.get({ path: { id: "ses_example" }, query: { directory: "/tmp/other" } })
    expect(seen.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["PUT", "/auth/example-provider"],
      ["GET", "/session/ses_example"],
    ])
    expect(await seen[0].clone().json()).toEqual({ type: "api", key: "sample" })
    expect(seen[0].headers.get("authorization")).toBe("Basic sample")
    expect(seen[0].headers.get("x-example")).toBe("one")
    expect(new URL(seen[1].url).searchParams.get("directory")).toBe("/tmp/other")
  })

  test("forwards errors, abort signals and event streams through the canonical client", async () => {
    const controller = new AbortController()
    const fetch = (async (request: Request) => {
      if (new URL(request.url).pathname === "/event") {
        return new Response('data: {"type":"server.connected","properties":{}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({ name: "NotFoundError", data: { message: "missing" } }, { status: 404 })
    }) as typeof globalThis.fetch
    const client = createPluginClient(createOpencodeClient({ baseUrl: "http://localhost:4096", fetch }))
    const missing = await client.session.get({ path: { id: "ses_missing" } })
    expect(missing.error).toBeDefined()
    expect(() => client.session.get({ path: { id: "ses_missing" }, throwOnError: true })).toThrow(/missing/)
    const events = await client.event.subscribe({ signal: controller.signal })
    expect((await events.stream.next()).value).toMatchObject({ type: "server.connected" })
    controller.abort()
    await events.stream.return()
  })
})
