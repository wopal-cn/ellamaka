/**
 * Connect to a running Server over HTTP and read platform facts.
 *
 * Run:  node examples/http-basic.ts
 * Needs: an `ellamaka` binary serving on 127.0.0.1:4096 (see examples/README.md).
 */
import { createEllamakaClient } from "@wopal/ellamaka-sdk/http"

const client = createEllamakaClient({
  baseUrl: process.env.ELLAMAKA_URL ?? "http://127.0.0.1:4096",
  headers: { Authorization: basic(process.env.ELLAMAKA_USERNAME ?? "ellamaka", required("ELLAMAKA_PASSWORD")) },
})

const health = await client.global.health()
if (health.error) throw new Error(`health failed: ${health.response?.status} ${JSON.stringify(health.error)}`)
console.log("version:", health.data?.version)

const spaces = await client.wopalSpace.space.list()
if (spaces.error) throw new Error(`space.list failed: ${spaces.response?.status} ${JSON.stringify(spaces.error)}`)
for (const space of spaces.data?.items ?? []) console.log("space:", space.name, "->", space.path)

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}
function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`set ${name} (the Server password) before running this example`)
  return value
}
