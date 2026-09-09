import { IconButtonV2 } from "@wopal/ui/v2/components/icon-button-v2.jsx"
import { Tabs } from "@wopal/ui/tabs"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import type { FileSearchHandle } from "@wopal/ui/file"
import { useFileComponent } from "@wopal/ui/context/file"
import { ScrollView } from "@wopal/ui/scroll-view"
import { makeEventListener } from "@solid-primitives/event-listener"
import { sampledChecksum } from "@wopal/ellamaka-core/util/encode"
import { previewSelectedLines } from "@wopal/ui/pierre/selection-bridge"
import { findFileLineNumber, readShadowLineSelection } from "@wopal/ui/pierre/file-selection"
import { FileProvider, useFile, type SelectedLineRange } from "@/context/file"
import { selectionFromLines } from "@/context/file/types"
import { useLanguage } from "@/context/language"
import { WorkbenchPanelDirectoryProvider } from "../workbench-directory-provider"
import { useWorkbenchPromptRegistry } from "../workbench-prompt-registry"
import {
  clampInspectorWidth,
  createFileScroller,
  fileViewerRoute,
  resolveFileViewerState,
  surfaceTabKey,
  type FileScroller,
  type FileScrollPos,
  type OpenedFileEntry,
  type FileSurfaceTab,
  type SurfaceTab,
} from "./inspector-adapter"

/**
 * Workbench file inspector panel (read-only reference viewer).
 *
 * Renders a single file with the shared `FileComponent` in text mode, syncing
 * the scroll position through the pure `FileScroller` adapter (backed by
 * `useFile`). Selecting a range of lines in the file lets the user attach a
 * short note which is pushed into the active chat Panel's prompt context (the
 * note is editable/deletable from the chat input, not inside this viewer).
 * The v2 header owns the close affordance.
 */

type FileViewerInnerProps = {
  filePath: string
  name: string
}

function FileViewerInner(props: FileViewerInnerProps) {
  const file = useFile()
  const language = useLanguage()
  const fileComponent = useFileComponent()

  let find: FileSearchHandle | null = null
  const search = {
    register: (handle: FileSearchHandle | null) => {
      find = handle
    },
  }

  const path = () => props.filePath
  const state = createMemo(() => file.get(path()))
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))

  // -- note-to-chat: select lines, add a short note, push it into the active
  // chat Panel's prompt context. The note is edited/deleted in the chat input,
  // never inside this viewer.
  const registry = useWorkbenchPromptRegistry()
  const [noteRange, setNoteRange] = createSignal<SelectedLineRange | null>(null)
  const [noteText, setNoteText] = createSignal("")

  let noteInput: HTMLTextAreaElement | null = null

  const addNoteToContext = (selection: SelectedLineRange, comment: string) => {
    const trimmed = comment.trim()
    if (!trimmed) return
    const p = path()
    if (!p) return
    const preview = previewSelectedLines(contents(), {
      start: selection.start,
      end: selection.end,
    })
    registry.activePrompt()?.context.add({
      type: "file",
      path: p,
      selection: selectionFromLines(selection),
      comment: trimmed,
      commentOrigin: "file",
      ...(preview ? { preview } : {}),
    })
    setNoteRange(null)
    setNoteText("")
  }

  const dismissNote = () => {
    setNoteRange(null)
    setNoteText("")
  }

  const confirmNote = () => {
    const range = noteRange()
    if (!range) return
    addNoteToContext(range, noteText())
  }

  // Scroll sync backed by the pure FileScroller adapter over useFile primitives.
  const scroller: FileScroller = createFileScroller({
    scrollTop: (key) => file.scrollTop(key),
    scrollLeft: (key) => file.scrollLeft(key),
    setScrollTop: (key, top) => file.setScrollTop(key, top),
    setScrollLeft: (key, left) => file.setScrollLeft(key, left),
  })

  let viewport: HTMLDivElement | undefined
  let pending: FileScrollPos | undefined
  let scrollFrame: number | undefined
  let restoreFrame: number | undefined

  const save = (next: FileScrollPos) => {
    pending = next
    if (scrollFrame !== undefined) return
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined
      const out = pending
      pending = undefined
      if (!out) return
      scroller.setScroll(path(), out)
    })
  }

  /** Best-effort horizontal code container lookup for x-scroll sync. */
  const codeContainer = (): HTMLElement | undefined => {
    const el = viewport
    if (!el) return undefined
    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return undefined
    const root = host.shadowRoot
    if (!root) return undefined
    return (
      Array.from(root.querySelectorAll("[data-code]")).find(
        (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
      ) ?? undefined
    )
  }

  const restore = () => {
    const el = viewport
    if (!el) return
    const pos = scroller.scroll(path())
    if (!pos) return
    if (el.scrollTop !== pos.y) el.scrollTop = pos.y
    const code = codeContainer()
    if (code && code.scrollLeft !== pos.x) code.scrollLeft = pos.x
    else if (!code && el.scrollLeft !== pos.x) el.scrollLeft = pos.x
  }

  const queueRestore = () => {
    if (restoreFrame !== undefined) return
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      restore()
    })
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const el = event.currentTarget
    const code = codeContainer()
    save(code ? { x: code.scrollLeft, y: el.scrollTop } : { x: el.scrollLeft, y: el.scrollTop })
  }

  const setViewport = (el: HTMLDivElement) => {
    viewport = el
    viewportEl = el
    restore()
  }

  createEffect(
    on(
      path,
      () => {
        void file.load(path())
      },
    ),
  )

  createEffect(() => {
    if (state()?.loaded && file.ready()) queueRestore()
  })

  createEffect(() => {
    if (typeof window === "undefined") return

    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "f") return
      event.preventDefault()
      event.stopPropagation()
      find?.focus()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const viewState = () =>
    resolveFileViewerState({
      loaded: state()?.loaded,
      loading: state()?.loading,
      error: state()?.error,
    })

  let viewportEl: HTMLDivElement | undefined

  const viewerRoot = (): ShadowRoot | undefined => {
    const el = viewportEl
    if (!el) return undefined
    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return undefined
    return host.shadowRoot ?? undefined
  }

  // Detect a completed text selection inside the viewer and surface the
  // note-to-chat input. Text selection lives in the pierre shadow root, so we
  // read it through the same selection-bridge primitives the code viewer uses.
  createEffect(() => {
    if (typeof window === "undefined") return
    if (!file.ready()) return

    const onMouseUp = () => {
      const root = viewerRoot()
      if (!root) return
      const selection = readShadowLineSelection({
        root,
        lineForNode: findFileLineNumber,
      })
      if (!selection) return
      setNoteRange(selection.range)
      setNoteText("")
      requestAnimationFrame(() => noteInput?.focus())
    }

    makeEventListener(window, "mouseup", onMouseUp, { capture: true })
  })

  const renderFile = (source: string) => (
    <div
      class="relative overflow-hidden"
      // The inspector is a plain reader: the upstream line-hover highlight is
      // presentation noise here, so we neutralize the pierre hover token for
      // this panel only (session review and diffs keep their behavior).
      style={{ "--diffs-bg-hover-override": "transparent" }}
    >
      <Dynamic
        component={fileComponent}
        mode="text"
        file={{
          name: props.name,
          contents: source,
          cacheKey: cacheKey(),
        }}
        // Line highlight owned by the note bar: purely visual and focus-free,
        // so it persists while the user types in the note input.
        selectedLines={noteRange()}
        onRendered={queueRestore}
        search={search}
        class="select-text"
        media={{
          mode: "auto",
          path: path(),
          current: state()?.content,
          onLoad: queueRestore,
        }}
      />
    </div>
  )

  const noteOpen = () => noteRange() != null
  const noteLabel = createMemo(() => {
    const range = noteRange()
    if (!range) return ""
    const start = Math.min(range.start, range.end)
    const end = Math.max(range.start, range.end)
    if (start === end) return language.t("workbench.fileViewer.line", { line: start })
    return language.t("workbench.fileViewer.lines", { start, end })
  })

  return (
    <div class="flex h-full min-h-0 flex-col">
      <ScrollView class="h-full flex-1 min-h-0" viewportRef={setViewport} onScroll={handleScroll}>
        <Switch>
          <Match when={viewState() === "loaded"}>{renderFile(contents())}</Match>
          <Match when={viewState() === "loading"}>
            <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
          </Match>
          <Match when={viewState() === "error"}>
            <div class="px-6 py-4 text-text-weak">{state()?.error}</div>
          </Match>
          <Match when={viewState() === "empty"}>
            <div class="px-6 py-4 text-text-weak">{language.t("session.files.empty")}</div>
          </Match>
        </Switch>
      </ScrollView>
      <Show when={noteOpen()}>
        <div class="shrink-0 border-t border-v2-border-border-base bg-v2-background-bg-base px-3 py-2">
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="text-11-medium text-v2-text-text-weak">{noteLabel()}</span>
            <button
              type="button"
              class="text-11-medium text-v2-text-text-weak hover:text-v2-text-text-strong"
              onClick={dismissNote}
            >
              {language.t("common.cancel")}
            </button>
          </div>
          <div class="flex items-center gap-2">
            <textarea
              ref={(el) => {
                noteInput = el
              }}
              value={noteText()}
              onInput={(event) => setNoteText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  confirmNote()
                }
                if (event.key === "Escape") dismissNote()
              }}
              rows={2}
              placeholder={language.t("workbench.fileViewer.notePlaceholder")}
              class="flex-1 min-w-0 resize-none rounded border border-v2-border-border-base bg-v2-background-bg-subtle px-2 py-1 text-12 text-v2-text-text-base placeholder:text-v2-text-text-weak focus:outline-none focus:border-v2-icon-icon-brand"
            />
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              class="size-6 shrink-0"
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              }
              aria-label={language.t("workbench.fileViewer.submitNote")}
              title={language.t("workbench.fileViewer.submitNote")}
              onClick={confirmNote}
            />
          </div>
        </div>
      </Show>
    </div>
  )
}

function FileViewerTabContent(props: { entry: OpenedFileEntry }) {
  const route = createMemo(() => fileViewerRoute(props.entry.directory, props.entry.filePath))

  return (
    <WorkbenchPanelDirectoryProvider panelID={route().key} directory={props.entry.directory}>
      {() => (
        <FileProvider>
          <FileViewerInner
            filePath={props.entry.filePath}
            name={props.entry.name ?? props.entry.filePath}
          />
        </FileProvider>
      )}
    </WorkbenchPanelDirectoryProvider>
  )
}

function isFileTab(tab: SurfaceTab): tab is FileSurfaceTab {
  return tab.kind === "file"
}

/**
 * Renders the content of one surface tab. New tab kinds plug in here: add the
 * kind to `SurfaceTab`, then a Match branch dispatching to its component.
 */
function SurfaceTabContent(props: { tab: SurfaceTab }) {
  const fileTab = createMemo(() => (isFileTab(props.tab) ? props.tab : undefined))
  return (
    <Switch>
      <Match when={fileTab()}>
        {(tab) => <FileViewerTabContent entry={tab()} />}
      </Match>
    </Switch>
  )
}

export function WorkbenchInspector(props: {
  tabs: SurfaceTab[]
  activeKey: string
  onActiveKeyChange: (key: string) => void
  onWidthChange: (width: number) => void
  width: number
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  pinned: boolean
  onPinnedChange: (pinned: boolean) => void
  onCloseTab: (key: string) => void
  onClose: () => void
  /** Outside presses hide the panel without touching its tabs. */
  onDismiss: () => void
}) {
  const language = useLanguage()
  const expanded = () => props.expanded
  const setExpanded = (next: boolean) => props.onExpandedChange(next)
  const pinned = () => props.pinned
  const setPinned = (next: boolean) => props.onPinnedChange(next)

  let resizing = false
  let rafId: number | null = null
  let rootEl: HTMLDivElement | undefined

  // Outside presses hide the panel (tabs survive). Registered in the capture
  // phase so an outside press wins over any click handler on the target that
  // would reopen it (e.g. a file-tree selection). The guard consults the
  // composed path so presses inside the pierre shadow root count as "inside",
  // and skips the topbar toggle, which owns its own show/hide semantics.
  onMount(() => {
    const onOutsidePointer = (event: MouseEvent) => {
      if (pinned()) return
      const root = rootEl
      if (!root) return
      const target = event.target
      if (target instanceof Element && target.closest("[data-inspector-toggle]")) return
      const path = event.composedPath()
      if (path.includes(root)) return
      props.onDismiss()
    }
    document.addEventListener("mousedown", onOutsidePointer, { capture: true })
    onCleanup(() => document.removeEventListener("mousedown", onOutsidePointer, { capture: true }))
  })

  onCleanup(() => {
    if (rafId !== null) cancelAnimationFrame(rafId)
  })

  function startResize(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    resizing = true
    const onMove = (event: MouseEvent) => {
      if (!resizing) return
      event.preventDefault()
      // The panel is anchored to the right edge: growing it means dragging left.
      const viewport = window.innerWidth
      const next = clampInspectorWidth(viewport - event.clientX, viewport)
      if (rafId !== null) return
      pendingNextWidth = next
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (pendingNextWidth === null) return
        props.onWidthChange(pendingNextWidth)
        pendingNextWidth = null
      })
    }
    const onUp = () => {
      resizing = false
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    let pendingNextWidth: number | null = null
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  return (
    <div
      ref={rootEl}
      data-component="workbench-inspector-surface"
      class={`absolute z-40 flex flex-col overflow-hidden rounded-lg border border-v2-border-border-base bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)] ${
        expanded() ? "inset-2" : "top-2 bottom-2 right-2 w-[480px] max-w-[50vw]"
      }`}
      style={expanded() ? undefined : { width: `${props.width}px`, "max-width": "60vw" }}
    >
      <Show when={!expanded()}>
        <div
          class="absolute top-0 bottom-0 left-0 w-1.5 cursor-col-resize z-50 hover:bg-v2-icon-icon-brand/30 transition-colors"
          aria-hidden="true"
          onMouseDown={startResize}
        />
      </Show>
      <Tabs
        value={props.activeKey}
        onChange={props.onActiveKeyChange}
        variant="pill"
        class="flex flex-col h-full min-h-0"
      >
        <div class="flex shrink-0 items-center border-b border-v2-border-border-base bg-v2-background-bg-base">
          <Show when={props.tabs.length > 0}>
            <Tabs.List class="flex-1 min-w-0 overflow-x-auto">
              <For each={props.tabs}>
                {(tab) => {
                  const key = surfaceTabKey(tab)
                  const fileTab = isFileTab(tab) ? tab : undefined
                  return (
                    <Tabs.Trigger
                      value={key}
                      class="max-w-[180px]"
                      closeButton={
                        <IconButtonV2
                          variant="ghost-muted"
                          size="small"
                          class="size-4 flex items-center justify-center p-0 shrink-0"
                          icon={
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M6 6l12 12M18 6L6 18" />
                            </svg>
                          }
                          aria-label={language.t("workbench.fileViewer.close")}
                          onClick={() => props.onCloseTab(key)}
                        />
                      }
                    >
                      <span class="text-12-medium truncate">{fileTab?.name ?? fileTab?.filePath ?? tab.kind}</span>
                    </Tabs.Trigger>
                  )
                }}
              </For>
            </Tabs.List>
          </Show>
          <div class="ml-auto flex shrink-0 items-center gap-1 pr-2 pl-2">
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              class="size-5 flex items-center justify-center p-0 shrink-0"
              style={{ color: pinned() ? "var(--v2-icon-icon-accent)" : undefined }}
              state={pinned() ? "pressed" : undefined}
              icon={
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <Show
                    when={pinned()}
                    fallback={<path d="M12 17v5M9 3h6l1 7 3 3H5l3-3z" />}
                  >
                    <path d="M12 17v5M9 3h6l1 7 3 3H5l3-3zM12 17v5" />
                  </Show>
                </svg>
              }
              aria-label={language.t(pinned() ? "workbench.fileViewer.unpin" : "workbench.fileViewer.pin")}
              title={language.t(pinned() ? "workbench.fileViewer.unpin" : "workbench.fileViewer.pin")}
              onClick={() => setPinned(!pinned())}
            />
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              class="size-5 flex items-center justify-center p-0 shrink-0"
              icon={
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <Show
                    when={expanded()}
                    fallback={<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}
                  >
                    <path d="M9 3H3v6M15 21h6v-6M3 3l6 6M21 21l-7-7" />
                  </Show>
                </svg>
              }
              aria-label={language.t(expanded() ? "workbench.fileViewer.collapse" : "workbench.fileViewer.expand")}
              title={language.t(expanded() ? "workbench.fileViewer.collapse" : "workbench.fileViewer.expand")}
              onClick={() => setExpanded(!expanded())}
            />
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              class="size-5 flex items-center justify-center p-0 shrink-0"
              icon={
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              }
              aria-label={language.t("workbench.fileViewer.closeAll")}
              title={language.t("workbench.fileViewer.closeAll")}
              onClick={props.onClose}
            />
          </div>
        </div>
        <For each={props.tabs}>
          {(tab) => {
            const key = surfaceTabKey(tab)
            return (
              <Tabs.Content value={key} class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
                <SurfaceTabContent tab={tab} />
              </Tabs.Content>
            )
          }}
        </For>
      </Tabs>
    </div>
  )
}

export function FileViewerPanel(props: {
  directory: string
  filePath: string
  name?: string
  onClose: () => void
}) {
  const route = createMemo(() => fileViewerRoute(props.directory, props.filePath))
  const language = useLanguage()

  return (
    <WorkbenchPanelDirectoryProvider panelID={route().key} directory={props.directory}>
      {() => (
        <FileProvider>
          <div class="flex flex-col h-full min-h-0 bg-v2-background-bg-base border-l border-v2-border-border-base">
            <header class="flex h-7 shrink-0 items-center justify-between px-3 border-b border-v2-border-border-base bg-v2-background-bg-base">
              <span class="text-11-medium text-v2-text-text-strong truncate">{props.name ?? props.filePath}</span>
              <IconButtonV2
                variant="ghost-muted"
                size="small"
                class="size-5 flex items-center justify-center p-0 shrink-0"
                icon={
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                }
                aria-label={language.t("workbench.fileViewer.close")}
                title={language.t("workbench.fileViewer.close")}
                onClick={props.onClose}
              />
            </header>
            <div class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
              <FileViewerInner filePath={props.filePath} name={props.name ?? props.filePath} />
            </div>
          </div>
        </FileProvider>
      )}
    </WorkbenchPanelDirectoryProvider>
  )
}
