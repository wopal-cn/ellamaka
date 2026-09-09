import { useTheme } from "@wopal/ui/theme/context"
import { resolveThemeVariant } from "@wopal/ui/theme/resolve"
import { showToast } from "@wopal/ui/toast"
import type { FitAddon, Ghostty, Terminal as Term } from "ghostty-web"
import { type ComponentProps, createEffect, createMemo, onCleanup, onMount, splitProps } from "solid-js"
import { SerializeAddon } from "@/addons/serialize"
import { resolveTerminalTheme, type TerminalTheme } from "@/components/terminal-colors"
import { matchKeybind, parseKeybind } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { terminalFontFamily, useSettings } from "@/context/settings"
import type { LocalPTY } from "@/context/terminal"
import { fitTerminalToContainer, resetTerminalViewport } from "@/components/terminal-fit"
import { getTerminalImeFrame, updateTerminalImeComposition } from "@/components/terminal-ime-frame"
import { disableTerminalScrollbar, terminalColumnsWithoutScrollbar, terminalRowsForContainer, type TerminalFitMode } from "@/components/terminal-scrollbar"
import { isEllamakaTuiTitle, shouldUseTuiTerminalMode } from "@/components/terminal-tui-mode"
import { disposeIfDisposable, getHoveredLinkText, setOptionIfSupported } from "@/utils/runtime-adapters"
import { terminalWriter } from "@/utils/terminal-writer"
import { terminalWebSocketURL } from "@/utils/terminal-websocket-url"

const TOGGLE_TERMINAL_ID = "terminal.toggle"
const DEFAULT_TOGGLE_TERMINAL_KEYBIND = "ctrl+`"
export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  autoFocus?: boolean
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
  onClose?: () => void
  onTitleChange?: (title: string) => void
  noPadding?: boolean
  isTui?: boolean
}

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

const debugTerminal = (...values: unknown[]) => {
  if (!import.meta.env.DEV) return
  console.debug("[terminal]", ...values)
}

const useTerminalUiBindings = (input: {
  container: HTMLDivElement
  term: Term
  cleanups: VoidFunction[]
  handlePointerDown: () => void
  handleLinkClick: (event: MouseEvent) => void
  onSelectionCopied?: () => void
}) => {
  const handleCopy = (event: ClipboardEvent) => {
    const selection = input.term.getSelection()
    if (!selection) return

    const clipboard = event.clipboardData
    if (!clipboard) return

    event.preventDefault()
    clipboard.setData("text/plain", selection)
  }

  const handlePaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData
    const text = clipboard?.getData("text/plain") ?? clipboard?.getData("text") ?? ""
    if (!text) return

    event.preventDefault()
    event.stopPropagation()
    input.term.paste(text)
  }

  const handleTextareaFocus = () => {
    input.term.options.cursorBlink = true
  }
  const handleTextareaBlur = () => {
    input.term.options.cursorBlink = false
  }

  input.container.addEventListener("copy", handleCopy, true)
  input.cleanups.push(() => input.container.removeEventListener("copy", handleCopy, true))

  input.container.addEventListener("paste", handlePaste, true)
  input.cleanups.push(() => input.container.removeEventListener("paste", handlePaste, true))

  input.container.addEventListener("pointerdown", input.handlePointerDown)
  input.cleanups.push(() => input.container.removeEventListener("pointerdown", input.handlePointerDown))

  input.container.addEventListener("click", input.handleLinkClick, {
    capture: true,
  })
  input.cleanups.push(() =>
    input.container.removeEventListener("click", input.handleLinkClick, {
      capture: true,
    }),
  )

  input.term.textarea?.addEventListener("focus", handleTextareaFocus)
  input.term.textarea?.addEventListener("blur", handleTextareaBlur)
  input.cleanups.push(() => input.term.textarea?.removeEventListener("focus", handleTextareaFocus))
  input.cleanups.push(() => input.term.textarea?.removeEventListener("blur", handleTextareaBlur))

  // ghostty-web copies drag/double/triple-click selections to the clipboard on
  // mouseup and then fires onSelectionChange. Surface that as a toast so the
  // copy is discoverable, matching the TUI's "Copied to clipboard" feedback.
  // Track mouse interaction so programmatic selections (selectAll, clearSelection)
  // do not trigger the toast.
  let mouseActive = false
  const trackMouseDown = () => {
    mouseActive = true
  }
  input.container.addEventListener("mousedown", trackMouseDown, true)
  input.cleanups.push(() => input.container.removeEventListener("mousedown", trackMouseDown, true))

  const selectionSub = input.term.onSelectionChange(() => {
    if (!mouseActive) return
    mouseActive = false
    if (!input.term.hasSelection()) return
    if (!input.term.getSelection()) return
    input.onSelectionCopied?.()
  })
  input.cleanups.push(() => disposeIfDisposable(selectionSub))
}

const persistTerminal = (input: {
  term: Term | undefined
  addon: SerializeAddon | undefined
  cursor: number
  id: string
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
}) => {
  if (!input.addon || !input.onCleanup || !input.term) return
  const buffer = (() => {
    try {
      return input.addon.serialize()
    } catch {
      debugTerminal("failed to serialize terminal buffer")
      return ""
    }
  })()

  input.onCleanup({
    id: input.id,
    buffer,
    cursor: input.cursor,
    rows: input.term.rows,
    cols: input.term.cols,
    scrollY: input.term.getViewportY(),
  })
}

export const Terminal = (props: TerminalProps) => {
  const platform = usePlatform()
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  const server = useServer()
  const directory = sdk.directory
  const client = sdk.client
  const url = sdk.url
  const auth = server.current?.http
  const username = auth?.username ?? "opencode"
  const password = auth?.password ?? ""
  const sameOrigin = new URL(url, location.href).origin === location.origin
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "class",
    "classList",
    "autoFocus",
    "onConnect",
    "onConnectError",
    "onClose",
    "onTitleChange",
    "noPadding",
    "isTui",
    "onCleanup",
  ])
  const id = local.pty.id
  const restore = typeof local.pty.buffer === "string" ? local.pty.buffer : ""
  const restoreSize =
    restore &&
    typeof local.pty.cols === "number" &&
    Number.isSafeInteger(local.pty.cols) &&
    local.pty.cols > 0 &&
    typeof local.pty.rows === "number" &&
    Number.isSafeInteger(local.pty.rows) &&
    local.pty.rows > 0
      ? { cols: local.pty.cols, rows: local.pty.rows }
      : undefined
  const scrollY = typeof local.pty.scrollY === "number" ? local.pty.scrollY : undefined
  let ws: WebSocket | undefined
  let term: Term | undefined
  let _ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let imeOverlay: HTMLDivElement | undefined
  let handleResize: () => void
  let fitFrame: number | undefined
  let sizeTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSize: { cols: number; rows: number } | undefined
  let lastSize: { cols: number; rows: number } | undefined
  let disposed = false
  const cleanups: VoidFunction[] = []
  const start =
    typeof local.pty.cursor === "number" && Number.isSafeInteger(local.pty.cursor) ? local.pty.cursor : undefined
  let cursor = start ?? 0
  let seek = start !== undefined ? start : restore ? -1 : 0
  let output: ReturnType<typeof terminalWriter> | undefined
  let drop: VoidFunction | undefined
  let reconn: ReturnType<typeof setTimeout> | undefined
  let tries = 0

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch (err) {
        debugTerminal("cleanup failed", err)
      }
    }
  }

  const pushSize = (cols: number, rows: number) => {
    return client.pty
      .update(
        {
          ptyID: id,
          size: { cols, rows },
        },
        { throwOnError: false },
      )
      .then((res) => {
        if (res && (res.response.status === 404 || res.response.status === 405)) {
          local.onConnectError?.(new Error("PTY session not found"))
          local.onCleanup?.({ id })
        }
        return res
      })
      .catch((err) => {
        debugTerminal("failed to sync terminal size", err)
      })
  }

  const getTerminalColors = (): TerminalTheme => {
    const isDark = theme.mode() === "dark"
    const currentTheme = theme.themes()[theme.themeId()]
    const variant = currentTheme ? (isDark ? currentTheme.dark : currentTheme.light) : undefined
    const resolved = variant?.seeds || variant?.palette ? resolveThemeVariant(variant, isDark) : {}
    return resolveTerminalTheme(resolved, isDark)
  }

  const terminalColors = createMemo(getTerminalColors)

  const fitTerminal = () => {
    const t = term
    if (!t || !fitAddon) return
    // ghostty-web temporarily locks FitAddon.fit() after a resize. Font metrics can
    // settle during that lock, so apply the latest proposal directly instead of
    // allowing the only corrective fit to be dropped.
    fitTerminalToContainer({
      current: { cols: t.cols, rows: t.rows },
      propose: () => fitAddon.proposeDimensions(),
      resize: (cols, rows) => t.resize(cols, rows),
      viewport: container,
    })
  }

  const scheduleFit = () => {
    if (disposed) return
    if (!fitAddon) return
    if (fitFrame !== undefined) return

    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      if (disposed) return
      fitTerminal()
    })
  }

  const scheduleSize = (cols: number, rows: number) => {
    if (disposed) return
    if (lastSize?.cols === cols && lastSize?.rows === rows) return

    pendingSize = { cols, rows }

    if (!lastSize) {
      lastSize = pendingSize
      void pushSize(cols, rows)
      return
    }

    if (sizeTimer !== undefined) return
    sizeTimer = setTimeout(() => {
      sizeTimer = undefined
      const next = pendingSize
      if (!next) return
      pendingSize = undefined
      if (disposed) return
      if (lastSize?.cols === next.cols && lastSize?.rows === next.rows) return
      lastSize = next
      void pushSize(next.cols, next.rows)
    }, 100)
  }

  createEffect(() => {
    const colors = terminalColors()
    if (imeOverlay) {
      imeOverlay.style.color = colors.foreground
      imeOverlay.style.backgroundColor = colors.background
    }
    if (!term) return
    setOptionIfSupported(term, "theme", colors)
  })

  createEffect(() => {
    const font = terminalFontFamily(settings.appearance.terminalFont())
    if (imeOverlay) imeOverlay.style.fontFamily = font
    if (!term) return
    setOptionIfSupported(term, "fontFamily", font)
    scheduleFit()
  })

  let zoom = platform.webviewZoom?.()
  createEffect(() => {
    const next = platform.webviewZoom?.()
    if (next === undefined) return
    if (next === zoom) return
    zoom = next
    scheduleFit()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    t.textarea?.focus({ preventScroll: true })
    resetTerminalViewport(container)
    setTimeout(() => {
      t.textarea?.focus({ preventScroll: true })
      resetTerminalViewport(container)
    }, 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container && !container.contains(activeElement)) {
      activeElement.blur()
    }
    focusTerminal()
    requestAnimationFrame(() => {
      if (disposed) return
      resetTerminalViewport(container)
      focusTerminal()
    })
  }

  const handleLinkClick = (event: MouseEvent) => {
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return
    if (event.altKey) return
    if (event.button !== 0) return

    const t = term
    if (!t) return

    const text = getHoveredLinkText(t)
    if (!text) return

    event.preventDefault()
    event.stopImmediatePropagation()
    platform.openLink(text)
  }

  onMount(() => {
    const run = async () => {
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        cols: restoreSize?.cols,
        rows: restoreSize?.rows,
        fontSize: 14,
        fontFamily: terminalFontFamily(settings.appearance.terminalFont()),
        allowTransparency: false,
        convertEol: false,
        theme: terminalColors(),
        scrollback: local.isTui ? 0 : 10_000,
        ghostty: g,
      })

      // Ghostty maps alternate-screen wheel gestures to arrow keys. Require the
      // Ellamaka OSC title as well so vim, less, and other TUIs keep their own input.
      let isEllamakaTui = false
      let wasTuiMode = !!local.isTui
      const usesTuiMode = () =>
        shouldUseTuiTerminalMode({
          isDedicatedTui: !!local.isTui,
          isEllamakaTitle: isEllamakaTui,
          isAlternateBuffer: t.buffer.active.type === "alternate",
        })
      const syncTuiMode = () => {
        const next = usesTuiMode()
        if (next === wasTuiMode) return
        wasTuiMode = next
        scheduleFit()
      }

      t.attachCustomWheelEventHandler((e) => {
        if (!usesTuiMode()) return false

        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        const delta = e.deltaY
        if (delta === 0) return true

        if (ws && ws.readyState === WebSocket.OPEN) {
          const count = Math.min(5, Math.ceil(Math.abs(delta) / 40))
          const seq = delta < 0 ? "\x1b\x19" : "\x1b\x05"
          for (let i = 0; i < count; i++) {
            ws.send(seq)
          }
        }
        return true
      })

      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      _ghostty = g
      term = t
      output = terminalWriter((data, done) =>
        t.write(data, () => {
          done?.()
        }),
      )

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          document.execCommand("copy")
          return true
        }

        // allow for toggle terminal keybinds in parent
        const config = settings.keybinds.get(TOGGLE_TERMINAL_ID) ?? DEFAULT_TOGGLE_TERMINAL_KEYBIND
        const keybinds = parseKeybind(config)

        return matchKeybind(keybinds, event)
      })

      const fit = new mod.FitAddon()
      const proposeDimensions = fit.proposeDimensions.bind(fit)
      fit.proposeDimensions = () => {
        const dimensions = proposeDimensions()
        const metrics = t.renderer?.getMetrics()
        if (!dimensions || !metrics) return dimensions

        const styles = getComputedStyle(container)
        const fitMode: TerminalFitMode = usesTuiMode() ? "full-bleed" : "strict"
        const cols = terminalColumnsWithoutScrollbar({
          containerWidth: container.clientWidth,
          paddingLeft: Number.parseFloat(styles.paddingLeft) || 0,
          paddingRight: Number.parseFloat(styles.paddingRight) || 0,
          cellWidth: metrics.width,
          fitMode,
        })
        const rows = terminalRowsForContainer({
          containerHeight: container.clientHeight,
          paddingTop: Number.parseFloat(styles.paddingTop) || 0,
          paddingBottom: Number.parseFloat(styles.paddingBottom) || 0,
          cellHeight: metrics.height,
          fitMode,
        })
        if (!cols || !rows) return dimensions
        return { cols, rows }
      }
      const serializer = new SerializeAddon()
      cleanups.push(() => disposeIfDisposable(fit))
      t.loadAddon(serializer)
      t.loadAddon(fit)
      fitAddon = fit
      serializeAddon = serializer

      t.open(container)

      const renderer = t.renderer
      disableTerminalScrollbar(renderer)
      if (renderer) {
        // ghostty-web computes the canvas backing store as `cssSize * devicePixelRatio`
        // and scales the context by the raw dpr. When dpr is non-integral (e.g. macOS
        // Retina * Electron zoom 1.1 = 2.2), the backing store gets truncated to an
        // integer while the context scale stays fractional, so the compositor resamples
        // the canvas texture and produces subpixel seams aligned to character cells
        // (grid stripes over the TUI). Force an integral dpr so the backing store and
        // context scale match exactly; the CSS layer handles the fractional display
        // scaling as a mild blur instead of per-cell stripes.
        const integralDpr = Math.max(1, Math.round(window.devicePixelRatio || 1))
        ;(renderer as unknown as { devicePixelRatio: number }).devicePixelRatio = integralDpr
      }

      const titleSub = t.onTitleChange((title) => {
        local.onTitleChange?.(title)
        isEllamakaTui = isEllamakaTuiTitle(title)
        syncTuiMode()
      })
      cleanups.push(() => disposeIfDisposable(titleSub))
      const renderSub = t.onRender(syncTuiMode)
      cleanups.push(() => disposeIfDisposable(renderSub))

      // ghostty-web does not move its hidden IME <textarea> with the caret in
      // embedded layouts. Keep it glued to the cursor so the OS candidate window
      // follows the actual input position for both TUI and terminal panels.
      const textarea = t.textarea
      if (renderer && textarea) {
        const colors = terminalColors()
        const overlay = document.createElement("div")
        imeOverlay = overlay
        overlay.dataset.component = "terminal-ime-preedit"
        overlay.style.position = "absolute"
        overlay.style.display = "none"
        overlay.style.pointerEvents = "none"
        overlay.style.zIndex = "10"
        overlay.style.whiteSpace = "pre"
        overlay.style.overflow = "visible"
        overlay.style.fontFamily = terminalFontFamily(settings.appearance.terminalFont())
        overlay.style.fontSize = "14px"
        overlay.style.fontVariantLigatures = "none"
        overlay.style.textDecoration = "underline"
        overlay.style.color = colors.foreground
        overlay.style.backgroundColor = colors.background
        container.append(overlay)

        const computed = getComputedStyle(container)
        const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0
        const paddingTop = Number.parseFloat(computed.paddingTop) || 0
        const syncImeTextarea = () => {
          if (disposed || !document.contains(container)) return
          const metrics = renderer.getMetrics()
          // Fallback to 0 if cursorX is NaN or undefined in ghostty-web
          const cx = t.buffer.active.cursorX || 0
          const cy = t.buffer.active.cursorY || 0
          const frame = getTerminalImeFrame({
            cursorX: cx,
            cursorY: cy,
            cellWidth: metrics.width || 8,
            cellHeight: metrics.height || 18,
            paddingLeft,
            paddingTop,
          })
          
          textarea.style.left = frame.left
          textarea.style.top = frame.top
          textarea.style.width = frame.width
          textarea.style.height = frame.height
          textarea.style.opacity = "0.001"
          textarea.style.clipPath = "none"
          textarea.style.overflow = "visible"
          textarea.style.color = "transparent"
          textarea.style.backgroundColor = "transparent"
          textarea.style.caretColor = "transparent"
          textarea.style.outline = "none"
          textarea.style.border = "none"
          textarea.style.boxShadow = "none"
          
          overlay.style.left = frame.left
          overlay.style.top = frame.top
          overlay.style.minWidth = frame.width
          overlay.style.height = frame.height
          overlay.style.lineHeight = frame.height
        }
        
        let composition = updateTerminalImeComposition(undefined, { type: "blur" })
        const renderComposition = () => {
          const text = composition.active ? (composition.text || textarea.value) : ""
          overlay.textContent = text
          overlay.style.display = text ? "block" : "none"
        }
        const handleCompositionStart = (event: CompositionEvent) => {
          syncImeTextarea()
          composition = updateTerminalImeComposition(composition, { type: "start", data: event.data || textarea.value })
          renderComposition()
        }
        const handleCompositionUpdate = (event: CompositionEvent) => {
          composition = updateTerminalImeComposition(composition, { type: "update", data: event.data || textarea.value })
          renderComposition()
        }
        const handleCompositionEnd = (event: CompositionEvent) => {
          composition = updateTerminalImeComposition(composition, { type: "end", data: event.data })
          renderComposition()
        }
        const handleCompositionBlur = () => {
          composition = updateTerminalImeComposition(composition, { type: "blur" })
          renderComposition()
        }
        const handleInput = (event: Event) => {
          if (composition.active) {
            composition = updateTerminalImeComposition(composition, {
              type: "update",
              data: (event as InputEvent).data ?? textarea.value,
            })
            renderComposition()
          }
        }
        const handleFocus = () => {
          syncImeTextarea()
        }
        const handlePointerDownSync = () => {
          requestAnimationFrame(syncImeTextarea)
        }
        
        textarea.addEventListener("compositionstart", handleCompositionStart)
        textarea.addEventListener("compositionupdate", handleCompositionUpdate)
        textarea.addEventListener("compositionend", handleCompositionEnd)
        textarea.addEventListener("blur", handleCompositionBlur)
        textarea.addEventListener("input", handleInput)
        textarea.addEventListener("focus", handleFocus)
        container.addEventListener("pointerdown", handlePointerDownSync)
        
        cleanups.push(() => {
          textarea.removeEventListener("compositionstart", handleCompositionStart)
          textarea.removeEventListener("compositionupdate", handleCompositionUpdate)
          textarea.removeEventListener("compositionend", handleCompositionEnd)
          textarea.removeEventListener("blur", handleCompositionBlur)
          textarea.removeEventListener("input", handleInput)
          textarea.removeEventListener("focus", handleFocus)
          container.removeEventListener("pointerdown", handlePointerDownSync)
          overlay.remove()
          if (imeOverlay === overlay) imeOverlay = undefined
        })
        
        syncImeTextarea()
        const cursorSub = t.onCursorMove(syncImeTextarea)
        cleanups.push(() => disposeIfDisposable(cursorSub))
        const resizeSub = t.onResize(syncImeTextarea)
        cleanups.push(() => disposeIfDisposable(resizeSub))
        const renderImeSub = t.onRender(syncImeTextarea)
        cleanups.push(() => disposeIfDisposable(renderImeSub))
      }
      useTerminalUiBindings({
        container,
        term: t,
        cleanups,
        handlePointerDown,
        handleLinkClick,
        onSelectionCopied: () => showToast({ variant: "success", description: language.t("terminal.copied") }),
      })

      if (local.autoFocus !== false) focusTerminal()

      if (typeof document !== "undefined" && document.fonts) {
        void document.fonts.ready.then(() => scheduleFit())
      }

      const onResize = t.onResize((size) => {
        scheduleSize(size.cols, size.rows)
      })
      cleanups.push(() => disposeIfDisposable(onResize))
      const onData = t.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data)
      })
      cleanups.push(() => disposeIfDisposable(onData))
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => disposeIfDisposable(onKey))

      const startResize = () => {
        if (typeof ResizeObserver !== "undefined") {
          // Keep resize notifications under the app's rAF coalescing so FitAddon's
          // internal resize lock cannot discard a visibility or container change.
          const observer = new ResizeObserver(scheduleFit)
          observer.observe(container)
          cleanups.push(() => observer.disconnect())
        }
        handleResize = scheduleFit
        window.addEventListener("resize", handleResize)
        cleanups.push(() => window.removeEventListener("resize", handleResize))
      }

      const write = (data: string) =>
        new Promise<void>((resolve) => {
          if (!output) {
            resolve()
            return
          }
          output.push(data)
          output.flush(resolve)
        })

      if (restore && restoreSize) {
        await write(restore)
        fitTerminal()
        scheduleSize(t.cols, t.rows)
        if (scrollY !== undefined) t.scrollToLine(scrollY)
        startResize()
      } else {
        fitTerminal()
        scheduleSize(t.cols, t.rows)
        if (restore) {
          await write(restore)
          if (scrollY !== undefined) t.scrollToLine(scrollY)
        }
        startResize()
      }

      const once = { value: false }
      const decoder = new TextDecoder()

      const fail = (err: unknown) => {
        if (disposed) return
        if (once.value) return
        once.value = true
        local.onConnectError?.(err)
      }

      const gone = () =>
        client.pty
          .get({ ptyID: id }, { throwOnError: false })
          .then((result) => result.response.status === 404)
          .catch((err) => {
            debugTerminal("failed to inspect terminal session", err)
            return false
          })

      const connectToken = async () => {
        const result = await client.pty
          .connectToken(
            { ptyID: id, directory },
            {
              throwOnError: false,
              headers: { "x-opencode-ticket": "1" },
            },
          )
          .catch((err: unknown) => {
            if (err instanceof Error && err.message.includes("Request is not supported")) return
            throw err
          })
        if (!result) return
        if (result.response.status === 200 && result.data?.ticket) return result.data.ticket
        if (result.response.status === 404 || result.response.status === 405) {
          fail(new Error("PTY session not found"))
          return
        }
        if (result.response.status === 403)
          throw new Error("PTY connect ticket rejected by origin or CSRF checks. Check the server CORS config.")
        throw new Error(`PTY connect ticket failed with ${result.response.status}`)
      }

      const retry = (err: unknown) => {
        if (disposed) return
        if (reconn !== undefined) return

        const ms = Math.min(250 * 2 ** Math.min(tries, 4), 4_000)
        reconn = setTimeout(async () => {
          reconn = undefined
          if (disposed) return
          if (await gone()) {
            if (disposed) return
            fail(err)
            return
          }
          if (disposed) return
          tries += 1
          open()
        }, ms)
      }

      const open = async () => {
        if (disposed) return
        drop?.()

        const ticket = await connectToken().catch((err) => {
          fail(err)
          return undefined
        })
        if (once.value) return
        if (disposed) return

        const socket = new WebSocket(
          terminalWebSocketURL({
            url,
            id,
            directory,
            cursor: seek,
            ticket,
            sameOrigin,
            username,
            password,
            authToken: server.current?.type === "http" ? server.current.authToken : false,
          }),
        )
        socket.binaryType = "arraybuffer"
        ws = socket

        const handleOpen = () => {
          if (disposed) return
          tries = 0
          local.onConnect?.()
          scheduleSize(t.cols, t.rows)
        }

        const handleMessage = (event: MessageEvent) => {
          if (disposed) return
          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (bytes[0] !== 0) return
            const json = decoder.decode(bytes.subarray(1))
            try {
              const meta = JSON.parse(json) as { cursor?: unknown }
              const next = meta?.cursor
              if (typeof next === "number" && Number.isSafeInteger(next) && next >= 0) {
                cursor = next
                seek = next
              }
            } catch (err) {
              debugTerminal("invalid websocket control frame", err)
            }
            return
          }

          const data = typeof event.data === "string" ? event.data : ""
          if (!data) return
          output?.push(data)
          cursor += data.length
          seek = cursor
        }

        const handleError = (error: Event) => {
          if (disposed) return
          debugTerminal("websocket error", error)
        }

        const stop = () => {
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close(1000)
        }

        const handleClose = (event: CloseEvent) => {
          if (ws === socket) ws = undefined
          if (drop === stop) drop = undefined
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
          if (disposed) return
          local.onClose?.()
          if (event.code === 1000) return
          retry(new Error(language.t("terminal.connectionLost.abnormalClose", { code: event.code })))
        }

        drop = stop
        socket.addEventListener("open", handleOpen)
        socket.addEventListener("message", handleMessage)
        socket.addEventListener("error", handleError)
        socket.addEventListener("close", handleClose)
      }

      open()
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(err)
    })
  })

  onCleanup(() => {
    disposed = true
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (sizeTimer !== undefined) clearTimeout(sizeTimer)
    if (reconn !== undefined) clearTimeout(reconn)
    drop?.()
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close(1000)

    const finalize = () => {
      persistTerminal({ term, addon: serializeAddon, cursor, id, onCleanup: props.onCleanup })
      cleanup()
    }

    if (!output) {
      finalize()
      return
    }

    output.flush(finalize)
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...local.classList,
        "select-text": true,
        "size-full font-mono relative overflow-hidden": true,
        "px-3 py-2": !local.noPadding,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
