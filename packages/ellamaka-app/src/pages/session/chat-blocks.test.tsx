/** @jsx h */
import { describe, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import h from "solid-js/h"
import { createComponent, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import type { AssistantMessage, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"

mock.module("./workbench-markdown-renderer", () => ({
  WorkbenchMarkdown: (props: { text: string }) => <div data-slot="chat-markdown">{props.text}</div>,
}))

mock.module("@wopal/ui/icon", () => ({
  Icon: (props: { name: string }) => <span data-slot="chat-icon" data-icon={props.name} />,
}))

const showDialog = mock((_content: () => JSX.Element) => undefined)

mock.module("@wopal/ui/context/dialog", () => ({
  useDialog: () => ({ show: showDialog }),
}))

mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

type FileDiffStubProps = {
  mode?: string
  fileDiff?: { deletionLines?: string[]; additionLines?: string[] }
  before?: { contents?: string }
  after?: { contents?: string }
}

mock.module("@wopal/ui/context/file", () => ({
  useFileComponent: () => (props: FileDiffStubProps) => (
    <div data-component="file-diff-block" data-mode={props.mode}>
      <span data-slot="file-diff-deletions">
        {props.fileDiff?.deletionLines?.join("") ?? props.before?.contents}
      </span>
      <span data-slot="file-diff-additions">
        {props.fileDiff?.additionLines?.join("") ?? props.after?.contents}
      </span>
    </div>
  ),
}))

type OpenCodeMessagePartStubProps = {
  part: ToolPart
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
}

function OpenCodeMessagePartStub(props: OpenCodeMessagePartStubProps) {
  const filename = () => {
    const path = props.part.state.input.filePath
    return typeof path === "string" ? path.split("/").pop() : undefined
  }
  const diff = () =>
    (props.part.state as ToolPart["state"] & {
      metadata?: { filediff?: { additions?: number; deletions?: number } }
    }).metadata?.filediff

  return (
    <div
      data-component="tool-part-wrapper"
      data-renderer="opencode-message-part"
      data-defer-tool-content={String(props.deferToolContent)}
      data-virtualize-diff={String(props.virtualizeDiff)}
    >
      <div data-component="edit-tool">
        <button
          data-slot="basic-tool-trigger"
          aria-expanded={props.toolOpen}
          onClick={() => props.onToolOpenChange?.(!props.toolOpen)}
        >
          edit {filename()} +{diff()?.additions ?? 0} -{diff()?.deletions ?? 0}
        </button>
        <div data-component="tool-file-accordion">
          <div data-component="edit-content">
            <div data-component="file" data-mode="diff" />
          </div>
        </div>
      </div>
    </div>
  )
}

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
      Content: (props: JSX.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
    },
  ),
}))
import {
  ContextInjectionBlock,
  InteractionBlock,
  NarrativeBlock,
  ReasoningBlock,
  TurnOutcome,
  UserMessageBlock,
} from "./chat-blocks"
import {
  ContextToolBlock,
  FileChangeBlock,
  GenericToolBlock,
  ShellActivityBlock,
  SubagentActivityBlock,
} from "./chat-tool-blocks"
import { chatExpansionState } from "./chat-expansion-state"

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

function syntheticTextPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "text", text, synthetic: true }
}

function reasoningPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "reasoning", text, time: { start: 0, end: 1 } }
}

function toolPart(id: string, messageID: string, tool: string, callID: string, state?: Partial<ToolPart["state"]>): ToolPart {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    callID,
    tool,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
      ...state,
    } as ToolPart["state"],
  }
}

function mount(node: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  render(node, host)
  return host
}

describe("UserMessageBlock", () => {
  test("renders the user prompt text", () => {
    const u = userMessage("u1")
    const parts = [textPart("p1", "u1", "hello world")]
    const host = mount(() => <UserMessageBlock message={u} parts={parts} />)
    expect(host.querySelector("[data-component='chat-user-message']")).not.toBeNull()
    expect(host.textContent).toContain("hello world")
    host.remove()
  })

  test("renders file attachments as chips", () => {
    const u = userMessage("u1")
    const parts: Part[] = [
      textPart("p1", "u1", "check this"),
      { id: "f1", sessionID: "s", messageID: "u1", type: "file", mime: "text/plain", url: "file:///a.ts", filename: "a.ts" },
    ]
    const host = mount(() => <UserMessageBlock message={u} parts={parts} />)
    expect(host.querySelector("[data-slot='chat-user-attachment']")).not.toBeNull()
    expect(host.textContent).toContain("a.ts")
    host.remove()
  })

  test("renders image attachments as clickable thumbnails that open a preview", () => {
    const u = userMessage("u-image")
    const imageURL = "data:image/png;base64,iVBORw0KGgo="
    const parts: Part[] = [
      textPart("p-image", "u-image", "look at this"),
      {
        id: "image-1",
        sessionID: "s",
        messageID: "u-image",
        type: "file",
        mime: "image/png",
        url: imageURL,
        filename: "terminal.png",
      },
    ]
    const host = mount(() => <UserMessageBlock message={u} parts={parts} />)
    const image = host.querySelector("[data-slot='chat-user-image-attachment']") as HTMLButtonElement

    expect(image).not.toBeNull()
    expect(image.querySelector("img")?.getAttribute("src")).toBe(imageURL)
    expect(image.querySelector("img")?.getAttribute("alt")).toBe("terminal.png")
    const text = host.querySelector("[data-slot='chat-user-text']")
    expect(image.compareDocumentPosition(text!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    image.click()
    expect(showDialog).toHaveBeenCalledTimes(1)
    host.remove()
  })

  test("renders agent reference and subtask summary", () => {
    const u = userMessage("u1")
    const parts: Part[] = [
      { id: "a1", sessionID: "s", messageID: "u1", type: "agent", name: "primary" },
      {
        id: "s1",
        sessionID: "s",
        messageID: "u1",
        type: "subtask",
        prompt: "do it",
        description: "a subtask",
        agent: "primary",
      },
    ]
    const host = mount(() => <UserMessageBlock message={u} parts={parts} />)
    expect(host.querySelector("[data-slot='chat-user-agent']")).not.toBeNull()
    expect(host.querySelector("[data-slot='chat-user-subtask']")).not.toBeNull()
    host.remove()
  })

  test("offers fork and revert actions and sends the message boundary", async () => {
    const u = userMessage("u-actions")
    const parts = [textPart("p-actions", "u-actions", "branch here")]
    const calls: Array<Record<string, string>> = []
    const host = mount(() => (
      <UserMessageBlock
        message={u}
        parts={parts}
        actions={{
          fork: async (input) => {
            calls.push(input)
          },
          revert: async (input) => {
            calls.push(input)
          },
        }}
      />
    ))

    ;(host.querySelector("[data-action='chat-user-fork']") as HTMLButtonElement).click()
    expect(host.querySelector("[data-slot='chat-user-fork-menu']")).not.toBeNull()
    ;(host.querySelector("[data-action='chat-user-fork-current']") as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls[0]).toEqual({ sessionID: "ses_1", messageID: "u-actions", target: "current" })

    ;(host.querySelector("[data-action='chat-user-revert']") as HTMLButtonElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls[1]).toEqual({ sessionID: "ses_1", messageID: "u-actions" })
    host.remove()
  })

  test("does not render injection parts; they are handled by the transcript row layer", () => {
    const u = userMessage("u-inject")
    const parts: Part[] = [
      textPart("p1", "u-inject", "my prompt"),
      syntheticTextPart("p2", "u-inject", "<rules-context>**Rule:** be terse</rules-context>"),
    ]
    const host = mount(() => <UserMessageBlock message={u} parts={parts} />)
    // The bubble keeps only the real prompt text; injections never enter it.
    expect(host.querySelector("[data-slot='chat-user-text']")?.textContent).toBe("my prompt")
    expect(host.querySelector("[data-component='chat-injection']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-turn-injections']")).toBeNull()
    host.remove()
  })

  test("renders no bubble for a shell-wrapped text part without the synthetic flag", () => {
    const u = userMessage("u-shell-only")
    const parts: Part[] = [
      textPart("p1", "u-shell-only", "<system-reminder>[WOPAL TASK PROGRESS] running</system-reminder>"),
    ]
    const host = mount(() => <UserMessageBlock message={u} parts={parts} />)
    expect(host.querySelector("[data-slot='chat-user-text']")).toBeNull()
    expect(host.querySelector("[data-component='chat-injection']")).toBeNull()
    host.remove()
  })
})

describe("ContextInjectionBlock", () => {
  test("renders a collapsed injection block with label and shell tag", () => {
    const part = syntheticTextPart("p-inj", "u1", "<memory-context>memory body</memory-context>")
    const host = mount(() => <ContextInjectionBlock part={part} />)
    const block = host.querySelector("[data-component='chat-injection']")
    expect(block).not.toBeNull()
    expect(block?.getAttribute("data-injection-tag")).toBe("memory")
    expect(host.querySelector("[data-slot='chat-injection-label']")?.textContent).toBe("workbench.chat.injection")
    expect(host.querySelector("[data-slot='chat-injection-tag']")?.textContent).toBe("memory")
    const trigger = host.querySelector("[data-slot='chat-injection-trigger']") as HTMLElement
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    host.remove()
  })

  test("renders shell-wrapped parts that lack the synthetic flag", () => {
    const part = textPart("p-inj-flagless", "u1", "<system-reminder>[WOPAL TASK IDLE]\ntask finished\n</system-reminder>")
    const host = mount(() => <ContextInjectionBlock part={part} />)
    const block = host.querySelector("[data-component='chat-injection']")
    expect(block).not.toBeNull()
    expect(block?.getAttribute("data-injection-tag")).toBe("reminder")
    expect(host.querySelector("[data-slot='chat-markdown']")?.textContent).toContain("WOPAL TASK IDLE")
    host.remove()
  })

  test("expands via stored expansion state and shows the tag-stripped markdown body", () => {
    const part = syntheticTextPart("p-inj-open", "u1", "<system-reminder>\n## Sandbox changed\n\n- mode: off\n</system-reminder>")
    chatExpansionState.set(part.sessionID, "injection", part.id, true)
    const host = mount(() => <ContextInjectionBlock part={part} />)
    const trigger = host.querySelector("[data-slot='chat-injection-trigger']") as HTMLElement
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector("[data-slot='chat-injection-content']")).not.toBeNull()
    expect(host.querySelector("[data-slot='chat-markdown']")?.textContent).toContain("## Sandbox changed")
    expect(host.textContent).not.toContain("<system-reminder>")
    host.remove()
  })

  test("uses the reminder tag for content without a recognized shell", () => {
    const part = syntheticTextPart("p-inj-plain", "u1", "plain injected text")
    const host = mount(() => <ContextInjectionBlock part={part} />)
    expect(host.querySelector("[data-component='chat-injection']")?.getAttribute("data-injection-tag")).toBe(
      "reminder",
    )
    host.remove()
  })

  test("renders nothing for narrative text parts", () => {
    const part = textPart("p-plain", "u1", "normal text")
    const host = mount(() => <ContextInjectionBlock part={part} />)
    expect(host.querySelector("[data-component='chat-injection']")).toBeNull()
    host.remove()
  })
})

describe("NarrativeBlock", () => {
  test("renders markdown text", () => {
    const a = assistantMessage("a1", "u1")
    const part = textPart("p1", "a1", "final answer")
    const host = mount(() => <NarrativeBlock part={part} message={a} />)
    expect(host.querySelector("[data-component='chat-narrative']")).not.toBeNull()
    expect(host.textContent).toContain("final answer")
    host.remove()
  })

  test("renders agent, model and duration meta on the completed final part", () => {
    const a = assistantMessage("a1", "u1", {
      agent: "fae",
      modelID: "gpt-4o",
      providerID: "openai",
      time: { created: 2000, completed: 75000 },
    })
    const part = textPart("p1", "a1", "final answer")
    const resolveModel = (_providerID: string, _modelID: string) => "GPT-4o"
    const host = mount(() => <NarrativeBlock part={part} message={a} showMeta modelName={resolveModel} />)
    const meta = host.querySelector("[data-slot='chat-narrative-meta']")
    expect(meta).not.toBeNull()
    expect(meta?.textContent).toContain("Fae")
    expect(meta?.textContent).toContain("GPT-4o")
    expect(meta?.textContent).toContain("1m 13s")
    expect(meta?.querySelector("[data-slot='chat-narrative-meta-dot']")).not.toBeNull()
    host.remove()
  })

  test("hides the meta line while the message is still streaming", () => {
    const a = assistantMessage("a1", "u1", { time: { created: 2000 } })
    const part = textPart("p1", "a1", "growing")
    const host = mount(() => <NarrativeBlock part={part} message={a} showMeta />)
    expect(host.querySelector("[data-slot='chat-narrative-meta']")).toBeNull()
    host.remove()
  })

  test("hides the meta line unless the part is marked as the final narrative", () => {
    const a = assistantMessage("a1", "u1")
    const part = textPart("p1", "a1", "middle text")
    const host = mount(() => <NarrativeBlock part={part} message={a} />)
    expect(host.querySelector("[data-slot='chat-narrative-meta']")).toBeNull()
    host.remove()
  })

  test("falls back to the raw model id when the resolver finds no display name", () => {
    const a = assistantMessage("a1", "u1")
    const part = textPart("p1", "a1", "done")
    const resolveMissing = (_providerID: string, _modelID: string) => undefined
    const host = mount(() => <NarrativeBlock part={part} message={a} showMeta modelName={resolveMissing} />)
    expect(host.querySelector("[data-slot='chat-narrative-meta']")?.textContent).toContain("gpt-4o")
    host.remove()
  })
})

describe("ReasoningBlock", () => {
  test("renders a collapsible thinking block with a label", () => {
    const a = assistantMessage("a1", "u1")
    const part = reasoningPart("r1", "a1", "thinking text")
    const host = mount(() => <ReasoningBlock part={part} message={a} />)
    const reasoning = host.querySelector("[data-component='chat-reasoning']")
    expect(reasoning).not.toBeNull()
    expect(reasoning?.hasAttribute("data-streaming")).toBe(false)
    expect(host.textContent).toContain("workbench.chat.reasoning")
    host.remove()
  })

  test("expands while running and collapses when completed", () => {
    const running = assistantMessage("a1", "u1", { time: { created: 2000 } })
    const part = reasoningPart("r1", "a1", "thinking")
    const host = mount(() => <ReasoningBlock part={part} message={running} />)
    const trigger = host.querySelector("[data-slot='chat-reasoning-trigger']") as HTMLElement
    expect(host.querySelector("[data-component='chat-reasoning']")?.hasAttribute("data-streaming")).toBe(true)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    host.remove()
  })

  test("stays expanded after completion when the reasoning-summaries default is on", () => {
    const completed = assistantMessage("a-keep-open", "u-keep-open")
    const part = reasoningPart("r-keep-open", "a-keep-open", "detailed reasoning")
    const host = mount(() => <ReasoningBlock part={part} message={completed} defaultOpen={true} />)
    const trigger = host.querySelector("[data-slot='chat-reasoning-trigger']") as HTMLElement
    expect(host.querySelector("[data-component='chat-reasoning']")?.hasAttribute("data-streaming")).toBe(false)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(host.textContent).toContain("detailed reasoning")
    host.remove()
  })

  test("defaults to collapsed after completion when the default is off and shows the preview tail", () => {
    const completed = assistantMessage("a-default-closed", "u-default-closed")
    const part = reasoningPart("r-default-closed", "a-default-closed", "internal reasoning")
    const host = mount(() => <ReasoningBlock part={part} message={completed} defaultOpen={false} />)
    const trigger = host.querySelector("[data-slot='chat-reasoning-trigger']") as HTMLElement
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    const preview = host.querySelector("[data-slot='chat-reasoning-preview']")
    expect(preview).not.toBeNull()
    expect(preview?.textContent).toContain("internal reasoning")
    expect(preview?.getAttribute("title")).toBeNull()
    host.remove()
  })

  test("collapsed preview pins the latest tail and updates as the stream grows", () => {
    const running = assistantMessage("a-tail", "u-tail", { time: { created: 2000 } })
    const longText = "prefix " + "mid ".repeat(50) + "the-latest-thinking"
    const [part, setPart] = createStore(reasoningPart("r-tail", "a-tail", longText) as Extract<Part, { type: "reasoning" }>)
    const host = mount(() => <ReasoningBlock part={part} message={running} defaultOpen={false} />)
    const preview = host.querySelector("[data-slot='chat-reasoning-preview']") as HTMLElement
    expect(preview).not.toBeNull()
    expect(preview.textContent).toContain("the-latest-thinking")
    expect(preview.textContent).not.toContain("prefix")

    setPart("text", longText + " even-more-newer")
    expect(preview.textContent).toContain("even-more-newer")
    host.remove()
  })

  test("a manual collapse still wins over the reasoning-summaries default", () => {
    const completed = assistantMessage("a-manual-close", "u-manual-close")
    const part = reasoningPart("r-manual-close", "a-manual-close", "reasoning")
    chatExpansionState.set(part.sessionID, "reasoning", part.id, false)
    const host = mount(() => <ReasoningBlock part={part} message={completed} defaultOpen={true} />)
    const trigger = host.querySelector("[data-slot='chat-reasoning-trigger']") as HTMLElement
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    host.remove()
  })

  test("restores the selected expansion state after a virtual-list remount", () => {
    const completed = assistantMessage("a-remount", "u-remount")
    const part = reasoningPart("r-remount", "a-remount", "persistent thinking")
    chatExpansionState.set(part.sessionID, "reasoning", part.id, true)
    const firstHost = mount(() => <ReasoningBlock part={part} message={completed} />)
    const firstTrigger = firstHost.querySelector("[data-slot='chat-reasoning-trigger']") as HTMLElement
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true")
    firstHost.remove()

    const remountedHost = mount(() => <ReasoningBlock part={part} message={completed} />)
    const remountedTrigger = remountedHost.querySelector("[data-slot='chat-reasoning-trigger']") as HTMLElement
    expect(remountedTrigger.getAttribute("aria-expanded")).toBe("true")
    expect(remountedHost.textContent).toContain("persistent thinking")
    remountedHost.remove()
  })

  test("follows streamed reasoning inside its capped scroll region until the user scrolls away", async () => {
    const running = assistantMessage("a-natural", "u-natural", { time: { created: 2000 } })
    const [part, setPart] = createStore(reasoningPart("r-natural", "a-natural", "line 1") as Extract<Part, { type: "reasoning" }>)
    const host = mount(() => <ReasoningBlock part={part} message={running} />)
    const content = host.querySelector("[data-slot='chat-reasoning-content']") as HTMLDivElement
    expect(content).not.toBeNull()
    let scrollTop = 0
    let scrollHeight = 100
    Object.defineProperties(content, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
    })

    setPart("text", "line 1\nline 2\nline 3")
    // Crossing the max-height threshold may emit a native scroll event before
    // the block has actually moved. That is a layout update, not the user's
    // intent to inspect earlier reasoning, so tail-following must stay on.
    scrollHeight = 400
    content.dispatchEvent(new Event("scroll"))
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(scrollTop).toBe(400)

    scrollTop = 120
    content.dispatchEvent(new Event("scroll"))
    scrollHeight = 600
    setPart("text", "line 1\nline 2\nline 3\nline 4")
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(scrollTop).toBe(120)

    scrollTop = 500
    content.dispatchEvent(new Event("scroll"))
    scrollHeight = 800
    setPart("text", "line 1\nline 2\nline 3\nline 4\nline 5")
    await new Promise((resolve) => window.requestAnimationFrame(resolve))
    expect(scrollTop).toBe(800)
    host.remove()
  })
})

describe("TurnOutcome", () => {
  test("renders an error outcome", () => {
    const a = assistantMessage("a1", "u1", {
      error: { name: "UnknownError", data: { message: "boom" } },
    })
    const host = mount(() => <TurnOutcome message={a} />)
    expect(host.querySelector("[data-component='chat-outcome']")).not.toBeNull()
    expect(host.textContent).toContain("boom")
    host.remove()
  })
})

describe("InteractionBlock", () => {
  test("renders the question result as a styled card with label and answer", () => {
    const a = assistantMessage("a-q", "u1")
    const part = toolPart("t-q", "a-q", "question", "c-q", {
      status: "completed",
      input: { question: "继续吗?" },
      output: 'User has answered your questions: "继续吗?"="继续". You can now continue with the user\'s answers in mind.',
    })
    const host = mount(() => <InteractionBlock part={part} message={a} />)
    expect(host.querySelector("[data-component='chat-interaction']")).not.toBeNull()
    expect(host.querySelector("[data-slot='chat-interaction-header']")).not.toBeNull()
    expect(host.querySelector("[data-slot='chat-interaction-label']")?.textContent).toBe("workbench.chat.question")
    expect(host.querySelector("[data-slot='chat-interaction-answer-label']")?.textContent).toBe("workbench.chat.answer")
    expect(host.querySelector("[data-slot='chat-interaction-answer-text']")?.textContent).toBe("继续")
    host.remove()
  })

  test("shows the question text when present", () => {
    const a = assistantMessage("a-q2", "u1")
    const part = toolPart("t-q2", "a-q2", "question", "c-q2", {
      status: "completed",
      input: { question: "继续吗?" },
      output: "继续",
    })
    const host = mount(() => <InteractionBlock part={part} message={a} />)
    expect(host.querySelector("[data-slot='chat-interaction-question']")?.textContent).toContain("继续吗")
    host.remove()
  })

  test("omits the question slot when the input carries no question", () => {
    const a = assistantMessage("a-q3", "u1")
    const part = toolPart("t-q3", "a-q3", "question", "c-q3", {
      status: "completed",
      input: {},
      output: "好的",
    })
    const host = mount(() => <InteractionBlock part={part} message={a} />)
    expect(host.querySelector("[data-slot='chat-interaction-question']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-interaction-answer-text']")?.textContent).toContain("好的")
    host.remove()
  })
})

describe("ContextToolBlock", () => {
  test("renders a read tool with a path relativized to the session directory", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "read", "c1", {
      input: { filePath: "/repo/src/a.ts" },
      output: "file contents",
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} directory="/repo" />)
    expect(host.querySelector("[data-component='chat-context-tool']")).not.toBeNull()
    expect(host.textContent).toContain("src/a.ts")
    host.remove()
  })

  test("keeps the full absolute path for read files outside the session directory", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "read", "c1", {
      input: { filePath: "/outside/repo/a.ts" },
      output: "file contents",
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} directory="/repo" />)
    expect(host.querySelector("[data-component='chat-context-tool']")).not.toBeNull()
    expect(host.textContent).toContain("/outside/repo/a.ts")
    host.remove()
  })

  test("renders a collapsible context tool with precise trigger button and status outside button", () => {
    const a = assistantMessage("a-precise", "u1")
    const part = toolPart("t-precise", "a-precise", "glob", "c-precise", {
      input: { pattern: "**/*.md" },
      output: "file1.md\nfile2.md",
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} />)
    const row = host.querySelector("[data-slot='chat-tool-header']") as HTMLElement
    expect(row).not.toBeNull()
    expect(row.tagName.toLowerCase()).not.toBe("button")
    const trigger = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.tagName.toLowerCase()).toBe("button")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(trigger.textContent).toContain("glob")
    expect(trigger.textContent).toContain("**/*.md")
    expect(trigger.querySelector("[data-slot='chat-tool-chevron']")).not.toBeNull()
    const status = row.querySelector("[data-slot='chat-tool-status']") as HTMLElement
    expect(status).not.toBeNull()
    expect(trigger.contains(status)).toBe(false)
    host.remove()
  })

  test("renders a grep tool with pattern", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "grep", "c1", { input: { pattern: "foo" } })
    const host = mount(() => <ContextToolBlock part={part} message={a} />)
    expect(host.textContent).toContain("foo")
    host.remove()
  })

  test("renders read as a non-expandable info bar without file content", () => {
    const a = assistantMessage("a-read-bar", "u1")
    const part = toolPart("t-read-bar", "a-read-bar", "read", "c-read-bar", {
      input: { filePath: "/repo/big.md" },
      output: "huge file contents",
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} directory="/repo" />)
    expect(host.querySelector("[data-component='chat-context-tool']")).not.toBeNull()
    expect(host.querySelector("[data-slot='chat-context-info-bar']")).not.toBeNull()
    expect(host.textContent).toContain("big.md")
    expect(host.textContent).not.toContain("huge file contents")
    expect(host.querySelector("[data-slot='chat-tool-header']")).toBeNull()
    expect(host.querySelector("[data-slot='collapsible-trigger']")).toBeNull()
    host.remove()
  })

  test("does not expose a native hover tooltip for a shortened read path", () => {
    const a = assistantMessage("a-read-title", "u1")
    const part = toolPart("t-read-title", "a-read-title", "read", "c-read-title", {
      input: { filePath: "/repo/deep/nested/big.ts" },
      output: "file contents",
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} directory="/repo" />)
    const subtitle = host.querySelector("[data-slot='chat-tool-subtitle']") as HTMLElement
    expect(subtitle).not.toBeNull()
    expect(subtitle.textContent).toBe("deep/nested/big.ts")
    expect(subtitle.getAttribute("title")).toBeNull()
    host.remove()
  })

  test("shows a read path as soon as its streamed raw input closes the filePath string", () => {
    const a = assistantMessage("a-read-stream", "u1", { time: { created: 2000 } })
    const part = toolPart("t-read-stream", "a-read-stream", "read", "c-read-stream", {
      status: "pending",
      input: {},
      raw: '{"filePath":"/repo/src/early.ts","line',
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} directory="/repo" />)
    const subtitle = host.querySelector("[data-slot='chat-tool-subtitle']") as HTMLElement
    expect(subtitle).not.toBeNull()
    expect(subtitle.textContent).toBe("src/early.ts")
    expect(subtitle.getAttribute("title")).toBeNull()
    host.remove()
  })

  test("collapses context tools after completion when the user never toggled them", () => {
    const a = assistantMessage("a-grep-collapse", "u1")
    const part = toolPart("t-grep-collapse", "a-grep-collapse", "grep", "c-grep-collapse", {
      status: "running",
      input: { pattern: "foo" },
    })
    const host1 = mount(() => <ContextToolBlock part={part} message={a} />)
    expect(host1.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")).toBe("true")
    host1.remove()
    const done = toolPart("t-grep-collapse", "a-grep-collapse", "grep", "c-grep-collapse", {
      input: { pattern: "foo" },
      output: "matches",
    })
    const host2 = mount(() => <ContextToolBlock part={done} message={a} />)
    expect(host2.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")).toBe("false")
    host2.remove()
  })

  test("keeps a user toggle for context tools across remounts", () => {
    const a = assistantMessage("a-grep-keep", "u1")
    const part = toolPart("t-grep-keep", "a-grep-keep", "grep", "c-grep-keep", {
      input: { pattern: "foo" },
      output: "matches",
    })
    const host1 = mount(() => <ContextToolBlock part={part} message={a} />)
    const trigger = host1.querySelector("[data-slot='chat-tool-trigger']") as HTMLElement
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    host1.remove()
    const host2 = mount(() => <ContextToolBlock part={part} message={a} />)
    expect(host2.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")).toBe("true")
    host2.remove()
  })

  test("expands a completed context tool when the tool-call-results default is on", () => {
    const a = assistantMessage("a-ctx-default", "u1")
    const part = toolPart("t-ctx-default", "a-ctx-default", "glob", "c-ctx-default", {
      input: { pattern: "**/*.ts" },
      output: "a.ts",
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} defaultOpen={true} />)
    expect(host.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")).toBe("true")
    host.remove()
  })

  test("still collapses a completed context tool when the default is off", () => {
    const a = assistantMessage("a-ctx-closed", "u1")
    const part = toolPart("t-ctx-closed", "a-ctx-closed", "glob", "c-ctx-closed", {
      input: { pattern: "**/*.ts" },
      output: "a.ts",
    })
    const host = mount(() => <ContextToolBlock part={part} message={a} defaultOpen={false} />)
    expect(host.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")).toBe("false")
    host.remove()
  })
})

describe("ShellActivityBlock", () => {
  test("renders command and output", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "bash", "c1", {
      input: { command: "ls -la" },
      output: "total 8",
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} />)
    expect(host.querySelector("[data-component='chat-shell']")).not.toBeNull()
    expect(host.textContent).toContain("ls -la")
    expect(host.textContent).toContain("total 8")
    host.remove()
  })

  test("strips ANSI codes from output", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "bash", "c1", {
      input: { command: "echo hi" },
      output: "\u001b[32mhi\u001b[0m",
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} />)
    expect(host.textContent).toContain("hi")
    expect(host.textContent).not.toContain("\u001b[")
    host.remove()
  })

  test("strips terminal OSC metadata from output", () => {
    const a = assistantMessage("a-shell-osc", "u1")
    const part = toolPart("t-shell-osc", "a-shell-osc", "bash", "c-shell-osc", {
      input: { command: "printf hi" },
      output: "\u001b]633;P;HasRichCommandDetection=True\u0007hi",
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} defaultOpen={true} />)

    expect(host.textContent).toContain("hi")
    expect(host.textContent).not.toContain("HasRichCommandDetection")
    expect(host.textContent).not.toContain("\u001b]")
    host.remove()
  })

  test("uses the model-provided action description in the compact header", () => {
    const a = assistantMessage("a-shell-description", "u1")
    const command = "for d in projects/*; do cat \"$d/package.json\"; done"
    const part = toolPart("t-shell-description", "a-shell-description", "bash", "c-shell-description", {
      input: {
        command,
        description: "Inspect project package files",
      },
      output: "done",
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} defaultOpen={true} />)
    const subtitle = host.querySelector("[data-slot='chat-tool-subtitle']") as HTMLElement

    expect(subtitle.textContent).toBe("Inspect project package files")
    expect(subtitle.textContent).not.toContain("for d in")
    expect(host.querySelector("[data-slot='chat-shell-command-region']")?.textContent).toContain(command)
    expect(host.querySelector("[data-slot='chat-shell-output-region']")?.textContent).toContain("done")
    expect(host.querySelector("[data-action='chat-shell-copy']")?.getAttribute("aria-label")).toContain("复制 Shell")
    host.remove()
  })

  test("respects the shell default-open preference and remains user-toggleable", () => {
    const a = assistantMessage("a-shell-toggle", "u1", { time: { created: 2000 } })
    const part = toolPart("t-shell-toggle", "a-shell-toggle", "bash", "c-shell-toggle", {
      status: "running",
      input: { command: "bun test" },
      metadata: { output: "running" },
      time: { start: 0 },
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} defaultOpen={false} />)
    const header = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement

    expect(header.getAttribute("aria-expanded")).toBe("false")
    header.click()
    expect(header.getAttribute("aria-expanded")).toBe("true")
    header.click()
    expect(header.getAttribute("aria-expanded")).toBe("false")
    host.remove()
  })

  test("expands completed shell output when the preference is enabled", () => {
    const a = assistantMessage("a-shell-default", "u1")
    const part = toolPart("t-shell-default", "a-shell-default", "bash", "c-shell-default", {
      input: { command: "pwd" },
      output: "/repo",
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} defaultOpen={true} />)
    const header = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement

    expect(header.getAttribute("aria-expanded")).toBe("true")
    host.remove()
  })

  test("snapshots the default-open preference so changing settings does not reflow mounted history", async () => {
    const a = assistantMessage("a-shell-preference-snapshot", "u1")
    const part = toolPart("t-shell-preference-snapshot", "a-shell-preference-snapshot", "bash", "c-shell-preference-snapshot", {
      input: { command: "bun test", description: "Run focused tests" },
      output: "pass",
    })
    const [expanded, setExpanded] = createSignal(true)
    const host = mount(() =>
      createComponent(ShellActivityBlock, {
        part,
        message: a,
        get defaultOpen() {
          return expanded()
        },
      }),
    )
    const header = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement

    expect(header.getAttribute("aria-expanded")).toBe("true")
    setExpanded(false)
    await Promise.resolve()
    expect(header.getAttribute("aria-expanded")).toBe("true")
    host.remove()
  })

  test("compensates the transcript scroll position when a tool is toggled", async () => {
    const a = assistantMessage("a-shell-anchor", "u1")
    const part = toolPart("t-shell-anchor", "a-shell-anchor", "bash", "c-shell-anchor", {
      input: { command: "bun test", description: "Run focused tests" },
      output: "pass",
    })
    const host = mount(() => (
      <div data-component="chat-scroller">
        <ShellActivityBlock part={part} message={a} defaultOpen={false} />
      </div>
    ))
    const scroller = host.querySelector("[data-component='chat-scroller']") as HTMLDivElement
    const header = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement
    scroller.scrollTop = 500
    header.getBoundingClientRect = () =>
      ({
        top: header.getAttribute("aria-expanded") === "true" ? 60 : 100,
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    header.click()
    await new Promise((resolve) => window.requestAnimationFrame(resolve))

    expect(header.getAttribute("aria-expanded")).toBe("true")
    expect(scroller.scrollTop).toBe(460)
    host.remove()
  })
})

describe("FileChangeBlock", () => {
  test("renders with the standard ToolBlockHeader and embeds the edit renderer in content", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "edit", "c1", {
      input: { filePath: "/repo/src/b.ts" },
      metadata: { filediff: { file: "/repo/src/b.ts", additions: 1, deletions: 1 } },
    })
    const host = mount(() => (
      <FileChangeBlock part={part} message={a} directory="/repo" editRenderer={OpenCodeMessagePartStub} />
    ))
    // Outer component uses standard ToolBlockHeader
    const trigger = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.querySelector("[data-slot='chat-tool-title']")?.textContent).toBe("edit")
    expect(trigger.querySelector("[data-slot='chat-tool-subtitle']")?.textContent).toBe("src/b.ts")
    expect(trigger.querySelector("[data-slot='chat-tool-subtitle']")?.getAttribute("title")).toBeNull()
    expect(host.querySelector("[data-component='chat-file-change-wrapper']")).not.toBeNull()
    expect(host.querySelector("[data-renderer='opencode-message-part']")).not.toBeNull()
    host.remove()
  })

  test("respects the edit default-open preference", () => {
    const a = assistantMessage("a-edit-default", "u1")
    const part = toolPart("t-edit-default", "a-edit-default", "edit", "c-edit-default", {
      input: { filePath: "/repo/b.ts" },
    })
    const host = mount(() => (
      <FileChangeBlock part={part} message={a} defaultOpen={true} editRenderer={OpenCodeMessagePartStub} />
    ))
    const trigger = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement

    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(host.querySelector("[data-renderer='opencode-message-part']")?.getAttribute("data-defer-tool-content")).toBe(
      "false",
    )
    expect(host.querySelector("[data-renderer='opencode-message-part']")?.getAttribute("data-virtualize-diff")).toBe(
      "false",
    )
    host.remove()
  })

  test("routes write and apply_patch through the original OpenCode renderer with unified header", () => {
    const a = assistantMessage("a-file-routing", "u1")
    const write = toolPart("t-write-route", "a-file-routing", "write", "c-write-route", {
      input: { filePath: "/repo/new.ts", content: "x" },
    })
    const patch = toolPart("t-patch-route", "a-file-routing", "apply_patch", "c-patch-route", {
      input: { patch: "@@ -1 +1 @@" },
    })
    const host = mount(() => (
      <div>
        <FileChangeBlock part={write} message={a} directory="/repo" editRenderer={OpenCodeMessagePartStub} />
        <FileChangeBlock part={patch} message={a} directory="/repo" editRenderer={OpenCodeMessagePartStub} />
      </div>
    ))
    const triggers = host.querySelectorAll("[data-slot='chat-tool-trigger']")
    expect(triggers.length).toBe(2)
    expect(triggers[0].querySelector("[data-slot='chat-tool-title']")?.textContent).toBe("write")
    expect(triggers[0].querySelector("[data-slot='chat-tool-subtitle']")?.textContent).toBe("new.ts")
    expect(triggers[1].querySelector("[data-slot='chat-tool-title']")?.textContent).toBe("patch")
    expect(host.querySelectorAll("[data-renderer='opencode-message-part']").length).toBe(2)
    expect(host.querySelectorAll("[data-component='chat-file-change-wrapper']").length).toBe(2)
    host.remove()
  })

  test("respects the edit default-open preference for write and apply_patch", () => {
    const a = assistantMessage("a-write-default2", "u1")
    const part = toolPart("t-write-default2", "a-write-default2", "write", "c-write-default2", {
      input: { filePath: "/repo/new.ts" },
    })
    const host = mount(() => (
      <FileChangeBlock part={part} message={a} defaultOpen={true} editRenderer={OpenCodeMessagePartStub} />
    ))
    const trigger = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLButtonElement

    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    host.remove()
  })
})

describe("SubagentActivityBlock", () => {
  test("renders task description and session id", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "task", "c1", {
      input: { description: "refactor module" },
      metadata: { sessionId: "child_1" },
    })
    const host = mount(() => <SubagentActivityBlock part={part} message={a} />)
    expect(host.querySelector("[data-component='chat-subagent']")).not.toBeNull()
    expect(host.textContent).toContain("refactor module")
    host.remove()
  })

  test("uses the agent name as title and the description as subtitle", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "task", "c1", {
      input: { subagent_type: "fae", description: "refactor module" },
      metadata: { sessionId: "child_1" },
    })
    const host = mount(() => <SubagentActivityBlock part={part} message={a} />)
    const title = host.querySelector("[data-slot='chat-tool-title']") as HTMLElement
    expect(title?.textContent).toContain("Fae")
    expect(title?.style.color).toContain("var(--")
    const subtitle = host.querySelector("[data-slot='chat-tool-subtitle']")
    expect(subtitle?.textContent).toContain("refactor module")
    host.remove()
  })

  test("reads the agent field of wopal_task delegation inputs", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "wopal_task", "c1", {
      input: { agent: "rook", description: "review the diff" },
      metadata: { sessionId: "wopal-task-x1" },
    })
    const host = mount(() => <SubagentActivityBlock part={part} message={a} />)
    const title = host.querySelector("[data-slot='chat-tool-title']") as HTMLElement
    expect(title?.textContent).toContain("Rook")
    const subtitle = host.querySelector("[data-slot='chat-tool-subtitle']")
    expect(subtitle?.textContent).toContain("review the diff")
    host.remove()
  })
})

describe("GenericToolBlock", () => {
  test("renders unknown tools with a generic fallback", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "some_mcp_tool", "c1", { input: { query: "x" } })
    const host = mount(() => <GenericToolBlock part={part} message={a} />)
    expect(host.querySelector("[data-component='chat-generic-tool']")).not.toBeNull()
    expect(host.textContent).toContain("some_mcp_tool")
    host.remove()
  })

  test("extracts a primary label from the input fields", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "memory_manage", "c1", {
      input: { command: "search", query: "dev-flow", limit: 5 },
    })
    const host = mount(() => <GenericToolBlock part={part} message={a} />)
    const subtitle = host.querySelector("[data-slot='chat-tool-subtitle']")
    expect(subtitle).not.toBeNull()
    expect(subtitle?.textContent).toBe("search")
    host.remove()
  })

  test("renders the remaining generic tool params as capped arg chips, not a concatenated blob", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "memory_manage", "c1", {
      input: { command: "search", category: "experience", limit: 5, verbose: true },
    })
    const host = mount(() => <GenericToolBlock part={part} message={a} />)
    const args = Array.from(host.querySelectorAll("[data-slot='chat-tool-arg']")).map((el) => el.textContent)
    expect(args).toContain("category=experience")
    expect(args).toContain("limit=5")
    expect(args).toContain("verbose=true")
    // The primary label stays separate and never swallows the params.
    expect(host.querySelector("[data-slot='chat-tool-subtitle']")?.textContent).toBe("search")
    host.remove()
  })

  test("does not attach native hover tooltips to generic tool labels or arguments", () => {
    const a = assistantMessage("a-generic-no-tooltip", "u1")
    const part = toolPart("t-generic-no-tooltip", "a-generic-no-tooltip", "memory_manage", "c-generic-no-tooltip", {
      input: { command: "search", category: "experience", limit: 5 },
    })
    const host = mount(() => <GenericToolBlock part={part} message={a} />)

    expect(host.querySelector("[data-slot='chat-tool-subtitle']")?.getAttribute("title")).toBeNull()
    expect(host.querySelectorAll("[data-slot='chat-tool-arg'][title]")).toHaveLength(0)
    host.remove()
  })

  test("caps generic tool arg chips to a bounded count for long inputs", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "some_mcp_tool", "c1", {
      input: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" },
    })
    const host = mount(() => <GenericToolBlock part={part} message={a} />)
    const args = host.querySelectorAll("[data-slot='chat-tool-arg']")
    expect(args.length).toBeLessThanOrEqual(3)
    host.remove()
  })

  test("shows structured arg chips when no descriptive field exists", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "some_mcp_tool", "c1", {
      input: { limit: 5, verbose: true },
    })
    const host = mount(() => <GenericToolBlock part={part} message={a} />)
    expect(host.querySelector("[data-slot='chat-tool-subtitle']")).toBeNull()
    const args = Array.from(host.querySelectorAll("[data-slot='chat-tool-arg']")).map((el) => el.textContent)
    expect(args).toContain("limit=5")
    expect(args).toContain("verbose=true")
    host.remove()
  })

  test("expands a completed generic tool when the tool-call-results default is on", () => {
    const a = assistantMessage("a-gen-default", "u1")
    const part = toolPart("t-gen-default", "a-gen-default", "some_mcp_tool", "c-gen-default", {
      input: { query: "x" },
      output: "done",
    })
    const host = mount(() => <GenericToolBlock part={part} message={a} defaultOpen={true} />)
    expect(host.querySelector("[data-slot='chat-tool-trigger']")?.getAttribute("aria-expanded")).toBe("true")
    host.remove()
  })
})

describe("ShellActivityBlock real-time and error", () => {
  test("reads metadata.output while running", () => {
    const a = assistantMessage("a1", "u1", { time: { created: 2000 } }) // running
    const part = toolPart("t1", "a1", "bash", "c1", {
      status: "running",
      input: { command: "npm test" },
      metadata: { output: "streaming output" },
      time: { start: 0 },
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} />)
    expect(host.textContent).toContain("streaming output")
    host.remove()
  })

  test("renders state.error on error", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "bash", "c1", {
      status: "error",
      input: { command: "ls" },
      error: "command not found",
      time: { start: 0, end: 1 },
    })
    const host = mount(() => <ShellActivityBlock part={part} message={a} />)
    expect(host.textContent).toContain("command not found")
    host.remove()
  })
})

describe("FileChangeBlock diff", () => {
  test("uses the original OpenCode edit-content and file diff structure", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "edit", "c1", {
      input: { filePath: "/repo/b.ts" },
      metadata: {
        filediff: {
          file: "/repo/b.ts",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old line\n+new line",
        },
      },
    })
    const host = mount(() => <FileChangeBlock part={part} message={a} editRenderer={OpenCodeMessagePartStub} />)
    expect(host.querySelector("[data-component='edit-content'] [data-component='file'][data-mode='diff']")).not.toBeNull()
    expect(host.querySelector("[data-component='chat-file-diff']")).toBeNull()
    expect(host.querySelector("[data-slot='chat-file-diff-patch']")).toBeNull()
    host.remove()
  })
})

describe("SubagentActivityBlock sync", () => {
  test("calls sync.session.sync with the child session id when expanded", () => {
    const a = assistantMessage("a1", "u1")
    const part = toolPart("t1", "a1", "task", "c1", {
      input: { description: "refactor" },
      metadata: { sessionId: "child_1" },
    })
    chatExpansionState.set(part.sessionID, part.tool, part.callID, false)
    let synced: string | undefined
    const host = mount(() => (
      <SubagentActivityBlock
        part={part}
        message={a}
        onSyncChild={(childID) => {
          synced = childID
        }}
      />
    ))
    expect(host.querySelector("[data-component='chat-subagent']")).not.toBeNull()
    expect(host.textContent).toContain("child_1")
    const trigger = host.querySelector("[data-slot='chat-tool-trigger']") as HTMLElement
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(synced).toBe("child_1")
    host.remove()
  })
})
