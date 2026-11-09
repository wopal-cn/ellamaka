import { OpenApi } from "effect/unstable/httpapi"
import { AppBffInstanceApi, AppBffRootApi } from "./api"
import { PublicApi } from "./public"
import { addOperationExamples } from "./examples"

export type PublicOpenApiDocument = ReturnType<typeof OpenApi.fromApi>

export function publicOpenApi(): PublicOpenApiDocument {
  const document = structuredClone(OpenApi.fromApi(PublicApi)) as unknown as MutableDocument
  document.components ??= {}
  document.components.securitySchemes ??= {}
  document.components.securitySchemes.ServerBasicAuth = { type: "http", scheme: "basic" }
  addOperations(document, document.paths, "public-platform", new Set())
  return document as unknown as PublicOpenApiDocument
}

type MutableDocument = {
  paths: Record<string, Record<string, unknown>>
  components?: Record<string, Record<string, unknown>>
}

const methods = ["get", "post", "put", "patch", "delete"] as const
const authentication =
  "When server authentication is configured, supply HTTP Basic credentials. PTY connections may also use a connection ticket."

function addOperations(
  document: MutableDocument,
  paths: MutableDocument["paths"],
  audience: "public-platform" | "official-app",
  ids: Set<string>,
) {
  for (const [path, item] of Object.entries(paths))
    for (const method of methods) {
      const value = item[method]
      if (!value || typeof value !== "object") continue
      const operation = value as Record<string, unknown>
      const id = operation.operationId
      if (typeof id !== "string" || ids.has(id))
        throw new Error(`missing or duplicate operationId for ${method} ${path}`)
      ids.add(id)
      if (id === "pty.connect") {
        const responses = operation.responses as Record<string, unknown>
        delete responses["200"]
        responses["101"] = { description: "WebSocket protocol upgrade" }
      }
      operation["x-ellamaka-audience"] = audience
      operation["x-ellamaka-compatibility"] =
        audience === "public-platform" ? "public-sdk-semver" : "official-app-internal"
      operation["x-ellamaka-authentication"] = authentication
      operation.security = [{}, { ServerBasicAuth: [] }]
      addOperationExamples(document, path, method, operation)
    }
}

/** Full mounted API discovery; the public SDK is still generated from publicOpenApi. */
export function serverOpenApi(): PublicOpenApiDocument {
  const output = publicOpenApi() as unknown as MutableDocument
  const ids = new Set<string>()
  for (const item of Object.values(output.paths))
    for (const method of methods) {
      const operation = item[method] as { operationId?: string } | undefined
      if (operation?.operationId) ids.add(operation.operationId)
    }
  const appDocuments = [
    ["AppBffRoot", OpenApi.fromApi(AppBffRootApi)],
    ["AppBffInstance", OpenApi.fromApi(AppBffInstanceApi)],
  ] as const
  for (const [prefix, document] of appDocuments) {
    const input = document as unknown as MutableDocument
    const schemas = input.components?.schemas ?? {}
    const names = new Map(Object.keys(schemas).map((name) => [name, `${prefix}_${name}`]))
    const renamed = JSON.parse(JSON.stringify(input), (key, value: unknown) => {
      if (key !== "$ref" || typeof value !== "string" || !value.startsWith("#/components/schemas/")) return value
      const name = value.slice("#/components/schemas/".length)
      return names.has(name) ? `#/components/schemas/${names.get(name)}` : value
    }) as MutableDocument
    output.components ??= {}
    output.components.schemas ??= {}
    for (const [name, schema] of Object.entries(renamed.components?.schemas ?? {})) {
      const target = names.get(name)!
      if (target in output.components.schemas) throw new Error(`duplicate schema ${target}`)
      output.components.schemas[target] = schema
    }
    addOperations(output, renamed.paths, "official-app", ids)
    for (const [path, item] of Object.entries(renamed.paths)) {
      const existing = (output.paths[path] ??= {})
      for (const [method, operation] of Object.entries(item)) {
        if (method in existing) throw new Error(`duplicate path operation ${method} ${path}`)
        existing[method] = operation
      }
    }
  }
  return output as unknown as PublicOpenApiDocument
}

export function generatedOpenApi(): PublicOpenApiDocument {
  return publicOpenApi()
}
