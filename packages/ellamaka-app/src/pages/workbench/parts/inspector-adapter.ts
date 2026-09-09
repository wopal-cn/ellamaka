import { base64Encode } from "@wopal/ellamaka-core/util/encode"

/**
 * Pure helpers for the Workbench file inspector, kept in a standalone module so
 * unit tests can exercise routing, state resolution and scroll sync without
 * pulling the heavy file-component and its context graph into the test bundle.
 *
 * Owner: Workbench file inspector
 * Deletion condition: never (lives with the inspector)
 */

/**
 * Stable router identity for a file viewer session, mirroring panelChatRoute:
 * the directory and file path are base64-encoded into a route that supplies the
 * `dir` / `id` params consumed by FileProvider / CommentsProvider / PromptProvider.
 * `key` changes whenever the directory or file changes so the viewer remounts
 * cleanly and stale provider state cannot leak between files.
 */
export function fileViewerRoute(directory: string, path: string) {
  const viewPath = `/${base64Encode(directory)}/viewer/${base64Encode(path)}`
  return { key: `${directory}\n${path}`, path: viewPath }
}

export type FileViewerState = "loading" | "error" | "loaded" | "empty"

/**
 * Resolves the single source of truth for what to render in a file viewer.
 * Priority: loaded, then error, then loading, else empty.
 */
export function resolveFileViewerState(input: {
  loaded?: boolean
  loading?: boolean
  error?: string
}): FileViewerState {
  if (input.loaded) return "loaded"
  if (input.error) return "error"
  if (input.loading) return "loading"
  return "empty"
}

export type FileScrollPos = { x: number; y: number }

export type OpenedFileEntry = {
  directory: string
  filePath: string
  name?: string
}

/**
 * A tab in the generic right-hand workbench surface. `file` is the only kind
 * today; future content types (diffs, previews, ...) extend the union with a
 * new `kind` and their own identity fields.
 */
export type FileSurfaceTab = { kind: "file" } & OpenedFileEntry

export type SurfaceTab =
  | FileSurfaceTab
  | { kind: Exclude<string, "file">; id: string }

/**
 * Selector-safe tab identity for an arbitrary surface tab: the kind namespace
 * plus the kind-specific identity, encoded the same way as file tab keys so
 * every key stays safe inside Kobalte's attribute selectors.
 */
export function surfaceTabKey(tab: SurfaceTab): string {
  if ("filePath" in tab) return `f-${viewerTabKey(tab)}`
  const extra = tab as { id?: unknown }
  return `k-${encodeTabKey(`${tab.kind}\n${String(extra.id)}`)}`
}

/**
 * Opens a tab in the generic surface's tab list. Clicking an already-open tab
 * only activates it (activation is derived by the caller); a new tab is
 * appended. Dedupe is key-based so mixed kinds cannot collide.
 */
export function openSurfaceTab<T extends SurfaceTab>(tabs: T[], tab: T): T[] {
  const key = surfaceTabKey(tab)
  return tabs.some((candidate) => surfaceTabKey(candidate) === key) ? tabs : [...tabs, tab]
}

/**
 * Removes a tab and resolves which tab becomes active after the close.
 * Mirrors closeViewerTab for the generic union: closing the active tab
 * activates its right neighbour (or the last tab after removal); closing a
 * background tab keeps the current selection. Returns `undefined` activeKey
 * when no tabs remain.
 */
export function closeSurfaceTab(
  tabs: SurfaceTab[],
  activeKey: string,
  closedKey: string,
): { tabs: SurfaceTab[]; activeKey?: string } {
  const closedIndex = tabs.findIndex((tab) => surfaceTabKey(tab) === closedKey)
  if (closedIndex === -1) return { tabs, activeKey }
  const next = tabs.filter((tab) => surfaceTabKey(tab) !== closedKey)
  if (activeKey !== closedKey) return { tabs: next, activeKey }
  const fallbackIndex = Math.min(closedIndex, next.length - 1)
  const fallback = next[fallbackIndex]
  return { tabs: next, activeKey: fallback ? surfaceTabKey(fallback) : undefined }
}

export const INSPECTOR_MIN_WIDTH = 280
export const INSPECTOR_DEFAULT_WIDTH = 480
export const INSPECTOR_MAX_VIEWPORT_RATIO = 0.6

/**
 * Resolves the inspector panel width: clamped to [280px, 60% of viewport],
 * falling back to the 480px default for non-finite or non-positive input so a
 * corrupted persisted value can never break the layout.
 */
export function clampInspectorWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width) || width <= 0) return INSPECTOR_DEFAULT_WIDTH
  const max = Math.max(INSPECTOR_MIN_WIDTH, viewportWidth * INSPECTOR_MAX_VIEWPORT_RATIO)
  return Math.min(Math.max(width, INSPECTOR_MIN_WIDTH), max)
}

/**
 * Local URL-safe base64 (RFC 4648 §5) that does not depend on
 * `@wopal/ellamaka-core/util/encode`. Test suites elsewhere mock that module
 * globally with a pass-through `base64Encode`, and Bun's `mock.module` leaks
 * across test files in a full-suite run — a selector-safe key must never
 * regress to the raw path under such a mock.
 */
function encodeTabKey(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Selector-safe tab identity. Kobalte's Tabs.List locates the selected tab
 * with `querySelector(\`[data-key="${key}"]\`)`, so keys containing spaces,
 * quotes or backslashes produce an invalid CSS selector and crash the whole
 * Workbench. Keys are therefore opaque base64 slugs derived from the
 * directory+path pair (safe charset: letters, digits, `-`, `=`, `_`), while
 * entries stay addressable by their raw parts.
 */
export function viewerTabKey(file: Pick<OpenedFileEntry, "directory" | "filePath">): string {
  return encodeTabKey(`${file.directory}\n${file.filePath}`)
}

/**
 * Opens a file in the floating viewer's tab list. Clicking an already-open
 * file only activates its tab (no duplicates); a new file is appended and
 * activated.
 */
export function openViewerFile(tabs: OpenedFileEntry[], file: OpenedFileEntry): OpenedFileEntry[] {
  return tabs.some((tab) => tab.filePath === file.filePath && tab.directory === file.directory)
    ? tabs
    : [...tabs, file]
}

/**
 * Removes a tab and resolves which tab becomes active after the close.
 * Closing the active tab activates its right neighbour (or the last tab
 * after removal); closing a background tab keeps the current selection.
 * Returns `undefined` activeKey when no tabs remain.
 */
export function closeViewerTab(
  tabs: OpenedFileEntry[],
  activeKey: string,
  closedKey: string,
): { tabs: OpenedFileEntry[]; activeKey?: string } {
  const closedIndex = tabs.findIndex((tab) => viewerTabKey(tab) === closedKey)
  if (closedIndex === -1) return { tabs, activeKey }
  const closed = tabs[closedIndex]
  const next = tabs.filter((tab) => tab.directory !== closed.directory || tab.filePath !== closed.filePath)
  if (activeKey !== closedKey) return { tabs: next, activeKey }
  const fallbackIndex = Math.min(closedIndex, next.length - 1)
  const fallback = next[fallbackIndex]
  return { tabs: next, activeKey: fallback ? viewerTabKey(fallback) : undefined }
}

/**
 * The read/write scroll interface consumed by the file viewer's scroll sync,
 * matching the `view` shape that createScrollSync expects ({ scroll, setScroll }).
 */
export type FileScroller = {
  scroll: (key: string) => FileScrollPos | undefined
  setScroll: (key: string, pos: FileScrollPos) => void
}

/**
 * Adapts primitive per-axis scroll getters/setters (the shape exposed by
 * `useFile(): scrollTop/scrollLeft/setScrollTop/setScrollLeft`) into the
 * combined { scroll, setScroll } interface, coalescing partial reads and
 * suppressing writes whose value is unchanged. Getters may be typed `unknown`
 * (the `useFile` context returns `unknown`); non-finite values are read as
 * unset.
 */
export function createFileScroller(input: {
  scrollTop: (key: string) => unknown
  scrollLeft: (key: string) => unknown
  setScrollTop: (key: string, top: number) => void
  setScrollLeft: (key: string, left: number) => void
}): FileScroller {
  const readX = (key: string) => {
    const value = input.scrollLeft(key)
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
  const readY = (key: string) => {
    const value = input.scrollTop(key)
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }

  return {
    scroll(key) {
      const x = readX(key)
      const y = readY(key)
      if (x === undefined && y === undefined) return undefined
      return { x: x ?? 0, y: y ?? 0 }
    },
    setScroll(key, pos) {
      const currentX = readX(key)
      const currentY = readY(key)
      if (currentX !== pos.x) input.setScrollLeft(key, pos.x)
      if (currentY !== pos.y) input.setScrollTop(key, pos.y)
    },
  }
}
