import { describe, expect, it } from "bun:test"
import {
  editManifestList,
  editManifestPlugin,
  onlyFieldChanged,
  verifyManifestEdit,
} from "../../../src/space/manifest-edit"
import { parseArchetypeDocument } from "../../../src/space/assembly"

const manifest = [
  "version: 1",
  "type: coding",
  "# keep this comment",
  "skills:",
  "  - dev-flow",
  "  - extra",
  "plugins:",
  "  ellamaka:",
  "    - wopal-plugin",
  "",
].join("\n")

describe("manifest editing", () => {
  it("appends a name to a block list and keeps comments", () => {
    const next = editManifestList(manifest, "skills", "third", "add")
    expect(next).toContain("# keep this comment")
    expect(next).toContain("  - third")
    const parsed = parseArchetypeDocument(next)
    expect(parsed.ok && parsed.manifest.skills).toEqual(["dev-flow", "extra", "third"])
  })

  it("removes one name and leaves the rest in order", () => {
    const next = editManifestList(manifest, "skills", "extra", "remove")
    const parsed = parseArchetypeDocument(next)
    expect(parsed.ok && parsed.manifest.skills).toEqual(["dev-flow"])
    expect(next).toContain("# keep this comment")
  })

  it("drops the header when the last list entry goes", () => {
    const single = ["version: 1", "type: coding", "skills:", "  - only", ""].join("\n")
    const next = editManifestList(single, "skills", "only", "remove")
    const parsed = parseArchetypeDocument(next)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.manifest.skills).toEqual([])
    expect(next).not.toContain("skills:")
  })

  it("adds a sectioned plugin, and drops the section and block when they empty", () => {
    // A plugin belongs to one section; the planner refuses duplicates, so the
    // editor is exercised with a distinct name.
    const added = editManifestPlugin(manifest, "tui", "other-plugin", "add")
    const parsedAdded = parseArchetypeDocument(added)
    expect(parsedAdded.ok && parsedAdded.manifest.plugins).toEqual({
      ellamaka: ["wopal-plugin"],
      tui: ["other-plugin"],
    })

    const removed = editManifestPlugin(manifest, "ellamaka", "wopal-plugin", "remove")
    const parsedRemoved = parseArchetypeDocument(removed)
    expect(parsedRemoved.ok).toBe(true)
    expect(parsedRemoved.ok && parsedRemoved.manifest.plugins).toEqual({})
    expect(removed).not.toContain("plugins:")
  })

  it("rewrites a flow-style list in place", () => {
    const flow = ["version: 1", "type: coding", "skills: [a, b]", ""].join("\n")
    const next = editManifestList(flow, "skills", "c", "add")
    const parsed = parseArchetypeDocument(next)
    expect(parsed.ok && parsed.manifest.skills).toEqual(["a", "b", "c"])
  })

  it("is a no-op when the name is already present or absent", () => {
    expect(editManifestList(manifest, "skills", "dev-flow", "add")).toBe(manifest)
    expect(editManifestList(manifest, "skills", "missing", "remove")).toBe(manifest)
    expect(editManifestPlugin(manifest, "ellamaka", "wopal-plugin", "add")).toBe(manifest)
  })

  it("keeps an inline comment on an untouched list item", () => {
    const withInline = ["version: 1", "type: coding", "skills:", "  - dev-flow # keep", "  - other", ""].join("\n")
    const next = editManifestList(withInline, "skills", "other", "remove")
    expect(next).toContain("  - dev-flow # keep")
  })

  it("refuses an edit that would change another field or drop a comment", () => {
    const before = "version: 1\ntype: coding\nskills:\n  - a\n"
    const wrong = "version: 1\ntype: content\nskills:\n  - a\n  - b\n"
    const changedElsewhere = verifyManifestEdit(before, wrong, (previous, next) =>
      onlyFieldChanged(previous, next, "skills"),
    )
    expect(changedElsewhere).toBe("the edit would change more than the intended reference")

    const commentDrop = verifyManifestEdit(
      "version: 1\ntype: coding\n# keep\nskills:\n  - a\n",
      "version: 1\ntype: coding\nskills:\n  - a\n",
      (previous, next) => onlyFieldChanged(previous, next, "skills"),
    )
    expect(commentDrop).toContain("comments")
  })

  it("treats a repeated name as idempotent", () => {
    const once = editManifestList(manifest, "skills", "third", "add")
    const twice = editManifestList(once, "skills", "third", "add")
    expect(twice).toBe(once)
    const parsed = parseArchetypeDocument(twice)
    expect(parsed.ok && parsed.manifest.skills.filter((name) => name === "third")).toEqual(["third"])
  })
})
