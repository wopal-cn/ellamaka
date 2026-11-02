#!/usr/bin/env bun
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { AppBffInstanceApi, AppBffRootApi } from "../src/server/routes/instance/httpapi/api"

/**
 * Private Official App BFF contract. Deliberately separate from PublicApi so
 * it never reaches GET /doc or the published @wopal/ellamaka-sdk.
 */
type JsonObject = { [key: string]: JsonValue }
type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null

const isObject = (input: unknown): input is JsonObject =>
  typeof input === "object" && input !== null && !Array.isArray(input)

/**
 * Collapse `allOf: [X]` (Effect emits it for a single constraint such as
 * `Schema.isGreaterThanOrEqualTo`) into `X`. The generator does not resolve
 * that form for numeric types and would emit `unknown`.
 */
function collapseSingleAllOf(input: JsonValue): JsonValue {
  if (Array.isArray(input)) return input.map(collapseSingleAllOf)
  if (!isObject(input)) return input
  const next: JsonObject = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, collapseSingleAllOf(value)]),
  )
  const allOf = next.allOf
  if (Array.isArray(allOf) && allOf.length === 1) {
    const member = allOf[0]
    if (isObject(member)) {
      // The single constrained form wins over the wrapper; spread order keeps
      // the outer object authoritative and then drops the collapsed allOf.
      const merged: JsonObject = { ...member, ...next }
      delete merged.allOf
      return merged
    }
  }
  if (next.allOf === undefined) delete next.allOf
  return next
}

/** Normalize the generated document into the JSON tree this script edits. */
function parseJsonValue(input: unknown): JsonValue {
  if (input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return input
  }
  if (Array.isArray(input)) return input.map(parseJsonValue)
  if (isObject(input)) {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, parseJsonValue(value)]))
  }
  throw new Error("App BFF OpenAPI document contains a non-JSON value")
}

function toJsonValue(input: unknown): JsonValue {
  const serialized = JSON.stringify(input)
  if (serialized === undefined) throw new Error("App BFF OpenAPI document is not JSON serializable")
  return parseJsonValue(JSON.parse(serialized))
}

const doc: JsonValue = toJsonValue(
  OpenApi.fromApi(HttpApi.make("ellamaka-app-bff").addHttpApi(AppBffRootApi).addHttpApi(AppBffInstanceApi)),
)

process.stdout.write(JSON.stringify(collapseSingleAllOf(doc), null, 2))
