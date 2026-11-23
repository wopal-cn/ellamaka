import { describe, expect, test } from "bun:test"

/**
 * B-01 regression: the file viewer must load its file on the initial mount so
 * the panel never sits in a permanent "empty" state. The loading effect must
 * NOT be deferred past the first run.
 *
 * Coverage boundary: a full behavioral mount pulls the File/SDK provider stack
 * plus the `Dynamic` file component and `ScrollView` — that graph does not
 * render under the solid-js/h test harness (empty DOM even with module mocks).
 * Following the `panel-chat-route.test.ts` convention, the regression is gated
 * at the source level: if a future edit reintroduces `{ defer: true }` on the
 * `file.load` effect, this test fails. A behavioral mount test would require a
 * dedicated component harness and is tracked as a follow-up.
 */
describe("FileViewerPanel load-on-mount (B-01)", () => {
  test("triggers file.load on the initial effect run (not deferred)", async () => {
    const source = await Bun.file(new URL("./inspector-panel.tsx", import.meta.url)).text()

    // The load effect must not defer past mount. `defer: true` would leave the
    // viewer permanent "empty" until the path changes, which never happens here.
    const idx = source.indexOf("void file.load(path())")
    expect(idx).toBeGreaterThan(-1)
    // Assert on the whole `createEffect(on(path, ...))` block, not a narrow
    // window: `{ defer: true }` lives in the options argument and may sit far
    // from `file.load` if the callback grows (formatting, comments, params).
    const before = source.slice(0, idx)
    const effectStart = before.lastIndexOf("createEffect(")
    const effectBlock = source.slice(effectStart, idx + "void file.load(path())".length)
    expect(effectBlock.startsWith("createEffect(")).toBe(true)
    expect(effectBlock).not.toMatch(/defer\s*:/)

    // The loader is wired to the current file path (not a stale captured path).
    expect(source).toContain("void file.load(path())")
  })
})

/**
 * B-02: clicking anywhere outside the inspector hides the panel while its tabs
 * stay intact. The contract spans three files (source-gated because the full
 * inspector render does not mount under the solid-js/h harness, see B-01):
 * - `inspector-panel.tsx` attaches a capture-phase document mousedown listener
 *   that calls `onDismiss` for outside presses. Capture wins over any click
 *   handler that would reopen the panel (e.g. a file-tree selection). The
 *   guard consults the composed path (shadow-DOM presses count as "inside")
 *   and skips presses on the topbar toggle marked `data-inspector-toggle`,
 *   so the icon's own toggle is never raced into a hide-then-reopen.
 * - `top-bar.tsx` marks the file-viewer icon with `data-inspector-toggle`.
 * - `index.tsx` wires `onDismiss` to `setDisplay("showFileViewer", false)`,
 *   keeping `showFileViewer` as the single show/hide owner (AGENTS.md §5.1).
 */
describe("WorkbenchInspector outside-click dismiss (B-02)", () => {
  test("dismissing a press outside the panel hides it without clearing tabs", async () => {
    const source = await Bun.file(new URL("./inspector-panel.tsx", import.meta.url)).text()

    // The listener is registered in the capture phase so an outside press wins
    // over any click that would reopen the panel (e.g. a file-tree selection).
    expect(source).toMatch(/document\.addEventListener\(["'](?:mousedown|pointerdown)["'], .*?, \{ capture: true \}\)/)

    // A press landing inside the panel must not dismiss: the guard consults the
    // composed path, which includes shadow-DOM nodes below the panel root.
    expect(source).toMatch(/composedPath\(\)/)
    expect(source).toMatch(/path\.includes\(root\)/)

    // Dismiss hides the panel (display flag) instead of closing tabs: the
    // close-all button keeps its explicit `onClose` contract, outside presses
    // go through a separate dismiss callback.
    expect(source).toMatch(/props\.onDismiss\(\)/)
    expect(source).not.toMatch(/path\.includes\(root\)[^}]*props\.onClose\(\)/)

    // The topbar toggle is exempt from dismissal so its own click can toggle.
    expect(source).toMatch(/closest\("\[data-inspector-toggle\]"\)/)
  })

  test("cleanup removes the outside-pointer listener on unmount", async () => {
    const source = await Bun.file(new URL("./inspector-panel.tsx", import.meta.url)).text()
    expect(source).toMatch(/addEventListener\(/)
    expect(source).toMatch(/removeEventListener\(/)

    // The resize interaction must not dismiss on release: mousedown on the
    // panel's own resize handle lies inside the panel, so it is excluded; the
    // drag itself is a pointer move, never a dismissal trigger.
    expect(source).toMatch(/cursor-col-resize/)
  })

  test("topbar toggle mirrors tab existence: blue when tabs exist, disabled when empty", async () => {
    const topbar = await Bun.file(new URL("./top-bar.tsx", import.meta.url)).text()
    // The file-viewer icon opts out of outside-dismiss; the shell decides the
    // toggle semantics.
    expect(topbar).toMatch(/data-inspector-toggle/)

    // Icon state mirrors the terminal-icon convention: blue (accent) only when
    // tabs exist, grey and inert when the inspector holds no tabs. Toggle
    // decision delegates to the Shell via the surface context instead of
    // writing the display flag directly.
    expect(topbar).toMatch(/disabled=\{!surface\.hasTabs\(\)\}/)
    expect(topbar).toMatch(/color: surface\.hasTabs\(\) \? "var\(--v2-icon-icon-accent\)"/)
    expect(topbar).toMatch(/onClick=\{\(\) => surface\.toggleVisibility\(\)\}/)
    expect(topbar).not.toMatch(/setDisplay\("showFileViewer"/)
  })

  test("shell owns surface state and wires dismiss + toggle context", async () => {
    const shell = await Bun.file(new URL("../index.tsx", import.meta.url)).text()
    // Hiding goes through the display flag; tabs and activeKey stay untouched.
    expect(shell).toMatch(/onDismiss=\{.*setDisplay\("showFileViewer", false\)/s)

    // The Shell is the single surface-state owner: it derives hasTabs from its
    // store, exposes visibility from the display flag, and owns the toggle.
    expect(shell).toMatch(/WorkbenchSurfaceProvider/)
    expect(shell).toMatch(/hasTabs=\{\(\) => surfaceTabs\(\)\.length > 0\}/)
    expect(shell).toMatch(
      /toggleVisibility=\{\(\) => wb\.setDisplay\("showFileViewer", !wb\.display\(\)\.showFileViewer\)\}/,
    )
  })

  test("pin action keeps the panel immune to outside-click dismissal", async () => {
    const source = await Bun.file(new URL("./inspector-panel.tsx", import.meta.url)).text()

    // The pin toggle flips the Shell-owned pinned state via props callback.
    expect(source).toMatch(/onPinnedChange: \(pinned: boolean\) => void/)
    expect(source).toMatch(/onClick=\{\(\) => setPinned\(!pinned\(\)\)\}/)

    // Pin affordance follows the icon-state convention: blue + pressed while
    // pinned, ghost-muted otherwise.
    expect(source).toMatch(/pinned\(\) \? "var\(--v2-icon-icon-accent\)" : undefined/)
    expect(source).toMatch(/state=\{pinned\(\) \? "pressed" : undefined\}/)

    // The outside-click listener short-circuits on pinned panels: the guard
    // runs before composedPath, and pinned panels never call onDismiss.
    const guardIdx = source.indexOf("if (pinned()) return")
    expect(guardIdx).toBeGreaterThan(-1)
    const block = source.slice(guardIdx, guardIdx + 400)
    expect(block).toMatch(/props\.onDismiss\(\)/)
    expect(block.indexOf("return")).toBeLessThan(block.indexOf("props.onDismiss()"))

    // i18n labels for the pin button exist.
    expect(source).toMatch(/workbench\.fileViewer\.pin/)
    expect(source).toMatch(/workbench\.fileViewer\.unpin/)
  })

  test("shell persists pinned in surfaceStore and wires it through", async () => {
    const shell = await Bun.file(new URL("../index.tsx", import.meta.url)).text()
    // Pinned is Shell-owned layout state, stored with expanded and persisted.
    expect(shell).toMatch(/pinned: boolean/)
    expect(shell).toMatch(/onPinnedChange=\{\(pinned\) => setSurfaceStore\("pinned", pinned\)\}/)

    const en = await Bun.file(new URL("../../../i18n/en.ts", import.meta.url)).text()
    expect(en).toMatch(/"workbench\.fileViewer\.pin": "Pin panel"/)
    expect(en).toMatch(/"workbench\.fileViewer\.unpin": "Unpin panel"/)
  })
})
