import { describe, expect, mock, test } from "bun:test"
import DOMPurify from "dompurify"
import { streamBlocks } from "./workbench-markdown-stream"
import {
  deferredHighlight,
  fnv1a,
  preserveStreamingHighlight,
  renderMathExpressions,
  syncMarked,
} from "./markdown-highlight"

const parsed = mock((src: string) => `<p>${src}</p>`)

mock.module("@wopal/ui/context/marked", () => ({
  useMarked: () => ({ parse: parsed }),
}))

mock.module("@wopal/ui/context/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const { suppressNativeMarkdownLinkStatus } = await import("./workbench-markdown-renderer")

/**
 * WorkbenchMarkdown component behavior is verified end-to-end through the
 * chat timeline tests, which mock this renderer at the module boundary. These
 * tests pin the streaming pipeline contract the component relies on: stable
 * blocks are never re-parsed, and only the live tail changes across a token
 * burst. They run against the pure stream module so they are immune to the
 * cross-file module mocks used by the block/timeline suites.
 */
describe("WorkbenchMarkdown streaming pipeline", () => {
  test("a completed block keeps a byte-stable src across tail growth", () => {
    const start = "# Title\n\nFirst paragraph.\n\nTail one"
    const grown = "# Title\n\nFirst paragraph.\n\nTail one grows"

    const before = streamBlocks(start, true)
    const after = streamBlocks(grown, true)

    expect(before.at(-1)?.mode).toBe("live")
    expect(after.at(-1)?.mode).toBe("live")
    expect(after.slice(0, -1).map((block) => block.src)).toEqual(before.slice(0, -1).map((block) => block.src))
    expect(after.length).toBe(before.length)
  })

  test("a streaming table finalizes row by row instead of re-parsing the whole document", () => {
    const partial = ["intro paragraph", "", "| A | B |", "|---|---|", "| 1 | 2 |", "", "tail *open"].join("\n")
    const more = `${partial} and more*`

    const before = streamBlocks(partial, true)
    const after = streamBlocks(more, true)

    const stableBefore = before.slice(0, -1)
    const stableAfter = after.slice(0, -1)
    expect(stableBefore.length).toBeGreaterThan(0)
    expect(stableAfter.map((block) => block.src)).toEqual(stableBefore.map((block) => block.src))
  })

  test("a single completed block remains a single full block", () => {
    expect(streamBlocks("# Done", false)).toEqual([{ raw: "# Done", src: "# Done", mode: "full" }])
  })

  test("completed text keeps the streaming block partition so settlement can retain its DOM", () => {
    const text = ["# Done", "", "First paragraph.", "", "```ts", "const value = 1", "```"].join("\n")
    const blocks = streamBlocks(text, false)

    expect(blocks.map((block) => block.mode)).toEqual(["full", "full", "full"])
    expect(blocks.map((block) => block.src).join("")).toBe(text)
    expect(blocks.map((block) => String(syncMarked.parse(block.src))).join("")).toBe(String(syncMarked.parse(text)))
  })

  test("a closed fenced code block at the tail renders as a full block", () => {
    const text = "Intro paragraph.\n\n```js\nconst value = 1\n```"
    const blocks = streamBlocks(text, true)
    expect(blocks.at(-1)?.mode).toBe("full")
    expect(blocks.at(-1)?.raw).toContain("```js")
  })
})

describe("WorkbenchMarkdown links", () => {
  test("keeps Markdown links interactive without leaving an href for the browser status bar", () => {
    const root = document.createElement("div")
    root.innerHTML =
      '<a href="/wopal-space/REGULATIONS.md">本体维护</a><a href="https://example.com/docs" target="_blank">文档</a>'

    suppressNativeMarkdownLinkStatus(root)

    const links = root.querySelectorAll("a")
    expect(links).toHaveLength(2)
    expect(links[0]?.getAttribute("href")).toBeNull()
    expect(links[0]?.getAttribute("data-workbench-markdown-href")).toBe("/wopal-space/REGULATIONS.md")
    expect(links[0]?.getAttribute("role")).toBe("link")
    expect(links[0]?.getAttribute("tabindex")).toBe("0")
    expect(links[1]?.getAttribute("href")).toBeNull()
    expect(links[1]?.getAttribute("data-workbench-markdown-href")).toBe("https://example.com/docs")
    expect(links[1]?.getAttribute("target")).toBe("_blank")
  })
})

describe("WorkbenchMarkdown table layout", () => {
  test("uses the full message reading lane for markdown tables", async () => {
    const css = await Bun.file(new URL("../../index.css", import.meta.url)).text()

    expect(css).toContain('[data-component="chat-narrative"] {\n  width: 100%;')
    expect(css).toMatch(
      /\[data-slot="workbench-markdown-content"\] table \{[\s\S]*?display: table;[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;/,
    )
  })

  test("uses an airy row-divider treatment instead of boxed cells", async () => {
    const css = await Bun.file(new URL("../../index.css", import.meta.url)).text()

    expect(css).toMatch(
      /\[data-slot="workbench-markdown-content"\] th,[\s\S]*?\[data-slot="workbench-markdown-content"\] td \{[\s\S]*?border: 0;[\s\S]*?border-block-end: 1px solid var\(--border-base\);/,
    )
    expect(css).toContain(
      '[data-slot="workbench-markdown-content"] th {\n  background: transparent;',
    )
    expect(css).toContain(
      '[data-slot="workbench-markdown-content"] tbody tr:last-child td {\n  border-block-end: 0;',
    )
    expect(css).not.toContain('[data-slot="workbench-markdown-content"] tbody tr:hover td')
  })

  test("gives completed Mermaid diagrams their own stable, scroll-safe surface", async () => {
    const css = await Bun.file(new URL("../../index.css", import.meta.url)).text()

    expect(css).toMatch(
      /\[data-slot="workbench-markdown-content"\] \[data-component="markdown-mermaid"\] \{[\s\S]*?overflow: auto hidden;[\s\S]*?scrollbar-gutter: stable;[\s\S]*?border: 1px solid var\(--border-weaker-base\);/,
    )
  })
})

describe("Chat tool scrollbar geometry", () => {
  test("reserves the tool scrollbar track while the pointer is away", async () => {
    const css = await Bun.file(new URL("../../index.css", import.meta.url)).text()

    expect(css).toMatch(
      /\[data-slot="chat-shell-command"\]::-webkit-scrollbar,[\s\S]*?\)::-webkit-scrollbar \{\n  display: block;\n  width: 8px;\n  height: 8px;/,
    )
    expect(css).toMatch(
      /\[data-slot="chat-shell-command"\]::-webkit-scrollbar-thumb,[\s\S]*?\)::-webkit-scrollbar-thumb \{\n  background: transparent;/,
    )
    expect(css).toContain('scrollbar-color: transparent transparent;')
    expect(css).not.toContain('[data-slot="chat-shell-command"]:hover::-webkit-scrollbar,')
  })

  test("marks every custom tool output as nested scrollable content", async () => {
    const source = await Bun.file(new URL("./chat-tool-blocks.tsx", import.meta.url)).text()

    for (const slot of ["chat-shell-command", "chat-shell-output", "chat-shell-error", "chat-context-output", "chat-generic-output"]) {
      expect(source).toContain(`<pre data-slot="${slot}" data-scrollable="">`)
    }
    expect(source).toContain('<div data-component="chat-file-change-wrapper" data-scrollable="">')
  })
})

describe("Chat tool header width", () => {
  test("lets long tool details yield to the trailing status and keeps their tail visible", async () => {
    const css = await Bun.file(new URL("../../index.css", import.meta.url)).text()

    expect(css).toMatch(
      /\[data-slot="chat-tool-header"\]\s*\{[^}]*\bwidth: 100%;[^}]*\bmin-width: 0;[^}]*\}/,
    )
    expect(css).toMatch(
      /\[data-slot="chat-tool-trigger"\]\s*\{[^}]*\bflex: 1 1 auto;[^}]*\bmin-width: 0;[^}]*\boverflow: hidden;[^}]*\}/,
    )
    expect(css).toMatch(
      /\[data-slot="chat-tool-trailing"\]\s*\{[^}]*\bflex: 0 0 auto;[^}]*\}/,
    )
    expect(css).toMatch(
      /\[data-slot="chat-tool-subtitle"\]\s*\{[^}]*\bdirection: rtl;[^}]*\btext-align: left;[^}]*\}/,
    )
    expect(css).toMatch(
      /\[data-slot="chat-context-info-bar"\]\s*\{[^}]*\bbox-sizing: border-box;[^}]*\bwidth: 100%;[^}]*\}/,
    )
  })
})

describe("WorkbenchMarkdown highlight pipeline", () => {
  test("fnv1a is deterministic and content-sensitive", () => {
    expect(fnv1a("const a = 1")).toBe(fnv1a("const a = 1"))
    expect(fnv1a("const a = 1")).not.toBe(fnv1a("const a = 2"))
  })

  test("the sync parser emits plain pre/code blocks carrying data-lang", () => {
    const html = String(syncMarked.parse("```js\nconst value = 1\n```"))
    expect(html).toContain("<pre><code")
    expect(html).toContain('data-lang="js"')
    expect(html).toContain('class="language-js"')
  })

  test("deferredHighlight upgrades a block, marks its source hash, and preserves the wrapper", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    container.innerHTML =
      '<div data-component="markdown-code"><pre><code class="language-js" data-lang="js">const value = 1</code></pre><button data-slot="markdown-copy-button"></button></div>'

    await deferredHighlight(container)

    const pre = container.querySelector("pre")
    expect(pre?.classList.contains("shiki")).toBe(true)
    expect(pre?.getAttribute("data-source-hash")).toBe(fnv1a("const value = 1"))
    expect(pre?.querySelector("code")?.getAttribute("data-highlighted")).toBe("true")
    // The markdown-code wrapper and its copy button survive the upgrade.
    expect(container.querySelector('[data-component="markdown-code"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="markdown-copy-button"]')).not.toBeNull()
    container.remove()
  })

  test("an aborted signal leaves blocks untouched", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    container.innerHTML = '<pre><code class="language-js" data-lang="js">const value = 1</code></pre>'

    await deferredHighlight(container, undefined, { aborted: true })

    expect(container.querySelector("pre")?.classList.contains("shiki")).toBe(false)
    container.remove()
  })

  test("leaves Mermaid fences for the completion-only SVG renderer", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    container.innerHTML = '<pre><code class="language-mermaid" data-lang="mermaid">flowchart LR\nA --> B</code></pre>'

    await deferredHighlight(container)

    expect(container.querySelector("pre")?.classList.contains("shiki")).toBe(false)
    expect(container.querySelector("code")?.textContent).toContain("flowchart LR")
    container.remove()
  })

  test("stream settlement keeps an equal highlighted code block instead of returning to plain code", () => {
    const container = document.createElement("div")
    container.innerHTML =
      '<pre class="shiki" data-source-hash="same"><code data-highlighted="true">const value = 1</code></pre>'
    const incoming = document.createElement("pre")
    incoming.innerHTML = '<code data-lang="js">const value = 1</code>'

    expect(preserveStreamingHighlight(container.querySelector("pre")!, incoming, false)).toBe(true)
  })
})

describe("WorkbenchMarkdown math pipeline", () => {
  test("renders complete inline and display formulas while leaving code untouched", () => {
    const html = renderMathExpressions(
      '<p>Mass energy: $E = mc^2$.</p><p>$$\\frac{a}{b}$$</p><pre><code data-lang="text">$not_math$</code></pre>',
    )

    expect(html).toContain('class="katex"')
    expect(html).toContain('class="katex-display"')
    expect(html).toContain("$not_math$")
    expect(DOMPurify.sanitize(html, { USE_PROFILES: { html: true, mathMl: true } })).toContain('class="katex"')
  })

  test("keeps an unclosed streaming formula as ordinary text", () => {
    const html = renderMathExpressions("<p>Still composing $E = mc</p>")

    expect(html).toContain("$E = mc")
    expect(html).not.toContain('class="katex"')
  })
})
