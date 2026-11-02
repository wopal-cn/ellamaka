import { parse as parseJsoncDocument, type ParseError } from "jsonc-parser"
import { parse as parseYamlDocument } from "yaml"

/** Runtime-neutral JSONC parser shared by Bun CLI and Node Desktop sidecar. */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = []
  const value = parseJsoncDocument(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length > 0) throw new Error("invalid JSONC")
  return value
}

/** Runtime-neutral YAML parser shared by Bun CLI and Node Desktop sidecar. */
export function parseYaml(text: string): unknown {
  return parseYamlDocument(text) as unknown
}
