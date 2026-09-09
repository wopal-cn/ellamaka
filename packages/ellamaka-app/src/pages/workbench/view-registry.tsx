import { type JSX, createSignal, createEffect, onCleanup, Show } from "solid-js"
import { MemoryRouter, createMemoryHistory, Route } from "@solidjs/router"
import { createSimpleContext } from "@wopal/ui/context"
import { Icon as IconV2 } from "@wopal/ui/v2/components/icon.jsx"
import { Terminal } from "@/components/terminal"
import { SessionContextTab } from "@/components/session"
import { PanelChat } from "./parts/panel-chat"
import { type WorkbenchPanel } from "./view-store"
import type { Session } from "./session-store"
import { useWorkbenchActions } from "./workbench-actions"
import { scopeFromTab } from "./workbench-scope"
import { reportWorkbenchError } from "./workbench-error"
import { useServer } from "@/context/server"
import { createTuiAttachRequest, resolveTuiAttachAuth } from "./tui-attach"

// Task 3 (O18): ViewId enum constants replace string literals "tui"/"chat"/"context".
export const ViewId = {
  TUI: "tui",
  CHAT: "chat",
  CONTEXT: "context",
} as const

export type ViewId = (typeof ViewId)[keyof typeof ViewId]

interface WorkbenchViewSdk {
  url: string
  client: {
    pty: {
      create(params: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string> }): Promise<{ data?: { id: string } }>
    }
  }
}

export type PanelViewCtx = {
  panel: WorkbenchPanel
  session?: Session
  directory: string
  sdk: WorkbenchViewSdk
  spaceName: string
  spacePath: string
  onPromptReady?: (editor: HTMLDivElement) => void
  canRestorePromptFocus?: () => boolean
}

export type PanelViewDef = {
  id: string
  label: string
  icon?: string
  requiresSession: boolean
  showContext: boolean
  render: (ctx: PanelViewCtx) => JSX.Element
}

// Task 3 (O18): Factory replaces module-level global viewRegistry array.
// Each WorkbenchShell creates its own registry and registers default views
// during initialization, eliminating import-order sensitivity.
export function createViewRegistry() {
  const views: PanelViewDef[] = []
  return {
    register(def: PanelViewDef) {
      const idx = views.findIndex((v) => v.id === def.id)
      if (idx !== -1) {
        views[idx] = def
      } else {
        views.push(def)
      }
    },
    get(id: string): PanelViewDef | undefined { return views.find((v) => v.id === id) },
    all(): PanelViewDef[] { return views },
  }
}

export type ViewRegistry = ReturnType<typeof createViewRegistry>

// Module-level reference set by ViewRegistryProvider. getView/listViews
// read from this so they remain non-hook functions callable from reactive
// contexts (createEffect, JSX expressions, etc.).
let _currentRegistry: ViewRegistry | undefined

const ViewRegistryContext = createSimpleContext({
  name: "ViewRegistry",
  init: () => {
    const registry = createViewRegistry()
    registerDefaultViews(registry)
    _currentRegistry = registry
    return registry
  },
})

export const useViewRegistry = () => ViewRegistryContext.use()
export const ViewRegistryProvider = ViewRegistryContext.provider

export function getView(id: string): PanelViewDef | undefined {
  return _currentRegistry?.get(id)
}

export function listViews(): PanelViewDef[] {
  return _currentRegistry?.all() ?? []
}

// Task 3 (O18): Default views registered during Shell init instead of at
// module level. Call `registerDefaultViews(registry)` once during
// WorkbenchShell initialization.
export function registerDefaultViews(registry: ViewRegistry) {
  // ── TUI View ──────────────────────────────────────────────
  registry.register({
    id: ViewId.TUI,
    label: "TUI",
    requiresSession: true,
    showContext: false,
    render: (ctx) => {
      const actions = useWorkbenchActions()
      const server = useServer()
      const [ptyId, setPtyId] = createSignal<string | undefined>(undefined)
      const [ptyError, setPtyError] = createSignal<string | undefined>(undefined)
      let disposed = false
      onCleanup(() => {
        disposed = true
      })

      createEffect(() => {
        if (ctx.panel.slotState !== "bound") return

        // Maintain local ptyId signal synchronized with store tuiPtyId regardless of viewMode.
        // This keeps the <Terminal> component mounted in hidden DOM state (display: none) when
        // the user switches to chat, holding the WebSocket alive and preventing PTY grace reaper eviction.
        if (ctx.panel.tuiPtyId) {
          if (ptyId() !== ctx.panel.tuiPtyId) setPtyId(ctx.panel.tuiPtyId)
          return
        }
        if (!ctx.panel.tuiPtyId && ptyId()) {
          setPtyId(undefined)
        }

        if (ctx.panel.viewMode !== "tui") return

        const sessionId = ctx.session?.id
        const auth = resolveTuiAttachAuth(server.current)

        void actions.ensurePanelPty({
          scope: scopeFromTab({ name: ctx.spaceName, path: ctx.spacePath }),
          panelID: ctx.panel.id,
          kind: "tui",
          create: async () => {
            const res = await ctx.sdk.client.pty.create(
              createTuiAttachRequest({
                serverUrl: ctx.sdk.url,
                sessionID: sessionId,
                directory: ctx.directory,
                panelID: ctx.panel.id,
                auth,
              }),
            )
            if (!res.data?.id) throw new Error("No PTY ID returned")
            return res.data.id
          },
        }).then((result) => {
          if (disposed) return
          if (result.ptyID) setPtyId(result.ptyID)
        }).catch((e) => {
          reportWorkbenchError("ensure tui pty", e)
          setPtyError("Failed to start TUI terminal")
          actions.fallbackToChat({
            scope: scopeFromTab({ name: ctx.spaceName, path: ctx.spacePath }),
            panelID: ctx.panel.id,
          })
        })
      })

      return (
        <Show
          when={ptyId()}
          keyed
          fallback={
            <Show
              when={ptyError()}
              fallback={
                <div class="flex flex-col items-center justify-center h-full text-v2-text-text-muted gap-2">
                  <div class="workbench-spinner rounded-full h-4 w-4 border-2 border-v2-text-text-muted border-t-transparent" />
                  <span class="text-11-regular">Starting TUI...</span>
                </div>
              }
            >
              {(error) => (
                <div class="flex flex-col items-center justify-center h-full text-v2-text-text-muted gap-2">
                  <span class="text-11-regular text-red-500">{error()}</span>
                </div>
              )}
            </Show>
          }
        >
          {(id) => (
            <Terminal
              pty={{ id, title: "ellamaka tui", titleNumber: 1 }}
              class="w-full h-full"
              noPadding={true}
              isTui={true}
              onConnectError={() => {
                void actions.recoverPanelPty({
                  scope: scopeFromTab({ name: ctx.spaceName, path: ctx.spacePath }),
                  panelID: ctx.panel.id,
                  kind: "tui",
                  ptyID: id,
                }).then((result) => {
                  if (result.status === "committed") setPtyId(undefined)
                }).catch((e) => {
                  reportWorkbenchError("recover tui pty", e)
                  setPtyError("TUI terminal connection lost")
                })
              }}
              onClose={() => {
                // TUI process exited (WS code 1000). Delete the backend PTY,
                // clear the store's tuiPtyId (removes the blue dot), drop the
                // in-memory ptyManager entry, and switch to chat view — keeping
                // the session binding intact so the user sees the conversation
                // they just left.
                setPtyId(undefined)
                void actions.exitTui({
                  scope: scopeFromTab({ name: ctx.spaceName, path: ctx.spacePath }),
                  panelID: ctx.panel.id,
                  ptyID: id,
                }).catch((e) => {
                  reportWorkbenchError("exit tui", e)
                })
              }}
            />
          )}
        </Show>
      )
    },
  })

  // ── Chat View ─────────────────────────────────────────────
  registry.register({
    id: ViewId.CHAT,
    label: "Chat",
    requiresSession: true,
    showContext: true,
    render: (ctx) => {
      if (!ctx.session) {
        return (
          <div class="flex flex-col items-center justify-center h-full gap-2 text-v2-text-text-muted bg-v2-background-bg-base">
            <IconV2 name="edit" class="size-6 opacity-40" />
            <span class="text-12-regular">No session bound</span>
          </div>
        )
      }
      return (
        <PanelChat
          panel={ctx.panel}
          session={ctx.session}
          directory={ctx.directory}
          spacePath={ctx.spacePath}
          spaceName={ctx.spaceName}
          onPromptReady={ctx.onPromptReady}
          canRestorePromptFocus={ctx.canRestorePromptFocus}
        />
      )
    },
  })

  // ── Context View ──────────────────────────────────────────
  registry.register({
    id: ViewId.CONTEXT,
    label: "Context",
    requiresSession: true,
    showContext: false,
    render: (ctx) => {
      const sessionId = ctx.session?.id
      if (!sessionId) {
        return (
          <div class="flex flex-col items-center justify-center h-full gap-2 text-v2-text-text-muted bg-v2-background-bg-base">
            <IconV2 name="edit" class="size-6 opacity-40" />
            <span class="text-12-regular">No session bound</span>
          </div>
        )
      }
      const history = createMemoryHistory()
      history.set({ value: `/session/${sessionId}`, replace: true })
      return (
        <MemoryRouter history={history}>
          <Route path="/session/:id" component={SessionContextTab} />
        </MemoryRouter>
      )
    },
  })
}
