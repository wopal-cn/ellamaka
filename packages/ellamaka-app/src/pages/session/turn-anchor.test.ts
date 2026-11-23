import { describe, expect, test } from "bun:test"

/**
 * The jump anchor for PgUp/PgDn and prompt-directory jumps must be resolved
 * inside the panel's own scroller. A document-wide query can match the same
 * turn rendered by another keep-alive panel (hidden Space tab, split panel),
 * scrolling the wrong scroller and leaving the visible one untouched.
 */
describe("turn anchor scoping", () => {
  test("resolves the anchor inside the given scoper root only", async () => {
    const { resolveTurnAnchor } = await import("./turn-anchor")

    const root = document.createElement("div")
    const inner = document.createElement("div")
    inner.setAttribute("data-turn-id", "turn-1")
    root.appendChild(inner)
    document.body.appendChild(root)

    const outside = document.createElement("div")
    outside.setAttribute("data-turn-id", "turn-0")
    document.body.insertBefore(outside, root)

    const anchor = resolveTurnAnchor(root, "turn-1")
    expect(anchor).toBe(inner)
    expect(resolveTurnAnchor(root, "turn-0")).toBeUndefined()
    expect(resolveTurnAnchor(undefined, "turn-1")).toBeUndefined()

    root.remove()
    outside.remove()
  })
})
