#!/usr/bin/env bun
import { resolve } from "path"
import { readSdkVersion } from "../npm/plan"
import { verifyNpmCleanInstall } from "../npm/smoke"

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")
let version: string | undefined
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === "--version") {
    version = process.argv[++i]
    if (!version) {
      console.error("Error: --version requires a value")
      process.exit(2)
    }
  } else {
    console.error(`Error: unknown argument: ${arg}`)
    process.exit(2)
  }
}

try {
  verifyNpmCleanInstall({ repoRoot, version: version ?? readSdkVersion(repoRoot) })
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
