// packages/ellamaka-release/src/npm/json.ts
//
// Minimal JSON shape guards for the npm publish flow. The flow reads package
// manifests and writes one back, so reads are validated rather than asserted:
// a manifest that is not a JSON object (or is missing `name`/`version`) must
// fail loudly instead of silently publishing the wrong thing.

import { readFileSync } from "fs"

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse JSON that must be an object; `label` is used in the error message. */
export function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!isJsonObject(value)) throw new Error(`${label}: expected a JSON object`)
  return value
}

export function readJsonObject(path: string, label: string = path): Record<string, unknown> {
  return parseJsonObject(readFileSync(path, "utf8"), label)
}
