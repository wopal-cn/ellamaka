/**
 * List what this SDK can call, straight from the shipped contract.
 *
 * Run:  node dist/examples/discover.js
 * Needs nothing running: the OpenAPI document ships inside the package.
 */
import { openapi } from "@wopal/ellamaka-sdk/openapi"

const methods = ["get", "post", "put", "patch", "delete"] as const

const groups = new Map<string, number>()
for (const item of Object.values(openapi.paths)) {
  if (typeof item !== "object" || item === null) continue
  for (const method of methods) {
    const operation = Reflect.get(item, method)
    if (typeof operation !== "object" || operation === null) continue
    const tags = Reflect.get(operation, "tags")
    const tag = Array.isArray(tags) && typeof tags[0] === "string" ? tags[0] : "-"
    groups.set(tag, (groups.get(tag) ?? 0) + 1)
  }
}
for (const [tag, count] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`${tag}: ${count}`)
