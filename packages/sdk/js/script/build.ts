#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"
import { normalizeGeneratedUnions } from "./normalize-unions"

const opencode = path.resolve(dir, "../../opencode")

const generated = await $`${process.execPath} ${path.join(opencode, "script/generate-openapi.ts")}`.cwd(opencode).text()
const contract: unknown = JSON.parse(generated)
const paths: unknown = typeof contract === "object" && contract !== null ? Reflect.get(contract, "paths") : undefined
if (typeof paths !== "object" || paths === null) throw new Error("SDK OpenAPI generation returned no paths")
if (Object.keys(paths).some((path) => path.startsWith("/workbench/")))
  throw new Error("SDK OpenAPI must not contain Official App BFF operations")
await Bun.write(path.join(dir, "openapi.json"), generated)
await Bun.write(path.join(dir, "src/openapi.json"), generated)

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// Remove redundant union members emitted by the generator while preserving their meaning.
const typesPath = "./src/v2/gen/types.gen.ts"
await Bun.write(typesPath, normalizeGeneratedUnions(await Bun.file(typesPath).text()))

// Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
// endpoint's TError into the second generic of ServerSentEventsResult, which
// is the AsyncGenerator's TReturn slot. Iterator return values have nothing
// to do with HTTP errors, and any consumer that calls `.return()` or returns
// from a mock generator gets type-checked against the wrong shape. Drop the
// arg so TReturn defaults to void.
const sseTypesPath = "./src/v2/gen/client/types.gen.ts"
const sseTypesFile = Bun.file(sseTypesPath)
const sseTypesSource = await sseTypesFile.text()
const sseTypesPatched = sseTypesSource.replace(
  "=> Promise<ServerSentEventsResult<TData, TError>>",
  "=> Promise<ServerSentEventsResult<TData>>",
)
if (sseTypesPatched === sseTypesSource) {
  throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
}
await Bun.write(sseTypesPath, sseTypesPatched)

await $`bun prettier --write src/v2`
await $`rm -rf dist tsconfig.tsbuildinfo`
await $`bun run build`
await $`rm openapi.json`
