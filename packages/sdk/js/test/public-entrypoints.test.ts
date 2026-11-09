import { expect, test } from "bun:test"
import { createEllamakaClient, createOpencodeClient } from "../src/index"
import { createEllamakaClient as createHttpClient } from "../src/v2/client"
import { createOpencodeClient as createV2Client } from "../src/v2/client"
import openapi from "../src/openapi"

test("root, http and v2 use the same canonical client factory", () => {
  expect(createEllamakaClient).toBe(createOpencodeClient)
  expect(createHttpClient).toBe(createV2Client)
  expect(createEllamakaClient).toBe(createV2Client)
})

test("the published contract contains platform endpoints and excludes App BFF endpoints", () => {
  expect(openapi.paths["/global/health"]?.get).toBeDefined()
  expect(openapi.paths).toHaveProperty("/global/health")
  expect(openapi.paths).not.toHaveProperty("/workbench/session-tree")
})
