import { createMemo, createEffect, createSignal, onCleanup, Show, batch, on } from "solid-js"
import type { JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"

import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useMutation } from "@tanstack/solid-query"
import { createAutoScroll } from "@wopal/ui/hooks"
import { Part as OpenCodeMessagePart } from "@wopal/ui/message-part"
import { DataProvider } from "@wopal/ui/context"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { PromptProvider, usePrompt } from "@/context/prompt"
import { FileProvider } from "@/context/file"
import { TerminalProvider } from "@/context/terminal"
import { CommentsProvider, useComments } from "@/context/comments"
import { LocalProvider, useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { showToast } from "@wopal/ui/toast"
import { formatServerError } from "@/utils/server-errors"
import { extractPromptFromParts } from "@/utils/prompt"
import { findLast } from "@wopal/ellamaka-core/util/array"
import { isCompactionMarker } from "@/pages/session/chat-transcript"
import {
  WorkbenchChatTimeline,
  type LatestScrollNavigator,
  type UserMessageNavigation,
  type UserMessageNavigator,
} from "@/pages/session/workbench-chat-timeline"
import { createSessionComposerState } from "@/pages/session/composer"
import { useSessionHistoryLoader } from "@/hooks/use-session-history-loader"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { same } from "@/utils/same"
import { PanelChatComposer } from "./panel-chat-composer"
import { EmbeddedSessionSurfaceProvider } from "@/pages/session/session-surface-context"
import type { WorkbenchPanel } from "../view-store"
import { useWorkbenchState } from "../view-store"
import { useLocalPanelActions } from "@/pages/session/use-local-panel-actions"
import type { Session } from "../session-store"
import { useWorkbenchActions } from "../workbench-actions"
import { scopeFromTab } from "../workbench-scope"
import { panelChatRoute } from "./panel-chat-route"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { Identifier } from "@/utils/id"
import { nextFollowupToSend } from "./panel-chat-followup"
import { useWorkbenchPromptRegistry } from "../workbench-prompt-registry"
import { chatTranscriptNavigation } from "./panel-chat-resume-scroll"
import {
  initialChatFollowState,
  shouldKeepChatAtLatest,
  shouldRestoreChatFollowAfterCompletion,
  transitionChatFollowState,
} from "./panel-chat-follow-state"

import { reportWorkbenchError } from "../workbench-error"

const emptyUserMessages: UserMessage[] = []
const emptyParts: Part[] = []
type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

function PanelChatInner(props: {
  panel: WorkbenchPanel
  session: Session
  directory: string
  spacePath: string
  spaceName: string
  onPromptReady?: (editor: HTMLDivElement) => void
  canRestorePromptFocus?: () => boolean
}) {
  const sync = useSync()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const prompt = usePrompt()
  const comments = useComments()
  const promptRegistry = useWorkbenchPromptRegistry()
  const language = useLanguage()
  const settings = useSettings()
  const actions = useWorkbenchActions()
  const wb = useWorkbenchState()
  const local = useLocal()
  const providers = useProviders()
  const modelName = (providerID: string, modelID: string) =>
    providers.all().get(providerID)?.models[modelID]?.name
  const scope = createMemo(() => scopeFromTab({ name: props.spaceName, path: props.spacePath }))

  // Expose this Panel's prompt/comments to the workbench-wide registry so the
  // floating file viewer can submit line comments into the active Panel's
  // prompt context. Registration must run on mount (no defer) — panel ids are
  // stable, so a deferred `on` would never fire and the registry stays empty.
  createEffect(
    on(
      () => props.panel.id,
      (panelID) => {
        if (!panelID) return
        promptRegistry.registerPrompt(panelID, prompt)
        promptRegistry.registerComments(panelID, comments)
        onCleanup(() => {
          promptRegistry.unregisterPrompt(panelID)
          promptRegistry.unregisterComments(panelID)
        })
      },
    ),
  )
  createEffect(() => {
    const state = wb.spaceState(props.spacePath)
    const isActive = state?.activePanelID === props.panel.id
    if (!isActive) return
    promptRegistry.setActivePanel(props.panel.id)
  })

  const panels = () => wb.spaceState(props.spacePath)?.panels ?? []
  const canSplit = createMemo(() => {
    const list = panels()
    return list.length < 3 || list.some((p) => p.slotState === "empty")
  })

  const composer = createSessionComposerState()
  const sessionWorking = createMemo(() => sync.data.session_working(props.session.id))
  const [followState, setFollowState] = createSignal(initialChatFollowState)
  const autoScroll = createAutoScroll({
    working: sessionWorking,
    overflowAnchor: "dynamic",
    onUserInteracted: () => setFollowState((current) => transitionChatFollowState(current, "pause")),
  })
  let navigateUserMessage: UserMessageNavigator | undefined
  let navigateLatest: LatestScrollNavigator | undefined

  // Followups are transient Panel UI state. The server owns delivered
  // messages; drafts must not be persisted as a second domain copy.
  const [followup, setFollowup] = createStore<{
    items: Record<string, FollowupItem[] | undefined>
    failed: Record<string, string | undefined>
    paused: Record<string, boolean | undefined>
    edit: Record<string, FollowupEdit | undefined>
  }>({
    items: {},
    failed: {},
    paused: {},
    edit: {},
  })

  const queuedFollowups = createMemo(() => followup.items[props.session.id] ?? emptyFollowups)
  const editingFollowup = createMemo(() => followup.edit[props.session.id])

  useLocalPanelActions({
    sessionID: () => props.session.id,
    navigateMessageByOffset: (offset) => {
      const direction: UserMessageNavigation | undefined = offset < 0 ? "previous" : offset > 0 ? "next" : undefined
      if (direction) navigateUserMessage?.(direction)
    },
    setActiveMessage: (_message) => {
      // Stub
    },
    focusInput: () => inputRef?.focus(),
    registerAction: (id, execute, disabled) =>
      actions.registerPanelAction(scope(), props.panel.id, {
        id,
        execute,
        disabled: typeof disabled === "function" ? disabled : disabled !== undefined ? () => disabled : undefined,
      }),
    unregisterAction: (id) => actions.unregisterPanelAction(scope(), props.panel.id, id),
    onForked: (newSessionID) => {
      void actions.bindForkedSession({
        scope: scope(),
        sourcePanelID: props.panel.id,
        sessionID: newSessionID,
      }).catch((error) => reportWorkbenchError("bind forked session", error))
    },
  })

  const [ui, setUi] = createStore({
    scroll: { overflow: false, bottom: true, jump: false },
  })

  let scroller: HTMLDivElement | undefined
  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let completionFollowFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)
    const resumedAtBottom = bottom && !ui.scroll.bottom && followState() === "paused"
    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) {
      if (resumedAtBottom) setFollowState((current) => transitionChatFollowState(current, "resume"))
      return
    }
    setUi("scroll", { overflow, bottom, jump })
    if (resumedAtBottom) setFollowState((current) => transitionChatFollowState(current, "resume"))
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return
    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined
      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return
      updateScrollState(target)
    })
  }

  const pauseFollowLatest = () => {
    setFollowState((current) => transitionChatFollowState(current, "pause"))
    autoScroll.pause()
  }

  const resumeScroll = () => {
    setFollowState((current) => transitionChatFollowState(current, "resume"))
    autoScroll.forceScrollToBottom()
    navigateLatest?.()
    const el = scroller
    if (el) scheduleScrollState(el)
  }

  const lockFollowingLatest = () => {
    if (!shouldKeepChatAtLatest(followState())) return
    autoScroll.forceScrollToBottom()
    navigateLatest?.()
    if (scroller) scheduleScrollState(scroller)
  }

  createEffect(
    on(sessionWorking, (working, previousWorking) => {
      if (!shouldRestoreChatFollowAfterCompletion({ previousWorking, working, state: followState() })) return
      lockFollowingLatest()
      if (completionFollowFrame !== undefined) cancelAnimationFrame(completionFollowFrame)
      completionFollowFrame = requestAnimationFrame(() => {
        completionFollowFrame = requestAnimationFrame(() => {
          completionFollowFrame = undefined
          // The last live turn is mounted into Virtua after Idle. Reassert the
          // user's explicit follow intent after Virtua has measured that move.
          lockFollowingLatest()
        })
      })
    }),
  )

  createEffect(() => {
    if (typeof window === "undefined") return
    const onKeyDown = (event: KeyboardEvent) => {
      // The handler belongs only to the active Workbench chat panel. Editing,
      // selection and shortcut variants keep browser-native behavior.
      if (!props.canRestorePromptFocus?.()) return
      const navigation = chatTranscriptNavigation(event)
      if (!navigation) return

      if (navigation === "latest") {
        event.preventDefault()
        resumeScroll()
        return
      }

      if (!navigateUserMessage?.(navigation)) return
      event.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
  }

  const setContentRef = (el: HTMLDivElement) => {
    autoScroll.contentRef(el)
    const root = scroller
    if (root) scheduleScrollState(root)
  }

  onCleanup(() => {
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (completionFollowFrame !== undefined) cancelAnimationFrame(completionFollowFrame)
  })

  let inputRef: HTMLDivElement | undefined

  const messages = createMemo(() => sync.data.message[props.session.id] ?? [])
  const messagesReady = createMemo(() => sync.data.message[props.session.id] !== undefined)

  const info = createMemo(() => sync.data.session.find((item) => item.id === props.session.id))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const revertMessageID = createMemo(() => info()?.revert?.messageID)

  const isUser = (m: Message): m is UserMessage => m.role === "user"
  const realUserMessages = createMemo(
    () =>
      messages().flatMap((m) => {
        if (!isUser(m)) return []
        if (isCompactionMarker(m, (id) => sync.data.part[id] ?? emptyParts)) return []
        return [m]
      }),
    emptyUserMessages,
    { equals: same },
  )

  const userMessages = realUserMessages

  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const lastUserMessage = createMemo(() => findLast(visibleUserMessages(), (m) => m.role === "user"))

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  const historyMore = () => sync.session.history.more(props.session.id)
  const historyLoading = () => sync.session.history.loading(props.session.id)

  const historyLoader = useSessionHistoryLoader({
    sessionID: () => props.session.id,
    loaded: () => messages().length,
    visibleUserMessages: visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID: string) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: props.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const busy = (sessionID: string) => sync.data.session_working(sessionID)
  const halt = (sessionID: string) =>
    busy(sessionID) ? sdk.client.session.abort({ sessionID }).catch((e) => reportWorkbenchError("abort", e, { silent: true })) : Promise.resolve()

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        client: sdk.client,
        sync,
        serverSync,
        draft: item,
        optimisticBusy: item.sessionDirectory === props.directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) resumeScroll()
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    if (!followupBusy(props.session.id)) return undefined
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    return busy(props.session.id) && !composer.blocked() && !isChildSession()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    if (sync.session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    // "Send now" must interrupt the running turn first: the backend
    // ensureRunning discards a prompt submitted while the runner is busy, so
    // aborting moves the runner to Idle before the prompt reaches it.
    if (opts?.manual && busy(sessionID)) {
      return halt(sessionID).then(() => followupMutation.mutateAsync({ sessionID, id, manual: opts.manual }))
    }

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const withdrawFollowup = (id: string) => {
    if (followupBusy(props.session.id)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    batch(() => {
      setFollowup("items", props.session.id, (items) => (items ?? []).filter((entry) => entry.id !== id))
      setFollowup("failed", props.session.id, (value) => (value === id ? undefined : value))
      setFollowup("edit", props.session.id, {
        id: item.id,
        prompt: item.prompt,
        context: item.context,
      })
    })
  }

  const clearFollowupEdit = () => {
    setFollowup("edit", props.session.id, undefined)
  }

  createEffect(() => {
    const sessionID = props.session.id
    if (!sessionID) return

    const item = nextFollowupToSend(queuedFollowups(), {
      busy: busy(sessionID),
      sending: followupBusy(sessionID),
      failedID: followup.failed[sessionID],
      paused: !!followup.paused[sessionID],
      child: isChildSession(),
      blocked: composer.blocked(),
    })
    if (!item) return

    void sendFollowup(sessionID, item.id)
  })

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const prev = prompt.current().slice()
      const last = info()?.revert
      const value = draft(input.messageID)
      batch(() => {
        roll(input.sessionID, { messageID: input.messageID })
        prompt.set(value)
      })
      await halt(input.sessionID)
        .then(() => sdk.client.session.revert(input))
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(input.sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = props.session.id
      if (!sessionID) return

      const next = userMessages().find((item) => item.id > id)
      const prev = prompt.current().slice()
      const last = info()?.revert

      batch(() => {
        roll(sessionID, next ? { messageID: next.id } : undefined)
        if (next) {
          prompt.set(draft(next.id))
          return
        }
        prompt.reset()
      })

      const task = !next
        ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
        : halt(sessionID).then(() =>
            sdk.client.session.revert({
              sessionID,
              messageID: next.id,
            }),
          )

      await task
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return undefined
    return revertMutation.mutateAsync(input)
  }

  const forkMessage = async (input: { sessionID: string; messageID: string; target: "current" | "split" }) => {
    try {
      const res = await sdk.client.session.fork({
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      if (!res.data) return
      const targetDirectory = res.data.directory || props.panel.directory
      if (input.target === "current") {
        await actions.loadSessionIntoPanel({
          scope: scope(),
          panelID: props.panel.id,
          sessionID: res.data.id,
          directory: targetDirectory,
        })
      } else {
        await actions.bindForkedSession({
          scope: scope(),
          sourcePanelID: props.panel.id,
          sessionID: res.data.id,
          directory: targetDirectory,
        })
      }
      void sync.session.sync(res.data.id, { force: true })
    } catch (error) {
      reportWorkbenchError("fork session from message action", error)
    }
  }

  const restore = (id: string) => {
    if (!props.session.id || reverting()) return undefined
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  return (
    <div data-component="workbench-chat" class="flex flex-col h-full min-h-0 bg-v2-background-bg-deep">
      <div class="flex-1 min-h-0 overflow-hidden">
        <Show when={messagesReady()}>
          <WorkbenchChatTimeline
            sessionID={props.session.id}
            userMessages={historyLoader.userMessages()}
            historyShift={historyLoader.shift()}
            historyMore={historyMore()}
            historyLoading={historyLoading()}
            loadOlder={historyLoader.loadAndReveal}
            scroll={ui.scroll}
            directory={props.directory}
            showReasoningSummaries={settings.general.showReasoningSummaries()}
            shellToolPartsExpanded={settings.general.shellToolPartsExpanded()}
            editToolPartsExpanded={settings.general.editToolPartsExpanded()}
            showSessionProgressBar={settings.general.showSessionProgressBar()}
            editRenderer={OpenCodeMessagePart}
            revert={revertMessageID()}
            onUserMessageNavigator={(navigator) => {
              navigateUserMessage = navigator
            }}
            onLatestScrollNavigator={(navigator) => {
              navigateLatest = navigator
            }}
            setScrollRef={setScrollRef}
            setContentRef={setContentRef}
            onAutoScroll={autoScroll.handleScroll}
            onScheduleScrollState={scheduleScrollState}
            onUserScroll={pauseFollowLatest}
            onHistoryScroll={historyLoader.onScrollerScroll}
            onAutoScrollInteraction={autoScroll.handleInteraction}
            onResumeScroll={resumeScroll}
            onPauseAutoScroll={pauseFollowLatest}
            actions={{ revert, fork: forkMessage, canSplit: canSplit() }}
            actionLabels={{
              fork: language.t("ui.message.forkMessage"),
              forkCurrent: language.t("ui.message.forkCurrent"),
              forkSplit: language.t("ui.message.forkSplit"),
              revert: language.t("ui.message.revertMessage"),
              copy: language.t("ui.message.copyMessage"),
              copied: language.t("ui.message.copied"),
            }}
            modelName={modelName}
          />
        </Show>
      </div>
      <PanelChatComposer
        state={composer}
        ready={messagesReady()}
        directory={props.directory}
        canRestorePromptFocus={props.canRestorePromptFocus}
        inputRef={(el) => {
          inputRef = el
          props.onPromptReady?.(el)
        }}
        setPromptDockRef={() => {}}
        onSubmit={resumeScroll}
        onResponseSubmit={resumeScroll}
        followup={{
          queue: queueEnabled,
          items: followupDock(),
          sending: sendingFollowup(),
          edit: editingFollowup(),
          onQueue: queueFollowup,
          onAbort: () => {
            setFollowup("paused", props.session.id, true)
          },
          onSend: (id) => {
            void sendFollowup(props.session.id, id, { manual: true })
          },
          onWithdraw: withdrawFollowup,
          onEditLoaded: clearFollowupEdit,
        }}
        revert={{
          items: rolled(),
          restoring: restoring(),
          disabled: reverting(),
          onRestore: restore,
        }}
      />
    </div>
  )
}

function PanelChatRoute(props: {
  panel: WorkbenchPanel
  session: Session
  directory: string
  spacePath: string
  spaceName: string
  onPromptReady?: (editor: HTMLDivElement) => void
  canRestorePromptFocus?: () => boolean
}) {
  return (
    <PanelChatDataProvider session={props.session} directory={props.directory}>
      <TerminalProvider>
        <FileProvider>
          <PromptProvider>
            <CommentsProvider>
              <EmbeddedSessionSurfaceProvider>
                <PanelChatInner
                  panel={props.panel}
                  session={props.session}
                  directory={props.directory}
                  spacePath={props.spacePath}
                  spaceName={props.spaceName}
                  onPromptReady={props.onPromptReady}
                  canRestorePromptFocus={props.canRestorePromptFocus}
                />
              </EmbeddedSessionSurfaceProvider>
            </CommentsProvider>
          </PromptProvider>
        </FileProvider>
      </TerminalProvider>
    </PanelChatDataProvider>
  )
}

export function PanelChat(props: {
  panel: WorkbenchPanel
  session: Session
  directory: string
  spacePath: string
  spaceName: string
  onPromptReady?: (editor: HTMLDivElement) => void
  canRestorePromptFocus?: () => boolean
}) {
  const route = createMemo(() => panelChatRoute(props.directory, props.session.id))

  return (
    <Show when={route()} keyed>
      {(current) => {
        const history = createMemoryHistory()
        history.set({ value: current.path, replace: true })
        return (
          <MemoryRouter history={history}>
            <Route
              path="/:dir/session/:id"
              component={() => (
                <PanelChatRoute
                  panel={props.panel}
                  session={props.session}
                  directory={props.directory}
                  spacePath={props.spacePath}
                  spaceName={props.spaceName}
                  onPromptReady={props.onPromptReady}
                  canRestorePromptFocus={props.canRestorePromptFocus}
                />
              )}
            />
          </MemoryRouter>
        )
      }}
    </Show>
  )
}

function PanelChatDataProvider(props: { session: Session; directory: string; children: JSX.Element }) {
  const sync = useSync()

  // createResource only fires its fetcher when the returned signal is read.
  // PanelChatInner reads sync.data.message[id], but nothing consumed the
  // resource, so sync.session.sync(id) never ran and messages never loaded.
  // Drive the load explicitly via createEffect keyed on the session id.
  createEffect(() => {
    const id = props.session.id
    if (!id) return
    void sync.session.sync(id)
  })

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={() => {}}
      onSessionHref={() => ""}
    >
      <LocalProvider sessionID={props.session.id}>{props.children}</LocalProvider>
    </DataProvider>
  )
}
