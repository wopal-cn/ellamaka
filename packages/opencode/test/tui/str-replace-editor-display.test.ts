import { describe, expect, test } from "bun:test"
import { strReplaceEditorDisplay } from "@/cli/cmd/tui/routes/session/str-replace-editor"

const text = "1  const a = 1\n2  const b = 2\n"

describe("str_replace_editor TUI display model", () => {
  test("view is context activity carrying the full result text", () => {
    expect(strReplaceEditorDisplay({ command: "view", path: "/repo/a.ts" }, {}, text)).toEqual({
      family: "context",
      command: "view",
      path: "/repo/a.ts",
      text,
    })
  })

  test("view never turns adapter metadata into an edit diff", () => {
    const display = strReplaceEditorDisplay({ command: "view", path: "/repo/a.ts" }, { diff: "patch" }, text)
    expect(display.family).toBe("context")
    expect(display).not.toHaveProperty("diff")
  })

  test("mutation commands are edit activity with path and result text", () => {
    for (const command of ["create", "str_replace", "insert"] as const) {
      expect(strReplaceEditorDisplay({ command, path: "/repo/a.ts" }, {}, text)).toEqual({
        family: "edit",
        command,
        path: "/repo/a.ts",
        text,
      })
    }
  })

  test("carries an adapter-supplied unified diff only when it is a non-empty string", () => {
    const diff = "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new"
    expect(strReplaceEditorDisplay({ command: "str_replace", path: "/repo/a.ts" }, { diff }, "")).toEqual({
      family: "edit",
      command: "str_replace",
      path: "/repo/a.ts",
      text: "",
      diff,
    })
    // An empty or non-string diff is absent, never an empty diff.
    expect(
      strReplaceEditorDisplay({ command: "str_replace", path: "/repo/a.ts" }, { diff: "" }, ""),
    ).not.toHaveProperty("diff")
    expect(
      strReplaceEditorDisplay({ command: "str_replace", path: "/repo/a.ts" }, { diff: 42 }, ""),
    ).not.toHaveProperty("diff")
  })

  test("never fabricates result text from arguments", () => {
    const display = strReplaceEditorDisplay(
      { command: "create", path: "/repo/a.ts", file_text: "hello" },
      {},
      undefined,
    )
    expect(display).toEqual({ family: "edit", command: "create", path: "/repo/a.ts", text: "" })
  })

  test("missing or unknown command falls back to a safe generic shape", () => {
    expect(strReplaceEditorDisplay({ path: "/repo/a.ts" }, {}, text)).toEqual({
      family: "generic",
      path: "/repo/a.ts",
    })
    expect(strReplaceEditorDisplay({ command: "move", path: "/repo/a.ts" }, {}, text)).toEqual({
      family: "generic",
      command: "move",
      path: "/repo/a.ts",
    })
  })

  test("ignores empty or non-string paths", () => {
    expect(strReplaceEditorDisplay({ command: "view", path: "  " }, {}, text)).toEqual({
      family: "context",
      command: "view",
      text,
    })
    expect(strReplaceEditorDisplay({ command: "view", path: 7 }, {}, text)).toEqual({
      family: "context",
      command: "view",
      text,
    })
  })
})
