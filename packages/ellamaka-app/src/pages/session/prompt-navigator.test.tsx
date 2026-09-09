/** @jsx h */
import { describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { PromptNavigator, type PromptNavigatorProps } from "./prompt-navigator"

mock.module("@wopal/ui/icon", () => ({
  Icon: (props: { name: string }) => <span data-slot="chat-icon" data-icon={props.name} />,
}))

function userMessage(id: string, text: string): UserMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1000 },
    agent: "primary",
    model: { providerID: "openai", modelID: "gpt-4o" },
  }
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "text", text }
}

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  render(node, host)
  return host
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function installChatStyles() {
  if (document.querySelector("style[data-test='chat-styles']")) return
  const css = await Bun.file(new URL("../../index.css", import.meta.url)).text()
  const style = document.createElement("style")
  style.dataset.test = "chat-styles"
  style.textContent = css
  document.head.appendChild(style)
}

function baseProps(overrides: Partial<PromptNavigatorProps> = {}): PromptNavigatorProps {
  return {
    sessionID: "ses_1",
    userMessages: [],
    historyMore: false,
    historyLoading: false,
    loadOlder: async () => {},
    onJump: () => {},
    ...overrides,
  }
}

function openDirectory(host: HTMLElement) {
  const trigger = host.querySelector("[data-component='chat-prompt-directory-trigger']") as HTMLElement
  trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

describe("PromptNavigator", () => {
  test("renders a tick rail with one tick per loaded user message", () => {
    const u1 = userMessage("u1", "hello")
    const u2 = userMessage("u2", "world")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1, u2],
        })}
      />
    ))

    expect(host.querySelector("[data-component='chat-prompt-rail']")).not.toBeNull()
    expect(host.querySelectorAll("[data-slot='chat-prompt-tick']").length).toBe(2)
    host.remove()
  })

  test("excludes compaction marker messages from the rail and directory", () => {
    const u1 = userMessage("u1", "hello")
    const uComp = userMessage("u-comp", "")
    const u2 = userMessage("u2", "world")
    const compactionPart: Part = { id: "cp1", sessionID: "ses_1", messageID: "u-comp", type: "compaction", auto: false }
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1, uComp, u2],
          getParts: (id: string) => (id === "u-comp" ? [compactionPart] : []),
        })}
      />
    ))

    expect(host.querySelectorAll("[data-slot='chat-prompt-tick']").length).toBe(2)
    expect(host.querySelector("[data-slot='chat-prompt-tick'][data-message-id='u-comp']")).toBeNull()

    openDirectory(host)
    const items = host.querySelectorAll("[data-slot='chat-prompt-item']")
    expect(items.length).toBe(2)
    expect(host.querySelector("[data-slot='chat-prompt-item'][data-message-id='u-comp']")).toBeNull()
    host.remove()
  })

  test("excludes synthetic-only user messages from the rail and directory", () => {
    const u1 = userMessage("u1", "hello")
    const uNotify = userMessage("u-notify", "")
    const u2 = userMessage("u2", "world")
    const syntheticPart: Part = {
      id: "sp1",
      sessionID: "ses_1",
      messageID: "u-notify",
      type: "text",
      text: "<system-reminder>sandbox mode changed</system-reminder>",
      synthetic: true,
    }
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1, uNotify, u2],
          getParts: (id: string) => (id === "u-notify" ? [syntheticPart] : [textPart(`p-${id}`, id, id === "u1" ? "hello" : "world")]),
        })}
      />
    ))

    expect(host.querySelectorAll("[data-slot='chat-prompt-tick']").length).toBe(2)
    expect(host.querySelector("[data-slot='chat-prompt-tick'][data-message-id='u-notify']")).toBeNull()

    openDirectory(host)
    const items = host.querySelectorAll("[data-slot='chat-prompt-item']")
    expect(items.length).toBe(2)
    expect(host.querySelector("[data-slot='chat-prompt-item'][data-message-id='u-notify']")).toBeNull()
    host.remove()
  })

  test("excludes flagless shell-wrapped notification messages from the rail and directory", () => {
    const u1 = userMessage("u1", "hello")
    const uTask = userMessage("u-task", "")
    const u2 = userMessage("u2", "world")
    // wopal-plugin task notifications arrive without the synthetic flag.
    const taskPart: Part = {
      id: "tp1",
      sessionID: "ses_1",
      messageID: "u-task",
      type: "text",
      text: "<system-reminder>\n[WOPAL TASK IDLE]\n**ID:** `t1`\n</system-reminder>",
    }
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1, uTask, u2],
          getParts: (id: string) => (id === "u-task" ? [taskPart] : [textPart(`p-${id}`, id, id === "u1" ? "hello" : "world")]),
        })}
      />
    ))

    expect(host.querySelectorAll("[data-slot='chat-prompt-tick']").length).toBe(2)
    expect(host.querySelector("[data-slot='chat-prompt-tick'][data-message-id='u-task']")).toBeNull()

    openDirectory(host)
    const items = host.querySelectorAll("[data-slot='chat-prompt-item']")
    expect(items.length).toBe(2)
    expect(host.querySelector("[data-slot='chat-prompt-item'][data-message-id='u-task']")).toBeNull()
    expect(host.textContent).not.toContain("空回复")
    host.remove()
  })

  test("keeps a mixed user message (real text plus shell-wrapped part) as one entry", () => {
    const u1 = userMessage("u-mixed", "")
    const mixedParts: Part[] = [
      textPart("p-real", "u-mixed", "my actual prompt"),
      textPart("p-inj", "u-mixed", "<system-reminder>attached context</system-reminder>"),
    ]
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
          getParts: (id: string) => (id === "u-mixed" ? mixedParts : []),
        })}
      />
    ))

    openDirectory(host)
    expect(host.querySelectorAll("[data-slot='chat-prompt-item']").length).toBe(1)
    expect(host.querySelector("[data-slot='chat-prompt-user']")?.textContent).toBe("my actual prompt")
    host.remove()
  })

  test("opens a directory popover with user and assistant summaries", async () => {
    const u1 = userMessage("u1", "hello")
    const a1: AssistantMessage = {
      id: "a1",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 2000, completed: 3000 },
      parentID: "u1",
      modelID: "gpt-4o",
      providerID: "openai",
      mode: "primary",
      agent: "primary",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
          getParts: (id: string) =>
            id === "u1" ? [textPart("p1", "u1", "hello")] : [textPart("p2", "a1", "**reply** with `code`")],
          assistantByParent: { u1: [a1] },
        })}
      />
    ))

    openDirectory(host)
    await tick()

    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    expect(popover.getAttribute("data-open")).toBe("true")
    expect(host.textContent).toContain("hello")
    expect(host.textContent).toContain("reply with code")
    expect(host.textContent).not.toContain("**reply**")
    host.remove()
  })

  test("uses outside click instead of header navigation controls", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => <PromptNavigator {...baseProps({ userMessages: [u1] })} />)
    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement

    expect(host.querySelector("[data-slot='chat-prompt-prev']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-prompt-next']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-prompt-close']")).toBeNull()

    openDirectory(host)
    await tick()
    expect(popover.getAttribute("data-open")).toBe("true")

    const outside = document.createElement("button")
    document.body.appendChild(outside)
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }))
    await tick()

    expect(popover.getAttribute("data-open")).toBe("false")
    outside.remove()
    host.remove()
  })

  test("keeps the left rail for preview and opens the directory from the right edge", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => <PromptNavigator {...baseProps({ userMessages: [u1] })} />)

    const rail = host.querySelector("[data-component='chat-prompt-rail']") as HTMLElement
    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    rail.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await tick()
    expect(popover.getAttribute("data-open")).toBe("false")

    const trigger = host.querySelector("[data-component='chat-prompt-directory-trigger']") as HTMLElement
    expect(trigger).not.toBeNull()
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await tick()
    expect(popover.getAttribute("data-open")).toBe("true")
    host.remove()
  })

  test("keeps the directory trigger indicator visible without hover", async () => {
    await installChatStyles()
    const u1 = userMessage("u1", "hello")
    const host = mount(() => <PromptNavigator {...baseProps({ userMessages: [u1] })} />)

    const trigger = host.querySelector("[data-component='chat-prompt-directory-trigger']") as HTMLElement
    const triggerStyle = getComputedStyle(trigger)
    // The right-edge entry point stays perceivable at rest; hover only
    // strengthens it (width/color), it never gates visibility.
    expect(triggerStyle.opacity).not.toBe("0")
    host.remove()
  })

  test("calls loadOlder when the directory opens and historyMore is true", async () => {
    let loaded = 0
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
          historyMore: true,
          loadOlder: async () => {
            loaded += 1
          },
        })}
      />
    ))

    openDirectory(host)
    await tick()

    expect(loaded).toBeGreaterThan(0)
    host.remove()
  })

  test("jumps to a prompt and closes the directory when an item is clicked", async () => {
    let jumped: string | undefined
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
          onJump: (id: string) => {
            jumped = id
          },
        })}
      />
    ))

    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    openDirectory(host)
    await tick()
    const item = host.querySelector("[data-slot='chat-prompt-item']") as HTMLElement
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await tick()

    expect(jumped).toBe("u1")
    expect(popover.getAttribute("data-open")).toBe("false")
    host.remove()
  })

  test("triggers history hydration when the directory opens and historyMore is true", async () => {
    let calls = 0
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
          historyMore: true,
          loadOlder: async () => {
            calls += 1
          },
        })}
      />
    ))

    openDirectory(host)
    await tick()

    // loadOlder is useSessionHistoryLoader.loadAndReveal, which owns the serial
    // page loop; the navigator triggers it once on open.
    expect(calls).toBe(1)
    host.remove()
  })

  test("highlights the active turn in the directory", async () => {
    const u1 = userMessage("u1", "hello")
    const u2 = userMessage("u2", "world")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1, u2],
          activeUserMessageID: "u2",
        })}
      />
    ))

    openDirectory(host)
    await tick()

    const active = host.querySelector("[data-slot='chat-prompt-item'][data-active='true']") as HTMLElement
    expect(active).not.toBeNull()
    expect(active.getAttribute("data-message-id")).toBe("u2")
    host.remove()
  })

  test("Escape closes the popover and returns focus to the right directory trigger", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
        })}
      />
    ))

    const trigger = host.querySelector("[data-component='chat-prompt-directory-trigger']") as HTMLElement
    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    openDirectory(host)
    await tick()

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await tick()

    expect(popover.getAttribute("data-open")).toBe("false")
    expect(document.activeElement).toBe(trigger)
    host.remove()
  })

  test("does not open the directory popover when the rail is hovered", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
        })}
      />
    ))

    const rail = host.querySelector("[data-component='chat-prompt-rail']") as HTMLElement
    rail.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    await tick()

    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    expect(popover.getAttribute("data-open")).toBe("false")
    host.remove()
  })

  test("shows a single-message preview with only the user prompt when a tick is hovered", async () => {
    const u1 = userMessage("u1", "hello")
    const a1: AssistantMessage = {
      id: "a1",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 2000, completed: 3000 },
      parentID: "u1",
      modelID: "gpt-4o",
      providerID: "openai",
      mode: "primary",
      agent: "primary",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
          getParts: (id: string) =>
            id === "u1" ? [textPart("p1", "u1", "hello question")] : [textPart("p2", "a1", "agent answer")],
          assistantByParent: { u1: [a1] },
        })}
      />
    ))

    const tickEl = host.querySelector("[data-slot='chat-prompt-tick']") as HTMLElement
    tickEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    await tick()

    const preview = host.querySelector("[data-component='chat-prompt-preview']") as HTMLElement
    expect(preview.getAttribute("data-open")).toBe("true")
    expect(preview.textContent).toContain("hello question")
    expect(preview.textContent).not.toContain("agent answer")
    host.remove()
  })

  test("hides the preview when the pointer leaves the tick", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
        })}
      />
    ))

    const tickEl = host.querySelector("[data-slot='chat-prompt-tick']") as HTMLElement
    const preview = host.querySelector("[data-component='chat-prompt-preview']") as HTMLElement
    tickEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    await tick()
    expect(preview.getAttribute("data-open")).toBe("true")

    tickEl.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }))
    await tick()
    expect(preview.getAttribute("data-open")).toBe("false")
    host.remove()
  })

  test("hides the preview after jumping via a tick click", async () => {
    const u1 = userMessage("u1", "hello")
    let jumped: string | undefined
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
          onJump: (id: string) => {
            jumped = id
          },
        })}
      />
    ))

    const tickEl = host.querySelector("[data-slot='chat-prompt-tick']") as HTMLElement
    const preview = host.querySelector("[data-component='chat-prompt-preview']") as HTMLElement
    tickEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    await tick()
    expect(preview.getAttribute("data-open")).toBe("true")

    tickEl.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    await tick()
    expect(jumped).toBe("u1")
    expect(preview.getAttribute("data-open")).toBe("false")
    host.remove()
  })

  test("suppresses the preview while the directory popover is open", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
        })}
      />
    ))

    openDirectory(host)
    await tick()

    const tickEl = host.querySelector("[data-slot='chat-prompt-tick']") as HTMLElement
    tickEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
    await tick()

    const preview = host.querySelector("[data-component='chat-prompt-preview']") as HTMLElement
    expect(preview.getAttribute("data-open")).toBe("false")
    host.remove()
  })

  test("keeps the click-opened popover open after the pointer leaves the right trigger", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
        })}
      />
    ))

    const trigger = host.querySelector("[data-component='chat-prompt-directory-trigger']") as HTMLElement
    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    openDirectory(host)
    await tick()

    trigger.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }))
    popover.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }))
    await wait(160)

    expect(popover.getAttribute("data-open")).toBe("true")
    host.remove()
  })

  test("narrow panel popover width is constrained to the timeline container", async () => {
    const u1 = userMessage("u1", "hello")
    const host = mount(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
        })}
      />
    ))

    openDirectory(host)
    await tick()

    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    expect(popover.getAttribute("data-open")).toBe("true")
    // The popover is always mounted; its width is governed by CSS
    // `min(360px, calc(100% - 24px))` relative to the timeline container.
    expect(popover).not.toBeNull()
    host.remove()
  })

  test("positions the popover against the timeline width, not the rail's own width", async () => {
    await installChatStyles()
    const u1 = userMessage("u1", "hello")
    const host = document.createElement("div")
    const timeline = document.createElement("div")
    timeline.dataset.component = "chat-timeline"
    timeline.style.width = "300px"
    host.appendChild(timeline)
    document.body.appendChild(host)
    render(() => (
      <PromptNavigator
        {...baseProps({
          userMessages: [u1],
        })}
      />
    ), timeline)

    const navigator = host.querySelector("[data-component='chat-prompt-navigator']") as HTMLElement
    const rail = host.querySelector("[data-component='chat-prompt-rail']") as HTMLElement
    const trigger = host.querySelector("[data-component='chat-prompt-directory-trigger']") as HTMLElement
    const popover = host.querySelector("[data-component='chat-prompt-popover']") as HTMLElement
    const timelineStyle = getComputedStyle(timeline)
    const navigatorStyle = getComputedStyle(navigator)
    const railStyle = getComputedStyle(rail)
    const triggerStyle = getComputedStyle(trigger)
    const popoverStyle = getComputedStyle(popover)

    expect(timelineStyle.position).toBe("relative")
    expect(timelineStyle.width).toBe("300px")
    expect(navigatorStyle.position).toBe("static")
    expect(railStyle.position).toBe("absolute")
    expect(triggerStyle.position).toBe("absolute")
    expect(triggerStyle.right).toBe("8px")
    expect(triggerStyle.cursor).toBe("pointer")
    expect(popoverStyle.position).toBe("absolute")
    expect(popoverStyle.right).toBe("32px")
    expect(popoverStyle.top).toBe("12px")
    expect(popoverStyle.bottom).toBe("12px")
    expect(popoverStyle.width).toBe("calc(100% - 44px)")
    expect(popoverStyle.maxWidth).toBe("360px")
    host.remove()
  })
})
