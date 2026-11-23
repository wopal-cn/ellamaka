import { afterEach, describe, expect, test } from "bun:test"
import {
  focusPanelPromptEditor,
  shouldPreservePanelPointerFocus,
  shouldSkipPanelPromptFocusForActivation,
  startPanelPromptFocus,
} from "./panel-prompt-focus"

type ScheduledTimer = {
  callback: () => void
  delay: number
}

function createPanel() {
  const root = document.createElement("div")
  root.dataset.panelId = "panel-1"

  const dock = document.createElement("div")
  dock.dataset.component = "session-prompt-dock"

  const editor = document.createElement("div")
  editor.dataset.component = "prompt-input"
  editor.contentEditable = "true"
  editor.textContent = "hello"

  dock.append(editor)
  root.append(dock)
  document.body.append(root)

  return { root, editor }
}

function createScheduler() {
  const frames: FrameRequestCallback[] = []
  const timers: ScheduledTimer[] = []

  return {
    frames,
    timers,
    requestFrame(callback: FrameRequestCallback) {
      frames.push(callback)
      return frames.length
    },
    cancelFrame() {},
    setTimer(callback: () => void, delay: number) {
      timers.push({ callback, delay })
      return timers.length
    },
    clearTimer() {},
  }
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe("panel prompt focus", () => {
  test("treats selectable message text as a focus-preserving pointer target", () => {
    const paragraph = document.createElement("p")
    paragraph.style.userSelect = "text"
    paragraph.textContent = "selectable response"
    document.body.append(paragraph)

    expect(shouldPreservePanelPointerFocus(paragraph)).toBe(true)
  })

  test("allows plain panel background clicks to focus the prompt", () => {
    const background = document.createElement("div")
    document.body.append(background)

    expect(shouldPreservePanelPointerFocus(background)).toBe(false)
  })

  test("skips autofocus only when selectable text activates another panel", () => {
    expect(
      shouldSkipPanelPromptFocusForActivation({
        previousPanelActive: false,
        panelActive: true,
        tabActive: true,
        lastPreservedPointerAt: 1_000,
        now: 1_100,
      }),
    ).toBe(true)

    expect(
      shouldSkipPanelPromptFocusForActivation({
        previousPanelActive: true,
        panelActive: true,
        tabActive: true,
        lastPreservedPointerAt: 1_000,
        now: 1_100,
      }),
    ).toBe(false)
  })

  test("retries when the editor cannot receive focus during the first frame", () => {
    const { root, editor } = createPanel()
    const scheduler = createScheduler()
    const nativeFocus = editor.focus.bind(editor)
    let focusCalls = 0

    editor.focus = () => {
      focusCalls += 1
      if (focusCalls > 1) nativeFocus()
    }

    startPanelPromptFocus({
      root: () => root,
      shouldFocus: () => true,
      isPointerDown: () => false,
      delays: [0],
      ...scheduler,
    })

    scheduler.frames.shift()?.(0)
    expect(focusCalls).toBe(1)
    expect(scheduler.timers).toHaveLength(1)
    expect(scheduler.timers[0]?.delay).toBe(0)

    scheduler.timers.shift()?.callback()
    expect(focusCalls).toBe(2)
    expect(document.activeElement).toBe(editor)
  })

  test("refocuses when session restore replaces the initially focused editor", () => {
    const { root, editor } = createPanel()
    const scheduler = createScheduler()

    startPanelPromptFocus({
      root: () => root,
      shouldFocus: () => true,
      isPointerDown: () => false,
      delays: [0, 50],
      ...scheduler,
    })

    scheduler.frames.shift()?.(0)
    expect(document.activeElement).toBe(editor)
    expect(scheduler.timers).toHaveLength(1)

    const nextEditor = document.createElement("div")
    nextEditor.dataset.component = "prompt-input"
    nextEditor.contentEditable = "true"
    nextEditor.textContent = "restored"
    editor.replaceWith(nextEditor)

    scheduler.timers.shift()?.callback()
    expect(document.activeElement).toBe(nextEditor)
  })

  test("preserves mouse-drag text selection while activation focus is pending", () => {
    const { root, editor } = createPanel()
    const scheduler = createScheduler()
    const selected = document.createElement("p")
    const text = document.createTextNode("select me")
    selected.append(text)
    root.prepend(selected)

    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 6)
    selection.addRange(range)

    let pointerDown = true
    let focusCalls = 0
    editor.focus = () => {
      focusCalls += 1
    }

    startPanelPromptFocus({
      root: () => root,
      shouldFocus: () => true,
      isPointerDown: () => pointerDown,
      delays: [0],
      ...scheduler,
    })

    scheduler.frames.shift()?.(0)
    expect(selection.toString()).toBe("select")
    expect(scheduler.timers).toHaveLength(1)

    pointerDown = false
    scheduler.timers.shift()?.callback()
    expect(focusCalls).toBe(0)
    expect(selection.toString()).toBe("select")
    expect(scheduler.timers).toHaveLength(0)
  })

  test("keeps the user's caret when the panel editor already owns focus", () => {
    const { root, editor } = createPanel()
    const scheduler = createScheduler()
    const text = editor.firstChild!
    editor.focus()

    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    selection.addRange(range)

    startPanelPromptFocus({
      root: () => root,
      shouldFocus: () => true,
      isPointerDown: () => false,
      delays: [0],
      ...scheduler,
    })

    scheduler.frames.shift()?.(0)
    expect(document.activeElement).toBe(editor)
    expect(selection.getRangeAt(0).startContainer).toBe(text)
    expect(selection.getRangeAt(0).startOffset).toBe(2)
    expect(scheduler.timers).toHaveLength(0)
  })

  test("does not move a collapsed selection when focus is rejected", () => {
    const { root, editor } = createPanel()
    const outside = document.createTextNode("outside")
    document.body.prepend(outside)

    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(outside, 3)
    range.collapse(true)
    selection.addRange(range)
    editor.focus = () => {}

    expect(focusPanelPromptEditor(root)).toBe(false)
    expect(selection.getRangeAt(0).startContainer).toBe(outside)
    expect(selection.getRangeAt(0).startOffset).toBe(3)
  })

  test("does not steal focus from a terminal input in another panel", () => {
    const { root } = createPanel()
    const otherPanel = document.createElement("div")
    otherPanel.dataset.panelId = "panel-2"
    const terminal = document.createElement("div")
    terminal.dataset.component = "terminal"
    const terminalInput = document.createElement("textarea")
    terminal.append(terminalInput)
    otherPanel.append(terminal)
    document.body.append(otherPanel)

    const scheduler = createScheduler()
    terminalInput.focus()
    expect(document.activeElement).toBe(terminalInput)

    startPanelPromptFocus({
      root: () => root,
      shouldFocus: () => true,
      isPointerDown: () => false,
      delays: [0],
      ...scheduler,
    })

    scheduler.frames.shift()?.(0)
    expect(document.activeElement).toBe(terminalInput)
    expect(scheduler.timers).toHaveLength(0)
  })

  test("does not steal focus from another panel's prompt editor", () => {
    const { root } = createPanel()
    const otherPanel = document.createElement("div")
    otherPanel.dataset.panelId = "panel-2"
    const otherDock = document.createElement("div")
    otherDock.dataset.component = "session-prompt-dock"
    const otherEditor = document.createElement("div")
    otherEditor.dataset.component = "prompt-input"
    otherEditor.contentEditable = "true"
    otherDock.append(otherEditor)
    otherPanel.append(otherDock)
    document.body.append(otherPanel)

    const scheduler = createScheduler()
    otherEditor.focus()
    expect(document.activeElement).toBe(otherEditor)

    startPanelPromptFocus({
      root: () => root,
      shouldFocus: () => true,
      isPointerDown: () => false,
      delays: [0],
      ...scheduler,
    })

    scheduler.frames.shift()?.(0)
    expect(document.activeElement).toBe(otherEditor)
    expect(scheduler.timers).toHaveLength(0)
  })

  test("focuses the panel editor and places the caret at the end", () => {
    const { root, editor } = createPanel()

    expect(focusPanelPromptEditor(root)).toBe(true)
    expect(document.activeElement).toBe(editor)

    const selection = window.getSelection()!
    expect(selection.isCollapsed).toBe(true)
    expect(selection.getRangeAt(0).endContainer).toBe(editor)
    expect(selection.getRangeAt(0).endOffset).toBe(editor.childNodes.length)
  })
})
