// packages/ellamaka-release/src/npm/contract.ts
//
// Contract gate between the packed SDK tarball and the Server's complete
// GET /doc document.
//
// The SDK ships its own openapi.json (generated from the Public Platform
// composition and committed to the source tree), while the Server serves the
// complete document that also holds the Official App BFF. Those two can drift
// silently: a stale committed openapi.json still packs and publishes, and a
// newly public operation never reaches SDK consumers.
//
// This module compares the *packed* artifact, not the source tree, with the
// public subset of the Server document, so a publish fails before an immutable
// npm version carries the wrong contract.

import { readTarballEntries } from "./content"
import type { PublishPlanEntry } from "./plan"

export type OpenApiDocument = {
  paths: Record<string, Record<string, unknown>>
  components?: Record<string, unknown>
  [key: string]: unknown
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const
const SDK_OPENAPI_PATH = "dist/openapi.json"
const MANIFEST_PATH = "package.json"
const APP_BFF_PREFIX = "/workbench/"
const AUDIENCE = "x-ellamaka-audience"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDocument(value: unknown): value is OpenApiDocument {
  return isObject(value) && isObject(value.paths)
}

function requireDocument(value: unknown, label: string): OpenApiDocument {
  if (!isDocument(value)) throw new Error(label + " is not an OpenAPI document with paths")
  return value
}

/** Deterministic JSON with object keys sorted, so two documents compare by content. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  if (isObject(value)) {
    const fields = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
    return "{" + fields.join(",") + "}"
  }
  return JSON.stringify(value) ?? "null"
}

type OperationEntry = { path: string; method: string; operation: unknown }

function operations(document: OpenApiDocument): OperationEntry[] {
  return Object.entries(document.paths).flatMap(([path, item]) => {
    if (!isObject(item)) return []
    return METHODS.flatMap((method) => {
      const operation = item[method]
      return operation === undefined ? [] : [{ path, method, operation }]
    })
  })
}

/**
 * The Public Platform subset of the complete Server document: every operation
 * marked with the public audience. Official App BFF operations are dropped here
 * exactly as they are dropped from the SDK contract.
 */
export function publicSubset(document: OpenApiDocument): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const { path, method, operation } of operations(document)) {
    if (!isObject(operation) || operation[AUDIENCE] !== "public-platform") continue
    const item = (paths[path] ??= {})
    item[method] = operation
  }
  return { ...document, paths }
}

function readPackedFile(tarball: Uint8Array, path: string, label: string): Uint8Array {
  const entry = readTarballEntries(tarball).find((candidate) => candidate.path === path)
  if (!entry) throw new Error("packed " + label + " has no " + path + ": the published contract is missing")
  return entry.content
}

/** Read the SDK's own OpenAPI contract out of a packed tarball. */
export function sdkOpenApi(tarball: Uint8Array): OpenApiDocument {
  const raw = new TextDecoder().decode(readPackedFile(tarball, SDK_OPENAPI_PATH, "SDK"))
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error("packed " + SDK_OPENAPI_PATH + " is not valid JSON: " + detail, { cause: error })
  }
  return requireDocument(parsed, "packed " + SDK_OPENAPI_PATH)
}

export interface VerifyPackedContractOptions {
  entry: PublishPlanEntry
  tarball: Uint8Array
  /** Complete GET /doc document as the Server serves it. */
  serverDocument: unknown
}

export interface VerifyPackedContractResult {
  operations: number
  paths: number
}

function label(path: string, method: string): string {
  return method.toUpperCase() + " " + path
}

/**
 * Fail the release when the packed SDK contract disagrees with the Server's
 * public subset, carries an Official App BFF operation, or documents an example
 * for a private endpoint.
 */
export function verifyPackedContract(options: VerifyPackedContractOptions): VerifyPackedContractResult {
  const packed = sdkOpenApi(options.tarball)
  const server = publicSubset(requireDocument(options.serverDocument, "server document"))

  for (const path of Object.keys(packed.paths))
    if (path.startsWith(APP_BFF_PREFIX))
      throw new Error(
        "packed SDK contract contains the Official App BFF operation " + path + "; it must stay Server-only",
      )

  const packedByKey = new Map(operations(packed).map((item) => [label(item.path, item.method), item]))
  const wantedByKey = new Map(operations(server).map((item) => [label(item.path, item.method), item]))

  const missing = [...wantedByKey.keys()].filter((key) => !packedByKey.has(key)).sort()
  if (missing.length)
    throw new Error(
      "packed SDK contract is missing " +
        missing.length +
        " public Server operation(s): " +
        missing.join(", ") +
        " - regenerate the SDK contract (bun run generate in packages/sdk/js) and commit the result",
    )

  const extra = [...packedByKey.keys()].filter((key) => !wantedByKey.has(key)).sort()
  if (extra.length)
    throw new Error(
      "packed SDK contract documents " +
        extra.length +
        " operation(s) the Server does not publish: " +
        extra.join(", "),
    )

  for (const [key, item] of packedByKey)
    if (canonicalJson(item.operation) !== canonicalJson(wantedByKey.get(key)?.operation))
      throw new Error(
        "packed SDK contract for " +
          key +
          " differs from the Server document - the committed openapi.json is stale; regenerate and commit it",
      )

  for (const { path, method, operation } of operations(packed)) {
    if (!isObject(operation)) continue
    const samples = operation["x-codeSamples"]
    if (!Array.isArray(samples) || samples.length === 0)
      throw new Error("packed SDK contract has no example for " + label(path, method))
    for (const sample of samples) {
      const source = isObject(sample) ? sample.source : undefined
      if (typeof source !== "string" || source.includes(APP_BFF_PREFIX))
        throw new Error("packed SDK example for " + label(path, method) + " must not call " + APP_BFF_PREFIX + "*")
    }
  }

  return { operations: packedByKey.size, paths: Object.keys(packed.paths).length }
}

const PRIVATE_SPECIFIERS = ["workspace:", "file:", "link:"]

/** Reject a packed manifest that cannot be installed from the registry alone. */
export function verifyPackedManifest(tarball: Uint8Array, name: string): Record<string, unknown> {
  const raw = new TextDecoder().decode(readPackedFile(tarball, MANIFEST_PATH, name))
  const parsed: unknown = JSON.parse(raw)
  if (!isObject(parsed)) throw new Error("packed " + name + " package.json is not an object")
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const value = parsed[field]
    if (value === undefined) continue
    if (!isObject(value)) throw new Error("packed " + name + " " + field + " is not an object")
    for (const [dependency, specifier] of Object.entries(value)) {
      const unpublished =
        typeof specifier !== "string" || PRIVATE_SPECIFIERS.some((prefix) => specifier.startsWith(prefix))
      if (unpublished)
        throw new Error(
          "packed " + name + " depends on unpublished " + field + " " + dependency + "@" + String(specifier),
        )
    }
  }
  return parsed
}
