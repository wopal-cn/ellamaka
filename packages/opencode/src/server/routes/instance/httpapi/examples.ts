/** Schema-derived illustrative examples. No runtime state or credentials are read. */
type Schema = {
  $ref?: string
  const?: unknown
  enum?: unknown[]
  anyOf?: Schema[]
  oneOf?: Schema[]
  allOf?: Schema[]
  type?: string | string[]
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  pattern?: string
  minLength?: number
  minimum?: number
  exclusiveMinimum?: number
  minItems?: number
}

type Media = { schema?: Schema; example?: unknown }
type Operation = {
  operationId?: string
  parameters?: { name: string; in: string; required?: boolean; schema?: Schema; example?: unknown }[]
  requestBody?: { content?: Record<string, Media> }
  responses?: Record<string, { content?: Record<string, Media> }>
  [key: string]: unknown
}
type Document = {
  paths: Record<string, Record<string, unknown>>
  components?: Record<string, Record<string, unknown>>
}

const sdkExamples: Record<string, string> = {
  "global.health": "console.log(await client.global.health())",
  "wopalSpace.ontology.list": "console.log(await client.wopalSpace.ontology.list())",
  "event.subscribe":
    "const events = await client.event.subscribe()\nfor await (const event of events.stream) console.log(event)",
  "auth.set": [
    "const key = process.env.PROVIDER_API_KEY",
    'if (!key) throw new Error("Set PROVIDER_API_KEY first")',
    'console.log(await client.auth.set({ providerID: "example", auth: { type: "api", key } }))',
  ].join("\n"),
}

function sample(schema: Schema, document: Document, depth = 0): unknown {
  if (depth > 20) throw new Error("recursive required example schema")
  if (schema.$ref) {
    const prefix = "#/components/schemas/"
    if (!schema.$ref.startsWith(prefix)) throw new Error(`unsupported example reference ${schema.$ref}`)
    const name = schema.$ref.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~")
    const target = document.components?.schemas?.[name]
    if (!target || typeof target !== "object") throw new Error(`missing example schema ${name}`)
    return sample(target as Schema, document, depth + 1)
  }
  if (schema.const !== undefined) return schema.const
  if (schema.enum?.length) return schema.enum[0]
  if (schema.anyOf?.length) return sample(schema.anyOf[0], document, depth + 1)
  if (schema.oneOf?.length) return sample(schema.oneOf[0], document, depth + 1)
  if (schema.allOf?.length) return Object.assign({}, ...schema.allOf.map((part) => sample(part, document, depth + 1)))
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  if (type === "null") return null
  if (type === "string") {
    if (schema.pattern === "^#[0-9a-fA-F]{6}$") return "#000000"
    if (schema.pattern?.startsWith("^")) return `${schema.pattern.slice(1)}example`
    return "x".repeat(Math.max(7, schema.minLength ?? 0)).replace(/^xxxxxxx$/, "example")
  }
  if (type === "integer" || type === "number")
    return Math.max(0, schema.minimum ?? 0, (schema.exclusiveMinimum ?? -1) + 1)
  if (type === "boolean") return false
  if (type === "array")
    return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items ?? {}, document, depth + 1))
  if (type === "object" || schema.properties) {
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [name, sample(schema.properties?.[name] ?? {}, document, depth + 1)]),
    )
  }
  return {}
}

function shell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function addOperationExamples(document: Document, path: string, method: string, operation: Operation): void {
  let requestPath = path
  const query = new URLSearchParams()
  for (const parameter of operation.parameters ?? []) {
    if (!parameter.schema) continue
    const value = sample(parameter.schema, document)
    parameter.example = value
    if (!parameter.required) continue
    if (parameter.in === "path")
      requestPath = requestPath.replace(`{${parameter.name}}`, encodeURIComponent(String(value)))
    if (parameter.in === "query") query.set(parameter.name, String(value))
  }
  if (query.size) requestPath += `?${query}`
  const body = operation.requestBody?.content?.["application/json"]
  if (body?.schema) body.example = sample(body.schema, document)
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!status.startsWith("2")) continue
    const json = response.content?.["application/json"]
    if (json?.schema) json.example = sample(json.schema, document)
  }
  const eventStream = Object.values(operation.responses ?? {}).some(
    (response) => response.content?.["text/event-stream"],
  )
  let source: string
  let lang = "shell"
  if (operation.operationId === "pty.connect") {
    lang = "js"
    source = [
      "// Add the server's Basic Authorization header to this request when authentication is enabled.",
      `const response = await fetch(${JSON.stringify(`http://127.0.0.1:4096${requestPath}-token`)}, { method: "POST" })`,
      "if (!response.ok) throw new Error(`Could not get a PTY ticket: ${response.status}`)",
      "const { ticket } = await response.json()",
      `const url = new URL(${JSON.stringify(`ws://127.0.0.1:4096${requestPath}`)})`,
      'url.searchParams.set("ticket", ticket)',
      "const socket = new WebSocket(url)",
      "socket.onmessage = (event) => console.log(event.data)",
    ].join("\n")
  } else {
    const flags = [
      `curl`,
      `--request ${method.toUpperCase()}`,
      eventStream ? "--no-buffer" : "",
      `--url ${shell(`http://127.0.0.1:4096${requestPath}`)}`,
    ]
    if (body?.schema)
      flags.push(`--header 'Content-Type: application/json'`, `--data ${shell(JSON.stringify(body.example))}`)
    source = flags.filter(Boolean).join(" ")
  }
  const samples = [{ lang, source }]
  if (operation.operationId && sdkExamples[operation.operationId]) {
    samples.push({
      lang: "js",
      source: [
        'import { createEllamakaClient } from "@wopal/ellamaka-sdk/http"',
        'const client = createEllamakaClient({ baseUrl: "http://127.0.0.1:4096" })',
        sdkExamples[operation.operationId],
      ].join("\n"),
    })
  }
  operation["x-codeSamples"] = samples
  operation["x-ellamaka-example-note"] =
    "Examples are illustrative; replace resource identifiers and supply credentials as needed."
}
