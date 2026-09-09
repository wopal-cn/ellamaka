/** @jsx h */
import { describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { createStore } from "solid-js/store"
import { createComponent, createRenderEffect, createSignal, ErrorBoundary } from "solid-js"
import type { JSX } from "solid-js"
import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { WorkbenchChatTimeline, type WorkbenchChatTimelineProps } from "./workbench-chat-timeline"

mock.module("./workbench-markdown-renderer", () => ({
  WorkbenchMarkdown: (props: { text: string; streaming?: boolean }) => {
    const element = document.createElement("div")
    element.dataset.slot = "chat-markdown"
    createRenderEffect(() => {
      element.textContent = props.text
      element.dataset.streaming = String(Boolean(props.streaming))
    })
    return element
  },
}))

mock.module("@wopal/ui/icon", () => ({
  Icon: (props: { name: string }) => <span data-slot="chat-icon" data-icon={props.name} />,
}))

// UserMessageBlock reads useDialog at setup for image previews. The timeline
// test provides no DialogProvider, so stub the dialog context.
mock.module("@wopal/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined }),
}))

// ReasoningBlock, ContextInjectionBlock and the compaction/retry outcomes read
// the language context at setup; the timeline test mounts user rows directly.
mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

mock.module("@wopal/ui/collapsible", () => ({
  Collapsible: Object.assign(
    (props: { open?: boolean; onOpenChange?: (open: boolean) => void; children: JSX.Element }) => (
      <div data-component="collapsible" data-open={props.open}>
        {props.children}
      </div>
    ),
    {
      Trigger: (props: { children: JSX.Element; "data-slot"?: string; "aria-expanded"?: boolean }) => (
        <button data-slot={props["data-slot"] ?? "collapsible-trigger"} aria-expanded={props["aria-expanded"]}>
          {props.children}
        </button>
      ),
      Content: (props: { children: JSX.Element }) => <div data-slot="collapsible-content">{props.children}</div>,
    },
  ),
}))

function userMessage(id: string, opts: Partial<UserMessage> = {}): UserMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1000 },
    agent: "primary",
    model: { providerID: "openai", modelID: "gpt-4o" },
    ...opts,
  }
}

function assistantMessage(id: string, parentID: string, opts: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 2000, completed: 3000 },
    parentID,
    modelID: "gpt-4o",
    providerID: "openai",
    mode: "primary",
    agent: "primary",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...opts,
  }
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "text", text }
}

function toolPart(id: string, messageID: string, state: ToolPart["state"], tool = "bash"): ToolPart {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    callID: `${id}-call`,
    tool,
    state,
  }
}

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  host.style.height = "400px"
  host.style.overflow = "auto"
  document.body.appendChild(host)
  render(node, host)
  return host
}

function baseProps(overrides: Partial<WorkbenchChatTimelineProps> = {}): WorkbenchChatTimelineProps {
  return {
    sessionID: "ses_1",
    userMessages: [],
    historyShift: false,
    historyMore: false,
    historyLoading: false,
    loadOlder: async () => {},
    scroll: { overflow: false, bottom: true, jump: false },
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showSessionProgressBar: true,
    ...overrides,
  }
}

function withSync(messages: Message[], parts: Part[], status: { type: "idle" } | { type: "busy" }) {
  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data: {
        message: { ses_1: messages },
        part: Object.fromEntries(
          messages.map((m) => [m.id, parts.filter((p) => p.messageID === m.id)]),
        ),
        session_status: { ses_1: status },
      },
      session: {
        history: {
          more: () => false,
          loading: () => false,
          loadMore: async () => {},
        },
      },
    }),
  }))
}

function withReactiveSync(messages: Message[], parts: Part[], status: { type: "idle" } | { type: "busy" }) {
  const [data, setData] = createStore({
    message: { ses_1: messages },
    part: Object.fromEntries(messages.map((m) => [m.id, parts.filter((p) => p.messageID === m.id)])) as Record<string, Part[]>,
    session_status: { ses_1: status },
  })
  mock.module("@/context/sync", () => ({
    useSync: () => ({
      data,
      session: {
        sync: async () => {},
        history: {
          more: () => false,
          loading: () => false,
          loadMore: async () => {},
        },
      },
    }),
  }))
  return (messageID: string, index: number, text: string) => {
    setData("part", messageID, index, (part) => ({ ...part, text }) as Part)
  }
}

describe("WorkbenchChatTimeline", () => {
  test("shows the session progress bar only when enabled and the session is busy", () => {
    const u1 = userMessage("u-progress")
    withSync([u1], [], { type: "busy" })

    const shown = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], showSessionProgressBar: true })} />
    ))
    expect(shown.querySelector("[data-component='session-progress']")).not.toBeNull()
    shown.remove()

    const hidden = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], showSessionProgressBar: false })} />
    ))
    expect(hidden.querySelector("[data-component='session-progress']")).toBeNull()
    hidden.remove()
  })

  test("renders user and assistant rows from the transcript", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const messages: Message[] = [u1, a1]
    const parts = [textPart("p1", "u1", "hello"), textPart("p2", "a1", "reply")]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    expect(host.querySelector("[data-component='chat-user-message']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-narrative']")).not.toBeNull()
    host.remove()
  })

  test("keeps a completed reasoning block expanded when the reasoning-summaries setting is on", () => {
    const u1 = userMessage("u-reason-on")
    const a1 = assistantMessage("a-reason-on", "u-reason-on") // completed
    const messages: Message[] = [u1, a1]
    const reasoning = { id: "r-on", sessionID: "ses_1", messageID: "a-reason-on", type: "reasoning", text: "detailed chain", time: { start: 0, end: 1 } } as Part
    const parts = [textPart("p-u-on", "u-reason-on", "q"), reasoning, textPart("p-a-on", "a-reason-on", "answer")]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
          showReasoningSummaries: true,
        })}
      />
    ))

    const trigger = host.querySelector("[data-slot='chat-reasoning-trigger']")
    expect(trigger?.getAttribute("aria-expanded")).toBe("true")
    host.remove()
  })

  test("renders the reasoning block as collapsed when the reasoning-summaries setting is off", () => {
    const u1 = userMessage("u-reason-off")
    const a1 = assistantMessage("a-reason-off", "u-reason-off")
    const messages: Message[] = [u1, a1]
    const reasoning = { id: "r-off", sessionID: "ses_1", messageID: "a-reason-off", type: "reasoning", text: "chain", time: { start: 0, end: 1 } } as Part
    const parts = [textPart("p-u-off", "u-reason-off", "q"), reasoning, textPart("p-a-off", "a-reason-off", "answer")]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
          showReasoningSummaries: false,
        })}
      />
    ))

    const trigger = host.querySelector("[data-slot='chat-reasoning-trigger']")
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute("aria-expanded")).toBe("false")
    expect(host.querySelector("[data-component='chat-reasoning']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-narrative']")).not.toBeNull()
    host.remove()
  })

  test("renders synthetic parts as injection blocks outside the user bubble", () => {
    const u1 = userMessage("u-inject")
    const a1 = assistantMessage("a-inject", "u-inject") // completed
    const messages: Message[] = [u1, a1]
    const parts: Part[] = [
      textPart("p-u", "u-inject", "prompt"),
      { id: "p-u-inj", sessionID: "ses_1", messageID: "u-inject", type: "text", text: "<rules-context>rule body</rules-context>", synthetic: true },
      { id: "p-a-inj", sessionID: "ses_1", messageID: "a-inject", type: "text", text: "<system-reminder>task note</system-reminder>", synthetic: true },
      textPart("p-a", "a-inject", "answer"),
    ]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    const injections = host.querySelectorAll("[data-component='chat-injection']")
    expect(injections.length).toBe(2)
    expect(injections[0]?.getAttribute("data-injection-tag")).toBe("rules")
    expect(injections[1]?.getAttribute("data-injection-tag")).toBe("reminder")
    // Injections render in the row-level left-aligned channel, never inside
    // the user bubble.
    const turnInjections = host.querySelectorAll("[data-slot='chat-turn-injections']")
    expect(turnInjections.length).toBe(1)
    expect(turnInjections[0]?.querySelector("[data-component='chat-injection']")).not.toBeNull()
    const userBubble = host.querySelector("[data-component='chat-user-message']")
    expect(userBubble?.querySelector("[data-component='chat-injection']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-user-text']")?.textContent).toBe("prompt")
    const narratives = host.querySelectorAll("[data-component='chat-narrative']")
    expect(narratives.length).toBe(1)
    expect(host.textContent).toContain("rule body")
    expect(host.textContent).toContain("task note")
    host.remove()
  })

  test("renders a shell-wrapped user part without the synthetic flag as an injection outside the bubble", () => {
    const u1 = userMessage("u-flagless")
    const a1 = assistantMessage("a-flagless", "u-flagless")
    const messages: Message[] = [u1, a1]
    const parts: Part[] = [
      textPart("p-u-real", "u-flagless", "real prompt"),
      textPart("p-u-flagless", "u-flagless", "<system-reminder>[WOPAL TASK PROGRESS] 3 messages</system-reminder>"),
      textPart("p-a", "a-flagless", "answer"),
    ]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    expect(host.querySelector("[data-component='chat-injection']")).not.toBeNull()
    expect(host.querySelector("[data-slot='chat-user-text']")?.textContent).toBe("real prompt")
    // The raw shell text never leaks into the user bubble.
    expect(host.querySelector("[data-component='chat-user-message']")?.textContent ?? "").not.toContain("system-reminder")
    host.remove()
  })

  test("renders an injection-only user row without a bubble or empty-reply placeholder", () => {
    const u1 = userMessage("u-notify")
    const a1 = assistantMessage("a-notify", "u-notify")
    const messages: Message[] = [u1, a1]
    const parts: Part[] = [
      { id: "p-u-notify", sessionID: "ses_1", messageID: "u-notify", type: "text", text: "<system-reminder>sandbox mode changed</system-reminder>", synthetic: true },
      textPart("p-a", "a-notify", "answer"),
    ]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    // Only the injection container renders; no user bubble, no placeholder.
    expect(host.querySelector("[data-component='chat-injection']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-user-message']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-user-text']")).toBeNull()
    expect(host.textContent).not.toContain("空回复")
    expect(host.textContent).not.toContain("（无回复）")
    host.remove()
  })

  test("renders a flagless shell-only user row as injections only, with no bubble", () => {
    const u1 = userMessage("u-shell-notify")
    const a1 = assistantMessage("a-shell-notify", "u-shell-notify")
    const messages: Message[] = [u1, a1]
    const parts: Part[] = [
      textPart("p-u-shell", "u-shell-notify", "<system-reminder>[WOPAL TASK IDLE]\nTask finished.\n</system-reminder>"),
      textPart("p-a", "a-shell-notify", "answer"),
    ]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    expect(host.querySelector("[data-component='chat-injection']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-user-message']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-user-text']")).toBeNull()
    host.remove()
  })

  test("renders the live tail for a running turn", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1", { time: { created: 2000 } }) // running
    const messages: Message[] = [u1, a1]
    const parts = [textPart("p1", "u1", "hello"), textPart("p2", "a1", "growing")]
    withSync(messages, parts, { type: "busy" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
        })}
      />
    ))

    expect(host.querySelector("[data-component='chat-live-tail']")).not.toBeNull()
    host.remove()
  })

  test("keeps a collapsed live tool DOM node mounted across status updates", async () => {
    const u1 = userMessage("u-tool-stream")
    const a1 = assistantMessage("a-tool-stream", "u-tool-stream", { time: { created: 2000 } })
    const pending = toolPart("t-tool-stream", "a-tool-stream", {
      status: "pending",
      input: { command: "printf probe", description: "Stream probe output" },
      raw: "",
    })
    const [data, setData] = createStore({
      message: { ses_1: [u1, a1] as Message[] },
      part: { ses_1: [] as Part[], "a-tool-stream": [pending] as Part[] } as Record<string, Part[]>,
      session_status: { ses_1: { type: "busy" } as const },
    })
    mock.module("@/context/sync", () => ({
      useSync: () => ({
        data,
        session: {
          sync: async () => {},
          history: { more: () => false, loading: () => false, loadMore: async () => {} },
        },
      }),
    }))

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({ userMessages: [u1], virtualize: false, shellToolPartsExpanded: false })}
      />
    ))
    const before = host.querySelector("[data-call-id='t-tool-stream-call']")
    expect(before).not.toBeNull()
    expect(before?.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")).toBe("false")

    setData("part", "a-tool-stream", 0, (part) => {
      if (part.type !== "tool") return part
      return {
        ...part,
        state: {
          status: "running" as const,
          input: { command: "printf probe", description: "Stream probe output" },
          metadata: { output: "probe-1\nprobe-2" },
          time: { start: 1 },
        },
      }
    })
    await Promise.resolve()

    const after = host.querySelector("[data-call-id='t-tool-stream-call']")
    const sameNode = after === before
    const status = after?.querySelector("[data-slot='chat-tool-status']")?.getAttribute("data-status")
    const expanded = after?.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")
    host.remove()

    expect(sameNode).toBe(true)
    expect(status).toBe("running")
    expect(expanded).toBe("false")
  })

  test("updates a pending read path from streamed raw input without replacing its info bar", async () => {
    const u1 = userMessage("u-read-stream")
    const a1 = assistantMessage("a-read-stream", "u-read-stream", { time: { created: 2000 } })
    const pending = toolPart(
      "t-read-stream",
      "a-read-stream",
      { status: "pending", input: {}, raw: '{"filePath":"/repo/src/first.ts"' },
      "read",
    )
    const [data, setData] = createStore({
      message: { ses_1: [u1, a1] as Message[] },
      part: { ses_1: [] as Part[], "a-read-stream": [pending] as Part[] } as Record<string, Part[]>,
      session_status: { ses_1: { type: "busy" } as const },
    })
    mock.module("@/context/sync", () => ({
      useSync: () => ({
        data,
        session: {
          sync: async () => {},
          history: { more: () => false, loading: () => false, loadMore: async () => {} },
        },
      }),
    }))

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({ userMessages: [u1], directory: "/repo", virtualize: false })}
      />
    ))
    const before = host.querySelector("[data-call-id='t-read-stream-call']")
    expect(before?.querySelector("[data-slot='chat-tool-subtitle']")?.textContent).toBe("src/first.ts")

    setData("part", "a-read-stream", 0, (part) => {
      if (part.type !== "tool" || part.state.status !== "pending") return part
      return { ...part, state: { ...part.state, raw: '{"filePath":"/repo/src/second.ts"' } }
    })
    await Promise.resolve()

    const after = host.querySelector("[data-call-id='t-read-stream-call']")
    const subtitle = after?.querySelector("[data-slot='chat-tool-subtitle']")
    host.remove()

    expect(after).toBe(before)
    expect(subtitle?.textContent).toBe("src/second.ts")
  })

  test("shows the assistant meta line only under the final narrative part", () => {
    const u1 = userMessage("u-meta")
    const a1 = assistantMessage("a-meta", "u-meta", { agent: "fae" })
    const messages: Message[] = [u1, a1]
    const parts = [
      textPart("p1", "u-meta", "hello"),
      textPart("p2", "a-meta", "first paragraph"),
      textPart("p3", "a-meta", "final paragraph"),
    ]
    withSync(messages, parts, { type: "idle" })
    const resolveModel = (_providerID: string, _modelID: string) => "GPT-4o"

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [u1],
          virtualize: false,
          modelName: resolveModel,
        })}
      />
    ))

    const narratives = host.querySelectorAll("[data-component='chat-narrative']")
    expect(narratives.length).toBe(2)
    const metas = host.querySelectorAll("[data-slot='chat-narrative-meta']")
    expect(metas.length).toBe(1)
    const lastMeta = metas[0]
    expect(lastMeta?.closest("[data-component='chat-narrative']")?.textContent).toContain("final paragraph")
    expect(lastMeta?.textContent).toContain("Fae")
    expect(lastMeta?.textContent).toContain("GPT-4o")
    host.remove()
  })

  test("shows meta only on the final assistant message of a multi-message turn", () => {
    const u1 = userMessage("u-multi")
    const a1 = assistantMessage("a-multi-1", "u-multi", { agent: "wopal" })
    const a2 = assistantMessage("a-multi-2", "u-multi", { agent: "wopal" })
    const messages: Message[] = [u1, a1, a2]
    const parts = [
      textPart("p1", "u-multi", "question"),
      textPart("p2", "a-multi-1", "中间回复，接下来调用工具"),
      textPart("p3", "a-multi-2", "最终回复"),
    ]
    withSync(messages, parts, { type: "idle" })
    const resolveModel = (_providerID: string, _modelID: string) => "GPT-4o"

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [u1],
          virtualize: false,
          modelName: resolveModel,
        })}
      />
    ))

    const narratives = host.querySelectorAll("[data-component='chat-narrative']")
    expect(narratives.length).toBe(2)
    const metas = host.querySelectorAll("[data-slot='chat-narrative-meta']")
    expect(metas.length).toBe(1)
    expect(metas[0]?.closest("[data-component='chat-narrative']")?.textContent).toContain("最终回复")
    expect(metas[0]?.textContent).toContain("Wopal")
    expect(metas[0]?.textContent).toContain("GPT-4o")
    host.remove()
  })

  test("renders an unknown tool through the generic tool block instead of dropping it", () => {
    const u1 = userMessage("u-unknown-tool")
    const a1 = assistantMessage("a-unknown-tool", "u-unknown-tool")
    const generic = toolPart(
      "t-unknown-tool",
      "a-unknown-tool",
      {
        status: "completed",
        input: { command: "search", query: "dev-flow" },
        output: "found 3 memories",
        title: "memory_manage",
        metadata: {},
        time: { start: Date.now() - 2000, end: Date.now() - 1000 },
      },
      "memory_manage",
    )
    withSync([u1, a1], [generic], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], virtualize: false })} />
    ))

    expect(host.querySelector("[data-component='chat-generic-tool']")).not.toBeNull()
    expect(host.textContent).toContain("memory_manage")
    host.remove()
  })

  test("keeps todowrite parts out of the transcript since the todo dock shows them", () => {
    const u1 = userMessage("u-todo-hidden")
    const a1 = assistantMessage("a-todo-hidden", "u-todo-hidden")
    const todo = toolPart(
      "t-todo-hidden",
      "a-todo-hidden",
      {
        status: "completed",
        input: { todos: [{ id: "1", content: "task one", status: "completed" }] },
        output: "",
        title: "todowrite",
        metadata: {},
        time: { start: Date.now() - 2000, end: Date.now() - 1000 },
      },
      "todowrite",
    )
    withSync([u1, a1], [todo], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], virtualize: false })} />
    ))

    expect(host.querySelector("[data-component='chat-todo']")).toBeNull()
    expect(host.textContent).not.toContain("task one")
    host.remove()
  })

  test("shows the current thinking phase while a busy turn has not started a tool", () => {
    const u1 = userMessage("u-thinking")
    const a1 = assistantMessage("a-thinking", "u-thinking", { time: { created: Date.now() } })
    withSync([u1, a1], [], { type: "busy" })

    const host = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], virtualize: false })} />
    ))

    const activity = host.querySelector("[data-component='chat-live-activity']")
    expect(activity?.textContent).toContain("正在思考")
    expect(activity?.querySelector("[data-component='spinner']")).not.toBeNull()
    expect(activity?.querySelector("[data-slot='chat-live-activity-indicator']")).toBeNull()
    host.remove()
  })

  test("shows that the agent is considering its next step after a shell completes", () => {
    const u1 = userMessage("u-next-step")
    const a1 = assistantMessage("a-next-step", "u-next-step", { time: { created: Date.now() } })
    const shell = toolPart("t-next-step", "a-next-step", {
      status: "completed",
      input: { command: "ls projects", description: "Inspect project directories" },
      output: "a\nb",
      title: "Inspect project directories",
      metadata: {},
      time: { start: Date.now() - 2000, end: Date.now() - 1000 },
    })
    withSync([u1, a1], [shell], { type: "busy" })

    const host = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], virtualize: false })} />
    ))

    expect(host.querySelector("[data-component='chat-live-activity']")?.textContent).toContain("正在考虑下一步")
    host.remove()
  })

  test("keeps the working indicator visible while a shell is running", () => {
    const u1 = userMessage("u-running-shell")
    const a1 = assistantMessage("a-running-shell", "u-running-shell", { time: { created: Date.now() } })
    const shell = toolPart("t-running-shell", "a-running-shell", {
      status: "running",
      input: { command: "bun test", description: "Run focused tests" },
      metadata: { output: "running" },
      time: { start: Date.now() - 1000 },
    })
    withSync([u1, a1], [shell], { type: "busy" })

    const host = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], virtualize: false })} />
    ))

    expect(host.querySelector("[data-component='chat-live-activity']")?.textContent).toContain("正在运行命令")
    expect(host.querySelector("[data-slot='chat-tool-status']")?.textContent).toContain("正在运行")
    host.remove()
  })

  test("uses the whole busy-turn duration instead of resetting at each part", () => {
    const created = Date.now() - 65_000
    const u1 = userMessage("u-busy-duration", { time: { created } })
    const a1 = assistantMessage("a-busy-duration", "u-busy-duration", { time: { created } })
    const shell = toolPart("t-busy-duration", "a-busy-duration", {
      status: "running",
      input: { command: "bun test", description: "Run focused tests" },
      metadata: { output: "running" },
      time: { start: Date.now() - 1000 },
    })
    withSync([u1, a1], [shell], { type: "busy" })

    const host = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], virtualize: false })} />
    ))

    expect(host.querySelector("[data-slot='chat-live-activity-elapsed']")?.textContent).toMatch(/1m\s+5s/)
    host.remove()
  })

  test("reserves the working-indicator tail slot after a turn becomes idle", () => {
    const u1 = userMessage("u-idle-slot")
    withSync([u1], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline {...baseProps({ userMessages: [u1], virtualize: false })} />
    ))

    expect(host.querySelector("[data-component='chat-live-activity-slot']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-live-activity']")).toBeNull()
    host.remove()
  })

  test("renders text deltas immediately while the assistant message is streaming", async () => {
    const u1 = userMessage("u-stream")
    const a1 = assistantMessage("a-stream", "u-stream", { time: { created: 2000 } })
    const messages: Message[] = [u1, a1]
    const parts = [textPart("p-user", "u-stream", "hello"), textPart("p-stream", "a-stream", "first")]
    const setPartText = withReactiveSync(messages, parts, { type: "busy" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({ userMessages: [u1], virtualize: false })}
      />
    ))

    const markdown = host.querySelector("[data-slot='chat-markdown']") as HTMLElement
    expect(markdown.textContent).toBe("first")
    expect(markdown.dataset.streaming).toBe("true")

    setPartText("a-stream", 0, "first second")
    await Promise.resolve()
    expect(markdown.textContent).toBe("first second")
    host.remove()
  })

  test("wires fork and revert actions into user message rows", async () => {
    const u1 = userMessage("u-actions")
    withSync([u1], [textPart("p-actions", "u-actions", "branch here")], { type: "idle" })
    const calls: Array<Record<string, string>> = []
    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [u1],
          virtualize: false,
          actions: {
            fork: async (input) => {
              calls.push(input)
            },
            revert: async (input) => {
              calls.push(input)
            },
          },
        })}
      />
    ))

    expect(host.querySelector("[data-action='chat-user-fork']")).not.toBeNull()
    ;(host.querySelector("[data-action='chat-user-revert']") as HTMLButtonElement).click()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toContainEqual({ sessionID: "ses_1", messageID: "u-actions" })
    host.remove()
  })

  test("moves completed turns into virtual history and running turns into the live tail", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2", { time: { created: 2000 } }) // running
    const messages: Message[] = [u1, a1, u2, a2]
    const parts = [textPart("p1", "a1", "done"), textPart("p2", "a2", "growing")]
    withSync(messages, parts, { type: "busy" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    expect(host.querySelector("[data-component='chat-virtual-history']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-live-tail']")).not.toBeNull()
    host.remove()
  })

  test("calls loadOlder when historyMore is true and the user scrolls to the top", () => {
    let loaded = 0
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          historyMore: true,
          loadOlder: async () => {
            loaded += 1
          },
        })}
      />
    ))

    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLElement
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))

    expect(loaded).toBeGreaterThan(0)
    host.remove()
  })

  test("keeps the first visible row key stable across history prepend", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const messages: Message[] = [u1, a1]
    const parts = [textPart("p1", "u1", "hello"), textPart("p2", "a1", "reply")]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    const firstRow = host.querySelector("[data-component='chat-virtual-history'] [data-row-key]")
    expect(firstRow).not.toBeNull()
    host.remove()
  })

  test("does not render rows at or after the revert boundary", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2")
    const messages: Message[] = [u1, a1, u2, a2]
    const parts = [textPart("p1", "u1", "hello"), textPart("p2", "a1", "reply"), textPart("p3", "u2", "later"), textPart("p4", "a2", "later reply")]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
          revert: "u2",
        })}
      />
    ))

    expect(host.querySelector("[data-turn-id='u1']")).not.toBeNull()
    expect(host.querySelector("[data-turn-id='u2']")).toBeNull()
    expect(host.textContent).toContain("hello")
    expect(host.textContent).not.toContain("later")
    host.remove()
  })

  test("does not crash when a revert shrinks history before the virtualizer refreshes its index", async () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2")
    const messages: Message[] = [u1, a1, u2, a2]
    const parts = [
      textPart("p1", "u1", "first prompt"),
      textPart("p2", "a1", "first reply"),
      textPart("p3", "u2", "second prompt"),
      textPart("p4", "a2", "second reply"),
    ]
    withSync(messages, parts, { type: "idle" })
    const [revert, setRevert] = createSignal<string>()
    let virtualizer: { findItemIndex?: (offset: number) => number } | undefined

    const host = mount(() => (
      <ErrorBoundary fallback={(error) => <div data-component="timeline-error">{error.message}</div>}>
        {createComponent(WorkbenchChatTimeline, {
          ...baseProps({
            userMessages: [u1, u2],
            onVirtualizer: (handle) => {
              virtualizer = handle
            },
          }),
          get revert() {
            return revert()
          },
        })}
      </ErrorBoundary>
    ))

    expect(virtualizer).toBeDefined()
    virtualizer!.findItemIndex = () => 999
    setRevert("u2")
    await Promise.resolve()

    expect(host.querySelector("[data-component='timeline-error']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-prompt-tick'][data-message-id='u1']")).not.toBeNull()
    expect(host.querySelector("[data-slot='chat-prompt-tick'][data-message-id='u2']")).toBeNull()
    host.remove()
  })

  test("loads earlier history on scroll without treating layout scrolls as user intent", () => {
    let loaded = 0
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          historyMore: true,
          loadOlder: async () => {
            loaded += 1
          },
        })}
      />
    ))

    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLElement
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))

    expect(loaded).toBeGreaterThan(0)
    host.remove()
  })

  test("pauses bottom-following when a user scroll gesture moves the viewport", () => {
    let userScrolled = false
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          onUserScroll: () => {
            userScrolled = true
          },
        })}
      />
    ))

    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLElement
    scroller.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    scroller.dispatchEvent(new Event("pointermove", { bubbles: true }))
    scroller.scrollTop = 100
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))

    expect(userScrolled).toBe(true)
    host.remove()
  })

  test("does not pause bottom-following for a click followed by an automatic scroll", () => {
    let userScrolled = false
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          onUserScroll: () => {
            userScrolled = true
          },
        })}
      />
    ))

    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLElement
    scroller.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))

    expect(userScrolled).toBe(false)
    host.remove()
  })

  test("clears a pending pointer gesture when the drag is released outside the scroller", () => {
    let userScrolled = false
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          onUserScroll: () => {
            userScrolled = true
          },
        })}
      />
    ))

    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLElement
    scroller.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    scroller.dispatchEvent(new Event("pointermove", { bubbles: true }))
    // The drag ends over panel chrome outside the scroller, so the release
    // never bubbles back through the scroller's own pointerup handler.
    window.dispatchEvent(new Event("pointerup"))
    scroller.scrollTop = 100
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))

    expect(userScrolled).toBe(false)
    host.remove()
  })

  test("forwards every scroller scroll to the follow controller", () => {
    let observed = 0
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          onAutoScroll: () => {
            observed += 1
          },
        })}
      />
    ))

    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLElement
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))

    expect(observed).toBe(1)
    host.remove()
  })

  test("exposes a latest navigator that measures virtual history before pinning", () => {
    let latest: (() => void) | undefined
    let captured: { measure?: () => void } | undefined
    let measured = 0
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          virtualize: false,
          onVirtualizer: (handle) => {
            captured = handle as unknown as { measure?: () => void }
          },
          onLatestScrollNavigator: (navigator) => {
            latest = navigator
          },
        })}
      />
    ))

    expect(latest).toBeDefined()
    captured!.measure = () => {
      measured += 1
    }
    latest!()

    expect(measured).toBe(1)
    host.remove()
  })

  test("binds distinct scroll and content roots for streaming resize observation", () => {
    let scrollRef: HTMLDivElement | undefined
    let contentRef: HTMLDivElement | undefined
    withSync([userMessage("u1")], [], { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          setScrollRef: (el) => {
            scrollRef = el
          },
          setContentRef: (el) => {
            contentRef = el
          },
        })}
      />
    ))

    expect(scrollRef).not.toBeUndefined()
    expect(contentRef).not.toBeUndefined()
    expect(scrollRef).not.toBe(contentRef)
    expect(scrollRef?.dataset.component).toBe("chat-scroller")
    expect(contentRef?.dataset.component).toBe("chat-content")
    host.remove()
  })

  test("shows a resume-scroll action when the viewport is far from the live tail", () => {
    let resumed = 0
    withSync([userMessage("u1")], [], { type: "idle" })
    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [userMessage("u1")],
          scroll: { overflow: true, bottom: false, jump: true },
          onResumeScroll: () => {
            resumed += 1
          },
        })}
      />
    ))
    ;(host.querySelector("[data-action='chat-resume-scroll']") as HTMLButtonElement).click()
    expect(resumed).toBe(1)
    host.remove()
  })

  test("renders compaction, retry, interaction and unknown parts", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const messages: Message[] = [u1, a1]
    const parts: Part[] = [
      { id: "c1", sessionID: "ses_1", messageID: "a1", type: "compaction", auto: true },
      {
        id: "r1",
        sessionID: "ses_1",
        messageID: "a1",
        type: "retry",
        attempt: 1,
        error: { name: "APIError", data: { message: "retry", isRetryable: true } },
        time: { created: 0 },
      },
      {
        id: "q1",
        sessionID: "ses_1",
        messageID: "a1",
        type: "tool",
        callID: "c_q",
        tool: "question",
        state: { status: "completed", input: {}, output: "", title: "question", metadata: {}, time: { start: 0, end: 1 } },
      },
      {
        id: "u1",
        sessionID: "ses_1",
        messageID: "a1",
        type: "future-part",
      } as unknown as Part,
    ]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    expect(host.querySelector("[data-component='chat-compaction']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-retry']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-interaction']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-unknown-part']")).not.toBeNull()
    host.remove()
  })

  test("jumps through the virtualizer handle when PromptNavigator selects a history turn", async () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2")
    const messages: Message[] = [u1, a1, u2, a2]
    const parts = [
      textPart("p1", "u1", "hello"),
      textPart("p2", "a1", "reply"),
      textPart("p3", "u2", "next"),
      textPart("p4", "a2", "reply2"),
    ]
    withSync(messages, parts, { type: "idle" })

    let captured: { scrollToIndex: (i: number, o?: unknown) => void } | undefined
    const calls: Array<{ index: number; options: unknown }> = []
    let paused = 0
    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
          onVirtualizer: (handle) => {
            captured = handle as unknown as { scrollToIndex: (i: number, o?: unknown) => void }
          },
          onPauseAutoScroll: () => {
            paused += 1
          },
        })}
      />
    ))

    expect(captured).not.toBeUndefined()
    captured!.scrollToIndex = (index, options) => {
      calls.push({ index, options })
    }

    const directoryTrigger = host.querySelector("[data-component='chat-prompt-directory-trigger']") as HTMLElement
    directoryTrigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    const target = host.querySelector("[data-slot='chat-prompt-item'][data-message-id='u2']") as HTMLElement
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }))

    expect(calls).toEqual([{ index: 2, options: { align: "start" } }])
    expect(paused).toBe(1)
    host.remove()
  })

  test("exposes first, previous and next user-message navigation through the timeline", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2")
    const u3 = userMessage("u3")
    const a3 = assistantMessage("a3", "u3")
    const messages: Message[] = [u1, a1, u2, a2, u3, a3]
    const parts = [
      textPart("p1", "u1", "first"),
      textPart("p2", "a1", "reply"),
      textPart("p3", "u2", "second"),
      textPart("p4", "a2", "reply"),
      textPart("p5", "u3", "third"),
      textPart("p6", "a3", "reply"),
    ]
    withSync(messages, parts, { type: "idle" })

    let captured: { scrollToIndex: (index: number, options?: unknown) => void } | undefined
    let navigate: ((direction: "first" | "previous" | "next") => boolean) | undefined
    const calls: Array<{ index: number; options: unknown }> = []
    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: [u1, u2, u3],
          virtualize: false,
          activeUserMessageIDOverride: "u2",
          onVirtualizer: (handle) => {
            captured = handle as unknown as { scrollToIndex: (index: number, options?: unknown) => void }
          },
          onUserMessageNavigator: (navigator) => {
            navigate = navigator
          },
        })}
      />
    ))

    expect(captured).not.toBeUndefined()
    captured!.scrollToIndex = (index, options) => calls.push({ index, options })
    expect(navigate?.("first")).toBe(true)
    expect(navigate?.("previous")).toBe(true)
    expect(navigate?.("next")).toBe(true)
    expect(calls).toEqual([
      { index: 0, options: { align: "start" } },
      { index: 0, options: { align: "start" } },
      { index: 4, options: { align: "start" } },
    ])
    host.remove()
  })

  test("updates rail and transcript highlight after scrolling to a new viewport anchor", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2")
    const messages: Message[] = [u1, a1, u2, a2]
    const parts = [
      textPart("p1", "u1", "hello"),
      textPart("p2", "a1", "reply"),
      textPart("p3", "u2", "world"),
      textPart("p4", "a2", "reply2"),
    ]
    withSync(messages, parts, { type: "idle" })

    const host = mount(() => (
      <WorkbenchChatTimeline
        {...baseProps({
          userMessages: messages.filter((m) => m.role === "user") as UserMessage[],
          virtualize: false,
        })}
      />
    ))

    // Initially the first turn is active.
    const activeTick = host.querySelector("[data-slot='chat-prompt-tick'][data-active='true']") as HTMLElement
    expect(activeTick.getAttribute("data-message-id")).toBe("u1")
    expect(host.querySelector("[data-row-type='user'][data-active='true']")?.getAttribute("data-turn-id")).toBe("u1")

    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLDivElement
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 120 })
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))

    const activeTickAfter = host.querySelector("[data-slot='chat-prompt-tick'][data-active='true']") as HTMLElement
    expect(activeTickAfter.getAttribute("data-message-id")).toBe("u2")
    expect(host.querySelector("[data-row-type='user'][data-active='true']")?.getAttribute("data-turn-id")).toBe("u2")
    host.remove()
  })
})
