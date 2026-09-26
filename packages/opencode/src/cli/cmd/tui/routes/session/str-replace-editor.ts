/**
 * Display model for the dsh `str_replace_editor` tool in the TUI.
 *
 * The tool is command-driven: `view` reads a path, while `create`,
 * `str_replace` and `insert` mutate it. Its result is plain text and carries
 * no structured diff metadata, so the display must never present a diff unless
 * the adapter supplied one. This module only classifies presentation and
 * passes real data through — it never synthesizes applied changes (or result
 * text) from the request arguments.
 */

export type StrReplaceEditorDisplay =
  | { family: "context"; command: "view"; path?: string; text: string }
  | { family: "edit"; command: "create" | "str_replace" | "insert"; path?: string; text: string; diff?: string }
  | { family: "generic"; command?: string; path?: string }

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  return value
}

/**
 * Builds the display model from a tool part's input, metadata and output.
 *
 * - `view` → context activity carrying the full result text.
 * - `create` / `str_replace` / `insert` → edit activity carrying the path and
 *   full result text, plus the adapter-supplied unified diff when the
 *   metadata carries a non-empty `diff`.
 * - anything else (missing or future commands) → generic shape; callers keep
 *   the pre-existing generic presentation.
 */
export function strReplaceEditorDisplay(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  output: string | undefined,
): StrReplaceEditorDisplay {
  const command = optionalString(input?.command)
  const path = optionalString(input?.path)
  const text = typeof output === "string" ? output : ""

  if (command === "view") {
    return path === undefined ? { family: "context", command, text } : { family: "context", command, path, text }
  }

  if (command === "create" || command === "str_replace" || command === "insert") {
    const diff = optionalString(metadata?.diff)
    return {
      family: "edit",
      command,
      ...(path === undefined ? {} : { path }),
      text,
      ...(diff === undefined ? {} : { diff }),
    }
  }

  return {
    family: "generic",
    ...(command === undefined ? {} : { command }),
    ...(path === undefined ? {} : { path }),
  }
}
