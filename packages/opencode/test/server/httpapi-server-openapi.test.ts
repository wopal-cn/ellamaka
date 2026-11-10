// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- tests inspect the dynamic generated OpenAPI document.
import { describe, expect, test } from "bun:test"
import { publicOpenApi, serverOpenApi } from "../../src/server/routes/instance/httpapi/openapi"
import Ajv2020 from "ajv/dist/2020"

type Operation = { operationId?: string; description?: string; [key: string]: unknown }
type Paths = Record<string, Partial<Record<"get" | "post" | "put" | "patch" | "delete", Operation>>>

describe("complete server API documentation", () => {
  test("documents public APIs and the private App BFF while keeping the SDK contract public", () => {
    const publicSpec = publicOpenApi()
    const serverSpec = serverOpenApi()
    const publicPaths = publicSpec.paths as Paths
    const serverPaths = serverSpec.paths as Paths
    for (const [path, item] of Object.entries(publicPaths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue
        const documented = serverPaths[path]?.[method as keyof typeof item]
        expect(documented).toEqual(operation)
        expect(documented?.["x-ellamaka-audience"]).toBe("public-platform")
      }
    }
    expect(publicPaths["/workbench/session-tree"]).toBeUndefined()
    expect(publicPaths["/doc"]?.get?.["x-ellamaka-audience"]).toBe("public-platform")
    expect(serverPaths["/workbench/session-tree"]?.get?.["x-ellamaka-audience"]).toBe("official-app")
    expect(serverPaths["/workbench/sessions"]?.post?.["x-ellamaka-audience"]).toBe("official-app")
  })

  test("every documented operation identifies its purpose, compatibility and authentication boundary", () => {
    const spec = serverOpenApi()
    const ids = new Set<string>()
    for (const item of Object.values(spec.paths as Paths))
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method) || !operation) continue
        expect(operation.operationId).toBeTruthy()
        expect(ids.has(operation.operationId!)).toBe(false)
        ids.add(operation.operationId!)
        expect(operation.description).toBeTruthy()
        expect(operation["x-ellamaka-compatibility"]).toBeTruthy()
        expect(operation["x-ellamaka-authentication"]).toBeTruthy()
      }
  })

  test("PTY connection is documented as a WebSocket upgrade rather than a JSON response", () => {
    const spec = serverOpenApi() as unknown as { paths: Record<string, Record<string, any>> }
    const operation = spec.paths["/pty/{ptyID}/connect"].get
    expect(operation.responses["101"]).toBeDefined()
    expect(operation.responses["200"]).toBeUndefined()
    expect(operation["x-codeSamples"][0].source).toContain("connect-token")
    expect(operation["x-codeSamples"][0].source).toContain("WebSocket")
  })

  test("every JSON request and success example satisfies its declared schema", () => {
    const spec = serverOpenApi() as unknown as {
      paths: Record<string, Record<string, any>>
      components: Record<string, unknown>
    }
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
    const discoverySchema = spec.paths["/doc"].get.responses["200"].content["application/json"].schema
    const validateDocument = ajv.compile({ ...discoverySchema, components: spec.components })
    if (!validateDocument(spec)) throw new Error(`GET /doc: ${ajv.errorsText(validateDocument.errors)}`)
    let checked = 0
    for (const [path, item] of Object.entries(spec.paths))
      for (const [method, operation] of Object.entries(item)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue
        expect(operation["x-codeSamples"]?.[0]?.source).toBeTruthy()
        expect(operation["x-codeSamples"][0].source).not.toContain("...")
        for (const parameter of operation.parameters ?? []) {
          if (!parameter.schema) continue
          expect(parameter).toHaveProperty("example")
          const validate = ajv.compile({ ...parameter.schema, components: spec.components })
          if (!validate(parameter.example))
            throw new Error(`${method} ${path} ${parameter.name}: ${ajv.errorsText(validate.errors)}`)
        }
        const content = [
          operation.requestBody?.content?.["application/json"],
          ...Object.entries(operation.responses ?? {})
            .filter(([status]) => status.startsWith("2"))
            .map(([, response]: [string, any]) => response.content?.["application/json"]),
        ]
        for (const entry of content) {
          if (!entry?.schema) continue
          expect(entry).toHaveProperty("example")
          const validate = ajv.compile({ ...entry.schema, components: spec.components })
          if (!validate(entry.example)) throw new Error(`${method} ${path}: ${ajv.errorsText(validate.errors)}`)
          checked++
        }
      }
    expect(checked).toBeGreaterThan(100)
  })
})
