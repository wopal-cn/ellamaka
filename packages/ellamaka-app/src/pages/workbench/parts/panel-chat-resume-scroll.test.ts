import { describe, expect, test } from "bun:test"
import { chatTranscriptNavigation, shouldResumeChatOnEnd } from "./panel-chat-resume-scroll"

function dispatchKeydown(target: HTMLElement, init: KeyboardEventInit = {}) {
  let result: ReturnType<typeof chatTranscriptNavigation>
  target.addEventListener(
    "keydown",
    (event) => {
      result = chatTranscriptNavigation(event)
    },
    { once: true },
  )
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true, ...init }))
  return result
}

describe("chatTranscriptNavigation", () => {
  test("maps unmodified transcript navigation keys", () => {
    const target = document.createElement("div")
    expect(dispatchKeydown(target)).toBe("latest")
    expect(dispatchKeydown(target, { key: "Home" })).toBe("first")
    expect(dispatchKeydown(target, { key: "PageUp" })).toBe("previous")
    expect(dispatchKeydown(target, { key: "PageDown" })).toBe("next")
  })

  test("preserves navigation keys for editable and interactive controls", () => {
    expect(dispatchKeydown(document.createElement("textarea"))).toBeUndefined()
    expect(dispatchKeydown(document.createElement("button"))).toBeUndefined()
  })

  test("uses navigation from an empty chat prompt but preserves a drafted prompt", () => {
    const prompt = document.createElement("div")
    prompt.dataset.component = "prompt-input"
    prompt.contentEditable = "true"
    expect(dispatchKeydown(prompt)).toBe("latest")

    prompt.textContent = "draft"
    expect(dispatchKeydown(prompt)).toBeUndefined()
  })

  test("keeps navigation available after a prompt-directory jump", () => {
    const navigator = document.createElement("div")
    navigator.dataset.component = "chat-prompt-navigator"
    const item = document.createElement("button")
    item.dataset.slot = "chat-prompt-item"
    navigator.appendChild(item)
    expect(dispatchKeydown(item, { key: "End" })).toBe("latest")
    expect(dispatchKeydown(item, { key: "PageUp" })).toBe("previous")
    expect(dispatchKeydown(item, { key: "PageDown" })).toBe("next")
    navigator.remove()
  })

  test("preserves selection and platform shortcut variants", () => {
    expect(dispatchKeydown(document.createElement("div"), { shiftKey: true })).toBeUndefined()
    expect(dispatchKeydown(document.createElement("div"), { ctrlKey: true })).toBeUndefined()
    expect(dispatchKeydown(document.createElement("div"), { metaKey: true })).toBeUndefined()
    expect(dispatchKeydown(document.createElement("div"), { altKey: true })).toBeUndefined()
  })

  test("keeps the End helper aligned with the generic navigation guard", () => {
    const target = document.createElement("div")
    let result = false
    target.addEventListener(
      "keydown",
      (event) => {
        result = shouldResumeChatOnEnd(event)
      },
      { once: true },
    )
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }))
    expect(result).toBe(true)
  })
})
