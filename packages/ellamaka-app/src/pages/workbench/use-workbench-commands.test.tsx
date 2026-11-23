import { describe, expect, test } from "bun:test"

/**
 * The legacy `showFileTree` setting and its `fileTree.toggle` command were
 * removed entirely: the sidebar file tree is a first-class nav view with no
 * master switch. This regression guards against reintroducing the legacy
 * wiring (settings state, layout toggle, or a display-state switch command).
 *
 * Coverage boundary: `useWorkbenchCommands` is a hook over the full Workbench
 * provider/harness stack, so this gates the wiring at the source level
 * (the `panel-chat-route.test.ts` convention).
 */
describe("fileTree legacy wiring removal", () => {
  test("registers no fileTree.toggle command and reads no legacy state", async () => {
    const source = await Bun.file(new URL("./use-workbench-commands.tsx", import.meta.url)).text()

    expect(source).not.toContain("fileTree.toggle")
    expect(source).not.toContain("showFileTree")
    expect(source).not.toContain("layout.fileTree")
  })
})
