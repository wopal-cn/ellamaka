import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { disableRow, enableRow, readUserPatchState } from "../src/plugins/patch-layer"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-patch-layer-"))
}

function patchPathOf(root: string): string {
  return join(root, "cordis.patch.yml")
}

describe("readUserPatchState", () => {
  test("a missing patch file reads as empty state", () => {
    const root = tempRoot()
    const state = readUserPatchState(patchPathOf(root))
    expect(state).toEqual({ disables: [], forced: [], inserts: [] })
  })

  test("reads disables, forced, and inserts from the official shapes", () => {
    const root = tempRoot()
    writeFileSync(
      patchPathOf(root),
      [
        "# header comment stays valid",
        "- id: plugin-a",
        "  disabled: true",
        "- id: plugin-b",
        "  disabled: false",
      ].join("\n") + "\n",
    )
    const state = readUserPatchState(patchPathOf(root))
    expect(state.disables).toEqual(["plugin-a"])
    expect(state.forced).toEqual(["plugin-b"])
  })

  test("inserts are read from - insert: blocks (4-space item ids)", () => {
    const root = tempRoot()
    writeFileSync(
      patchPathOf(root),
      [
        "- insert:",
        "    - id: dsh-market",
        "      name: dshmarket",
      ].join("\n") + "\n",
    )
    const state = readUserPatchState(patchPathOf(root))
    expect(state.inserts).toEqual(["dsh-market"])
  })
})

describe("disableRow", () => {
  test("appends an id + disabled:true block (idempotent)", async () => {
    const root = tempRoot()
    const patchPath = patchPathOf(root)
    writeFileSync(patchPath, "[]\n")
    const first = await disableRow(patchPath, "fixture-dsh-plugin")
    expect(first.ok).toBe(true)
    expect(readUserPatchState(patchPath).disables).toEqual(["fixture-dsh-plugin"])
    // Second disable is a no-op (no duplicate row).
    await disableRow(patchPath, "fixture-dsh-plugin")
    const raw = readFileSync(patchPath, "utf-8")
    expect((raw.match(/fixture-dsh-plugin/g) ?? []).length).toBe(1)
    expect(raw.includes("{")).toBe(false)
  })

  test("rejects an unsafe row id", async () => {
    const root = tempRoot()
    const patchPath = patchPathOf(root)
    writeFileSync(patchPath, "[]\n")
    const result = await disableRow(patchPath, "bad id\n- exploit")
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/row id/)
  })

  test("replaces the [] placeholder when comments surround it (real template shape)", async () => {
    // The shipped profile template is comment header + `[]`; a comment can
    // also trail it (a prior touch/annotation). The first row must REPLACE
    // the `[]` placeholder — appending after a trailing comment would
    // produce two YAML documents and the composition would reject the file.
    const root = tempRoot()
    const patchPath = patchPathOf(root)
    writeFileSync(
      patchPath,
      [
        "# Your patch layer for this dsh profile, applied after every bundle layer:",
        "# a top-level YAML array of loader patch entries.",
        "[]",
        "",
        "# touch 141039",
        "",
      ].join("\n"),
    )
    const result = await disableRow(patchPath, "fixture-dsh-plugin")
    expect(result.ok).toBe(true)
    const raw = readFileSync(patchPath, "utf-8")
    // The [] placeholder is gone — exactly one top-level array remains.
    expect(raw.includes("[]")).toBe(false)
    // The appended row precedes any trailing comment (one document).
    expect(raw.indexOf("- id: fixture-dsh-plugin")).toBeLessThan(raw.indexOf("# touch"))
    expect(readUserPatchState(patchPath).disables).toEqual(["fixture-dsh-plugin"])
  })
})

describe("enableRow", () => {
  test("removes an existing disabled block", async () => {
    const root = tempRoot()
    const patchPath = patchPathOf(root)
    writeFileSync(patchPath, "[]\n")
    await disableRow(patchPath, "fixture-dsh-plugin")
    expect(readUserPatchState(patchPath).disables).toEqual(["fixture-dsh-plugin"])
    const result = await enableRow(patchPath, "fixture-dsh-plugin")
    expect(result.ok).toBe(true)
    expect(readUserPatchState(patchPath).disables).toEqual([])
  })

  test("force-enables with disabled:false when no block exists", async () => {
    const root = tempRoot()
    const patchPath = patchPathOf(root)
    writeFileSync(patchPath, "[]\n")
    const result = await enableRow(patchPath, "fixture-dsh-plugin")
    expect(result.ok).toBe(true)
    expect(readUserPatchState(patchPath).forced).toEqual(["fixture-dsh-plugin"])
  })

  test("restores the [] placeholder when the last row is removed", async () => {
    const root = tempRoot()
    const patchPath = patchPathOf(root)
    writeFileSync(patchPath, "[]\n")
    await disableRow(patchPath, "only-row")
    await enableRow(patchPath, "only-row")
    // The file must remain a valid top-level array (not pure comments).
    const raw = readFileSync(patchPath, "utf-8")
    expect(raw).toContain("[]")
    expect(existsSync(patchPath)).toBe(true)
  })
})

describe("queued writes", () => {
  test("concurrent disable calls serialise and keep one row", async () => {
    const root = tempRoot()
    const patchPath = patchPathOf(root)
    writeFileSync(patchPath, "[]\n")
    await Promise.all([
      disableRow(patchPath, "row-a"),
      disableRow(patchPath, "row-b"),
      disableRow(patchPath, "row-c"),
    ])
    const state = readUserPatchState(patchPath)
    expect(state.disables.sort()).toEqual(["row-a", "row-b", "row-c"])
  })
})
