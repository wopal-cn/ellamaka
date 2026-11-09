#!/usr/bin/env bun
import { resolve } from "path"
import { verifyNpmCleanInstall } from "../npm/smoke"

const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")
let version: string | undefined
const packages: string[] = []
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === "--version" || arg === "--package") {
    const value = process.argv[++i]
    if (!value || value.startsWith("--")) {
      console.error(`Error: ${arg} requires a value`)
      process.exit(2)
    }
    if (arg === "--version") version = value
    else packages.push(value)
  } else {
    console.error(`Error: unknown argument: ${arg}`)
    process.exit(2)
  }
}

try {
  verifyNpmCleanInstall({ repoRoot, version, packages })
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
