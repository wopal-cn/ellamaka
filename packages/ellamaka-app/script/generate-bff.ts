#!/usr/bin/env bun
import { $ } from "bun"
import path from "path"
import { createClient } from "@hey-api/openapi-ts"

/**
 * Generate the Official App BFF private client.
 *
 * The contract is emitted by the Server composition as a private HttpApi; it
 * is never part of PublicApi, GET /doc, or the published SDK.
 */
const appDir = path.resolve(import.meta.dir, "..")
const packages = path.resolve(appDir, "..")
const opencode = path.resolve(packages, "opencode")

const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const outDir = outIndex === -1 ? path.join(appDir, "src/bff/gen") : path.resolve(args[outIndex + 1] ?? ".")
const cache = path.join(appDir, ".bff-cache")

const document = await $`${process.execPath} ${path.join(opencode, "script/generate-app-bff-openapi.ts")}`
  .cwd(opencode)
  .quiet()
await Bun.write(path.join(cache, "openapi.json"), document.stdout)

await createClient({
  input: path.join(cache, "openapi.json"),
  output: { path: outDir, tsConfigPath: path.join(appDir, "tsconfig.json"), clean: true },
  plugins: [
    { name: "@hey-api/typescript", exportFromIndex: false },
    {
      name: "@hey-api/sdk",
      instance: "EllamakaAppBffClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    { name: "@hey-api/client-fetch", exportFromIndex: false, baseUrl: "http://localhost:4096" },
  ],
})

await $`bun prettier --write ${outDir}`.cwd(appDir)
await $`rm -f ${path.join(cache, "openapi.json")}`
