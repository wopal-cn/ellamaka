import { describe, expect, test } from "bun:test"

/**
 * The `showFileTree` setting and its `fileTree.toggle` command were removed
 * entirely (commit 54b9d14d7d): the sidebar file tree is a first-class nav
 * view with no master switch. The keybind settings list kept a leftover row
 * whose i18n key was deleted, rendering a blank entry with an "Unassigned"
 * badge. This regression guards the settings surface against reintroducing
 * the legacy wiring.
 */
describe("settings keybinds legacy wiring removal", () => {
  test("lists no fileTree.toggle entry and references no deleted i18n key", async () => {
    const source = await Bun.file(new URL("./settings-keybinds.tsx", import.meta.url)).text()

    expect(source).not.toContain("fileTree.toggle")
    expect(source).not.toContain("command.fileTree.toggle")
  })
})
