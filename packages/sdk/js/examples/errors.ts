/**
 * The two ways a failed call reaches you.
 *
 * Run:  node examples/errors.ts
 * Needs: the same Server as examples/http-basic.ts.
 */
import { createEllamakaClient } from "@wopal/ellamaka-sdk/http"

const client = createEllamakaClient({
  baseUrl: process.env.ELLAMAKA_URL ?? "http://127.0.0.1:4096",
  headers: { Authorization: basic(process.env.ELLAMAKA_USERNAME ?? "ellamaka", required("ELLAMAKA_PASSWORD")) },
})

// 1. Read the error in the result. Nothing is thrown; `data` is undefined.
//    WopalSpace errors carry `code` + `message` (+ optional `suggestion`).
const result = await client.wopalSpace.space.status({ name: "definitely-not-a-space" })
if (result.error && "code" in result.error) {
  console.log("http:", result.response?.status)
  console.log("code:", result.error.code)
  console.log("message:", result.error.message)
  console.log("suggestion:", result.error.suggestion ?? "-")
}

// 2. Ask the client to throw. The parsed body stays under `cause`.
try {
  await client.wopalSpace.space.status({ name: "definitely-not-a-space" }, { throwOnError: true })
} catch (error) {
  if (error instanceof Error) {
    console.log("message:", error.message)
    console.log("cause:", JSON.stringify(error.cause))
  }
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}
function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`set ${name} (the Server password) before running this example`)
  return value
}
