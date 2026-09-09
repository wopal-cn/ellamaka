import { afterEach, expect, test } from "bun:test"
import { type TestRenderer, createTestRenderer } from "@opentui/core/testing"
import { buildSplash, splashMeta } from "@/cli/cmd/run/splash"
import { RUN_THEME_FALLBACK } from "@/cli/cmd/run/theme"
import { BINARY_NAME } from "@wopal/ellamaka-brand/branding"

const active: TestRenderer[] = []

afterEach(() => {
  for (const renderer of active.splice(0)) {
    renderer.destroy()
  }
})

function collectText(root: unknown): string[] {
  const texts: string[] = []
  const visit = (node: Record<string, unknown>) => {
    const tb = node.textBuffer as { getPlainText?: () => string } | undefined
    if (tb && typeof tb.getPlainText === "function") {
      const text = tb.getPlainText()
      if (text) texts.push(text)
    }
    const children = (node._childrenInLayoutOrder ?? node._childrenInZIndexOrder ?? node.children) as
      | Record<string, unknown>[]
      | undefined
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child && typeof child === "object") {
          visit(child as Record<string, unknown>)
        }
      }
    }
  }
  visit(root as Record<string, unknown>)
  return texts
}

async function setup(width = 80): Promise<TestRenderer> {
  const out = await createTestRenderer({
    width,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  active.push(out.renderer)
  return out.renderer
}

test("exit splash resume command uses BINARY_NAME, not opencode", async () => {
  const renderer = await setup(80)

  const snapshot = buildSplash(
    {
      ...splashMeta({ title: "test session", session_id: "ses_abc123" }),
      theme: RUN_THEME_FALLBACK.splash,
    },
    "exit",
    {
      width: 80,
      widthMethod: "wcwidth",
      tailColumn: 0,
      renderContext: renderer,
    },
  )

  try {
    const text = collectText(snapshot.root).join("")
    expect(text).toContain(`${BINARY_NAME} run -i -s ses_abc123`)
    expect(text).not.toContain("opencode run -i -s")
  } finally {
    snapshot.teardown?.()
    snapshot.root.destroy()
  }
})