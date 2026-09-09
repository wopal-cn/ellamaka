import { useI18n } from "@wopal/ui/context/i18n"
import { useTheme } from "@wopal/ui/theme/context"
import DOMPurify from "dompurify"
import morphdom from "morphdom"
import { checksum } from "@wopal/ellamaka-core/util/encode"
import { ComponentProps, createEffect, createResource, createSignal, onCleanup, splitProps } from "solid-js"
import { isServer } from "solid-js/web"
import { streamBlocks } from "./workbench-markdown-stream"
import { createIncrementalMarkdown } from "./markdown-incremental-dom"
import { tryFastRender } from "./markdown-fast-path"
import { deferredMermaid } from "./markdown-mermaid"
import {
  deferredHighlight,
  fnv1a,
  preserveStreamingHighlight,
  renderMathExpressions,
  syncMarked,
} from "./markdown-highlight"

type Entry = {
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, Entry>()

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

function sanitize(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

type CopyLabels = {
  copy: string
  copied: string
}

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/
const markdownLinkHrefAttribute = "data-workbench-markdown-href"

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-size", "small")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
  if (copied) {
    button.setAttribute("data-copied", "true")
    button.setAttribute("aria-label", labels.copied)
    button.setAttribute("data-tooltip", labels.copied)
    return
  }
  button.removeAttribute("data-copied")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    button.remove()
  }
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

/**
 * A native anchor's href makes Chromium show a URL in its status bar while
 * hovered. Chat keeps links keyboard-accessible but delegates navigation so
 * the transcript stays visually self-contained.
 */
export function suppressNativeMarkdownLinkStatus(root: ParentNode) {
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
  for (const link of links) {
    const href = link.getAttribute("href")
    if (!href) continue
    link.setAttribute(markdownLinkHrefAttribute, href)
    link.removeAttribute("href")
    link.setAttribute("role", "link")
    if (!link.hasAttribute("tabindex")) link.tabIndex = 0
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  markCodeLinks(root)
  suppressNativeMarkdownLinkStatus(root)
}

function markdownLinkFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return
  const link = target.closest<HTMLAnchorElement>(`a[${markdownLinkHrefAttribute}]`)
  return link ?? undefined
}

function navigateMarkdownLink(link: HTMLAnchorElement, newWindow: boolean) {
  const rawHref = link.getAttribute(markdownLinkHrefAttribute)
  if (!rawHref) return
  let href: string
  try {
    const url = new URL(rawHref, window.location.href)
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return
    href = url.href
  } catch {
    return
  }
  if (newWindow) {
    window.open(href, "_blank", "noopener,noreferrer")
    return
  }
  window.location.assign(href)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
  }
}

function touch(key: string, value: Entry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

/**
 * WorkbenchMarkdown is the Workbench Chat narrative renderer. It ports the
 * kilocode two-pass pipeline into the Workbench-owned layer: synchronous
 * parse with stable block splitting and incremental DOM updates, a fast path
 * for completed content, and a structure-preserving progressive highlight
 * pass. The shared `@wopal/ui` Markdown component is left untouched,
 * so the official Session page keeps its current behavior.
 */
export function WorkbenchMarkdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "class", "classList"])
  const i18n = useI18n()
  const theme = useTheme()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const handleLinkClick = (event: MouseEvent) => {
    const link = markdownLinkFromTarget(event.target)
    if (!link) return
    event.preventDefault()
    navigateMarkdownLink(link, link.getAttribute("target") === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey)
  }
  const handleLinkAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) return
    const link = markdownLinkFromTarget(event.target)
    if (!link) return
    event.preventDefault()
    navigateMarkdownLink(link, true)
  }
  const handleLinkKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return
    const link = markdownLinkFromTarget(event.target)
    if (!link) return
    event.preventDefault()
    navigateMarkdownLink(link, link.getAttribute("target") === "_blank")
  }
  const [html] = createResource(
    () => ({
      text: local.text,
      key: local.cacheKey,
      streaming: local.streaming ?? false,
    }),
    (src) => {
      if (isServer) return { content: fallback(src.text), blocks: [] }
      if (!src.text) return { content: "", blocks: [] }

      const base = src.key ?? checksum(src.text)
      try {
        // Live and full blocks share the same parse pipeline. The growing
        // tail is healed markdown (remend), so a partial table renders as a
        // real table from the first row and grows row by row; the block hash
        // guards unchanged stable blocks against re-parsing.
        const blocks = streamBlocks(src.text, src.streaming).map((block, index) => {
          // A tail can retain identical source bytes while moving from the
          // healed live parse to the canonical completed parse. Include the
          // mode so settlement revisits that one block when its semantics may
          // differ, while every already-full stable block keeps its DOM.
          const hash = `${checksum(block.raw) ?? ""}:${block.mode}`
          const key = `${base}:${index}`
          const cacheKey = `${key}:${block.mode}`
          const cached = cache.get(cacheKey)
          if (cached && cached.hash === hash) {
            touch(cacheKey, cached)
            return { key, hash, html: cached.html, mode: block.mode }
          }

          const next = renderMathExpressions(String(syncMarked.parse(block.src)))
          const safe = sanitize(next)
          touch(cacheKey, { hash, html: safe })
          return { key, hash, html: safe, mode: block.mode }
        })
        return { content: blocks.map((block) => block.html).join(""), blocks }
      } catch {
        return { content: fallback(src.text), blocks: [] }
      }
    },
    { initialValue: { content: fallback(local.text), blocks: [] } },
  )

  let copyCleanup: (() => void) | undefined
  // rAF-coalesced tail render. Streaming deltas arrive far faster than the
  // frame rate; queue the latest content for a single animation frame so K
  // rapid updates collapse into one parse instead of K.
  let pendingFrame: number | undefined
  let pendingContent: string | undefined
  let pendingLabels: { copy: string; copied: string } | undefined
  let renderedContent = ""

  // Generation counter + abort signal: a newer render cancels any in-flight
  // highlight pass so concurrent passes never race on the same DOM nodes
  // (ported from kilocode, issue #6221).
  const highlightState = { gen: 0, signal: { aborted: false } }
  const mermaidState = { signal: { aborted: false } }

  function kickMermaid(container: HTMLDivElement, mode: "light" | "dark", streaming: boolean) {
    mermaidState.signal.aborted = true
    const signal = { aborted: false }
    mermaidState.signal = signal
    void deferredMermaid(container, { mode, streaming }, signal).catch(() => {})
  }

  function kickHighlight(container: HTMLDivElement, labels: CopyLabels) {
    highlightState.signal.aborted = true
    const gen = ++highlightState.gen
    const signal = { aborted: false }
    highlightState.signal = signal
    void deferredHighlight(
      container,
      () => {
        if (gen !== highlightState.gen) return
        if (copyCleanup) copyCleanup()
        copyCleanup = setupCodeCopy(container, () => labels)
      },
      signal,
    )
  }

  const incremental = createIncrementalMarkdown<void>(decorate, {
    cancel: () => {
      if (pendingFrame === undefined) return
      cancelAnimationFrame(pendingFrame)
      pendingFrame = undefined
      pendingContent = undefined
      pendingLabels = undefined
    },
    ready: (container, labels) => {
      copyCleanup ??= setupCodeCopy(container, () => labels)
    },
    preserve: (from, to) => preserveStreamingHighlight(from, to, local.streaming ?? false),
  })

  createEffect(() => {
    const container = root()
    const rendered = html.latest ?? html() ?? { content: "", blocks: [] }
    const content = local.text ? rendered.content : ""
    const themeMode = theme.mode()
    const streaming = local.streaming ?? false
    if (!container) return
    if (isServer) return

    if (!content) {
      if (pendingFrame !== undefined) {
        cancelAnimationFrame(pendingFrame)
        pendingFrame = undefined
        pendingContent = undefined
        pendingLabels = undefined
      }
      incremental.reset()
      container.innerHTML = ""
      renderedContent = ""
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }

    // Theme and locale updates should refresh only the deferred decorators.
    // Re-applying the raw markdown here would temporarily replace a completed
    // diagram with its source code before Mermaid can redraw it.
    if (renderedContent === content && container.childNodes.length > 0) {
      kickMermaid(container, themeMode, streaming)
      kickHighlight(container, labels)
      return
    }

    const fast = tryFastRender(container, content, local.streaming, decorate, setupCodeCopy, () => labels, copyCleanup)
    if (fast.handled) {
      if (pendingFrame !== undefined) {
        cancelAnimationFrame(pendingFrame)
        pendingFrame = undefined
        pendingContent = undefined
        pendingLabels = undefined
      }
      incremental.reset()
      copyCleanup = fast.copyCleanup
      renderedContent = content
      kickMermaid(container, themeMode, streaming)
      kickHighlight(container, labels)
      return
    }

    if (incremental.render(streaming, container, rendered.blocks, labels, undefined)) {
      renderedContent = content
      kickMermaid(container, themeMode, streaming)
      kickHighlight(container, labels)
      return
    }
    incremental.reset()

    pendingContent = content
    pendingLabels = labels
    if (pendingFrame !== undefined) return
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = undefined
      const next = pendingContent
      const nextLabels = pendingLabels
      pendingContent = undefined
      pendingLabels = undefined
      if (next === undefined || nextLabels === undefined) return
      if (!container.isConnected) return

      const temp = document.createElement("div")
      temp.innerHTML = next
      decorate(temp, nextLabels)

      // In-place patch instead of replaceChildren: clearing the container
      // collapses scrollHeight mid-frame and confuses the panel auto-scroll
      // anchor tracking.
      morphdom(container, temp, {
        childrenOnly: true,
        onBeforeElUpdated: (fromEl, toEl) => {
          if (
            fromEl instanceof HTMLButtonElement &&
            toEl instanceof HTMLButtonElement &&
            fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
            toEl.getAttribute("data-slot") === "markdown-copy-button" &&
            fromEl.getAttribute("data-copied") === "true"
          ) {
            setCopyState(toEl, nextLabels, true)
          }
          if (fromEl.isEqualNode(toEl)) return false
          // Preserve Shiki-highlighted blocks: without this guard morphdom
          // would revert an already-highlighted <pre class="shiki"> back to
          // plain code on every streaming re-render, producing a
          // highlight/unhighlight flicker. The data-source-hash comparison
          // lets genuinely changed code fall through and be re-highlighted
          // by the next deferredHighlight pass (ported from kilocode).
          if (
            fromEl instanceof HTMLElement &&
            fromEl.tagName === "PRE" &&
            fromEl.classList.contains("shiki") &&
            toEl instanceof HTMLElement &&
            toEl.tagName === "PRE" &&
            !toEl.classList.contains("shiki")
          ) {
            const fromHash = fromEl.getAttribute("data-source-hash")
            const toCode = toEl.querySelector("code")?.textContent ?? ""
            if (fromHash === fnv1a(toCode)) return false
            // Source grew during streaming: keep the highlighted block and
            // re-highlight it in place once the token burst settles, instead
            // of letting morphdom swap in the plain block (which would flash).
            if (preserveStreamingHighlight(fromEl, toEl, local.streaming ?? false)) return false
          }
          return true
        },
      })

      renderedContent = next
      copyCleanup ??= setupCodeCopy(container, () => nextLabels)
      kickMermaid(container, themeMode, streaming)
      kickHighlight(container, nextLabels)
    })
  })

  onCleanup(() => {
    if (pendingFrame !== undefined) {
      cancelAnimationFrame(pendingFrame)
      pendingFrame = undefined
      pendingContent = undefined
      pendingLabels = undefined
    }
    highlightState.signal.aborted = true
    highlightState.gen++
    mermaidState.signal.aborted = true
    if (copyCleanup) copyCleanup()
  })

  return (
    <div
      data-component="markdown"
      data-slot="workbench-markdown-content"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      on:click={handleLinkClick}
      on:auxclick={handleLinkAuxClick}
      on:keydown={handleLinkKeyDown}
      {...others}
    />
  )
}
