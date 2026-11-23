import { describe, expect, test } from "bun:test"

const script = await import("../src/gitee")

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }
}

function makeFetch(responses: ReturnType<typeof response>[]) {
  const calls: Array<[string, RequestInit]> = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push([url, init])
    const next = responses.shift()
    if (!next) throw new Error("No mocked response left")
    return next
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

describe("create-gitee-release.mjs", () => {
  test("parses required flags and defaults", () => {
    const result = script.parseArgs([
      "node",
      "script.mjs",
      "--version",
      "0.1.0",
      "--repo",
      "wopal-cn/ellamaka",
      "--tag",
      "v0.1.0",
      "--notes-file",
      "release-notes.md",
    ])

    expect(result.version).toBe("0.1.0")
    expect(result.repo).toBe("wopal-cn/ellamaka")
    expect(result.tag).toBe("v0.1.0")
    expect(result.notesFile).toBe("release-notes.md")
    expect(result.productName).toBe("ellamaka")
    expect(result.baseUrl).toBe("https://gitee.com/api/v5")
  })

  test("accepts custom product name and base URL", () => {
    const result = script.parseArgs([
      "node",
      "script.mjs",
      "--version",
      "0.1.0",
      "--repo",
      "wopal-cn/wopal-space-ontology",
      "--tag",
      "v0.1.0",
      "--notes-file",
      "release-notes.md",
      "--product-name",
      "Ellamaka Engine",
      "--base-url",
      "https://api.test/v5",
    ])

    expect(result.productName).toBe("Ellamaka Engine")
    expect(result.baseUrl).toBe("https://api.test/v5")
  })

  test("parses owner and repo", () => {
    expect(script.parseRepo("wopal-cn/ellamaka")).toEqual({ owner: "wopal-cn", repo: "ellamaka" })
    expect(() => script.parseRepo("invalid")).toThrow()
  })

  test("builds create body with ellamaka name", () => {
    expect(script.buildCreateBody({ version: "0.1.0", tag: "v0.1.0", notesContent: "notes", token: "TOKEN" })).toEqual({
      tag_name: "v0.1.0",
      name: "ellamaka v0.1.0",
      body: "notes",
      target_commitish: "main",
      prerelease: false,
      access_token: "TOKEN",
    })
  })

  test("creates a new release when lookup returns 404", async () => {
    const mocked = makeFetch([response(404, "not found"), response(201, { id: 42 })])
    const result = await script.createOrGetRelease({
      fetch: mocked.fetch,
      baseUrl: "https://gitee.test/api/v5",
      owner: "wopal-cn",
      repo: "ellamaka",
      tag: "v0.1.0",
      version: "0.1.0",
      notesContent: "notes",
      token: "TOKEN",
    })

    expect(result).toEqual({ id: 42, created: true })
    expect(mocked.calls).toHaveLength(2)
    expect(mocked.calls[1]![1].method).toBe("POST")
    expect(JSON.parse(mocked.calls[1]![1].body as string).tag_name).toBe("v0.1.0")
  })

  test("deletes and recreates an existing release", async () => {
    const mocked = makeFetch([response(200, { id: 99 }), response(204, ""), response(201, { id: 100 })])
    const result = await script.createOrGetRelease({
      fetch: mocked.fetch,
      baseUrl: "https://gitee.test/api/v5",
      owner: "wopal-cn",
      repo: "ellamaka",
      tag: "v0.1.0",
      version: "0.1.0",
      notesContent: "updated notes",
      token: "TOKEN",
    })

    expect(result).toEqual({ id: 100, created: true })
    expect(mocked.calls).toHaveLength(3)
    expect(mocked.calls[1]![1].method).toBe("DELETE")
    expect(mocked.calls[2]![1].method).toBe("POST")
    expect(JSON.parse(mocked.calls[2]![1].body as string).body).toBe("updated notes")
  })

  test("treats null lookup body as missing release", async () => {
    const mocked = makeFetch([response(200, null), response(201, { id: 55 })])
    const result = await script.createOrGetRelease({
      fetch: mocked.fetch,
      baseUrl: "https://gitee.test/api/v5",
      owner: "wopal-cn",
      repo: "ellamaka",
      tag: "v0.1.0",
      version: "0.1.0",
      notesContent: "notes",
      token: "TOKEN",
    })

    expect(result).toEqual({ id: 55, created: true })
  })

  test("throws on unexpected lookup failure", async () => {
    const mocked = makeFetch([response(500, "server error")])
    await expect(
      script.createOrGetRelease({
        fetch: mocked.fetch,
        baseUrl: "https://gitee.test/api/v5",
        owner: "wopal-cn",
        repo: "ellamaka",
        tag: "v0.1.0",
        version: "0.1.0",
        notesContent: "notes",
        token: "TOKEN",
      }),
    ).rejects.toThrow()
  })
})
