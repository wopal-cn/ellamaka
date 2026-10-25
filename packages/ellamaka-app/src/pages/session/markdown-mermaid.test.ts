import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import * as realMermaid from "mermaid"

const realMermaidExports = { ...realMermaid }

const calls: Array<{ id: string; source: string }> = []
let svg =
  '<svg viewBox="0 0 120 60"><style>.node { fill: currentColor; }</style><g class="node"><text>Start</text></g></svg>'

const initialize = mock(() => {})

mock.module("mermaid", () => ({
  default: {
    initialize,
    render: async (id: string, source: string) => {
      calls.push({ id, source })
      return { svg, diagramType: "flowchart" }
    },
  },
}))

const { deferredMermaid } = await import("./markdown-mermaid")

afterAll(() => {
  mock.module("mermaid", () => realMermaidExports)
})

function fixture(source = "flowchart LR\n  A[Start] --> B[Finish]") {
  const container = document.createElement("div")
  document.body.appendChild(container)
  container.innerHTML = `<div data-component="markdown-code"><pre><code data-lang="mermaid">${source}</code></pre><button data-slot="markdown-copy-button"></button></div>`
  return container
}

describe("Workbench Markdown Mermaid pipeline", () => {
  beforeEach(() => {
    calls.length = 0
    svg =
      '<svg viewBox="0 0 120 60"><style>.node { fill: currentColor; }</style><g class="node"><text>Start</text></g></svg>'
    initialize.mockClear()
  })

  test("renders only a completed Mermaid fence and keeps its source for copying", async () => {
    const container = fixture()

    await deferredMermaid(container, { mode: "dark", streaming: false })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.source).toContain("flowchart LR")
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
      }),
    )
    expect(container.querySelector('[data-component="markdown-mermaid"] svg')).not.toBeNull()
    expect(container.querySelector('[data-component="markdown-mermaid"] style')).not.toBeNull()
    expect(container.querySelector("pre")?.hidden).toBe(true)
    expect(container.querySelector("code")?.textContent).toContain("A[Start] --> B[Finish]")
    expect(container.querySelector('[data-slot="markdown-copy-button"]')).not.toBeNull()
    container.remove()
  })

  test("leaves an in-progress Mermaid fence as readable code", async () => {
    const container = fixture()

    await deferredMermaid(container, { mode: "dark", streaming: true })

    expect(calls).toHaveLength(0)
    expect(container.querySelector('[data-component="markdown-mermaid"]')).toBeNull()
    expect(container.querySelector("pre")?.hidden).toBe(false)
    container.remove()
  })

  test("rejects Mermaid configuration and interaction directives instead of letting a message override the host", async () => {
    const container = fixture("flowchart LR\n%%{init: { 'theme': 'base' }}%%\nA --> B")

    await deferredMermaid(container, { mode: "light", streaming: false })

    expect(calls).toHaveLength(0)
    expect(container.querySelector('[data-component="markdown-mermaid"]')).toBeNull()
    expect(container.querySelector("pre")?.hidden).toBe(false)
    container.remove()
  })

  test("sanitizes unsafe SVG output while preserving Mermaid's visual styles", async () => {
    svg =
      '<svg viewBox="0 0 120 60" onload="alert(1)"><style>.node { fill: currentColor; }</style><script>alert(1)</script><a href="https://example.com"><text>Unsafe link</text></a><foreignObject><button>unsafe</button></foreignObject><g onclick="alert(1)"><text>Safe node</text></g></svg>'
    const container = fixture()

    await deferredMermaid(container, { mode: "light", streaming: false })

    const diagram = container.querySelector('[data-component="markdown-mermaid"]')
    expect(diagram?.querySelector("style")).not.toBeNull()
    expect(diagram?.querySelector("script")).toBeNull()
    expect(diagram?.querySelector("foreignObject")).toBeNull()
    expect(diagram?.querySelector("a")).toBeNull()
    expect(diagram?.querySelector("[onload], [onclick]")).toBeNull()
    container.remove()
  })
})
