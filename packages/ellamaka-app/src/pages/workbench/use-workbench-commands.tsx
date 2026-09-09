import { useDialog } from "@wopal/ui/context/dialog"
import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSessionStore } from "@/pages/workbench/session-store"
import { useWorkbenchActions } from "@/pages/workbench/workbench-actions"
import { useWorkbenchState } from "@/pages/workbench/view-store"
import { scopeName, scopePath } from "@/pages/workbench/workbench-scope"
import { usePlatform } from "@/context/platform"
import { createEffect, createMemo, on } from "solid-js"
import { isWorkbenchTabCloseProtected } from "./workbench-keyboard"

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useWorkbenchCommands = () => {
  const command = useCommand()
  const language = useLanguage()
  const actions = useWorkbenchActions()
  const wb = useWorkbenchState()
  const sessionStore = useSessionStore()
  const dialog = useDialog()
  const platform = usePlatform()
  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const modelCommand = withCategory(language.t("command.category.model"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const agentCommand = withCategory(language.t("command.category.agent"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const proxyAction = (id: string) => ({
    get disabled() { return !actions.canExecuteActivePanelAction(id) },
    onSelect: () => actions.executeActivePanelAction(id),
  })

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => {
        const active = actions.activeTarget()
        if (active) {
          void actions.createSession({
            scope: active.scope,
            panelID: active.panelID,
          })
        }
      },
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      ...proxyAction("session.undo"),
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      ...proxyAction("session.redo"),
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      ...proxyAction("session.compact"),
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      ...proxyAction("session.fork"),
    }),
  ]

  const shareCmds = () => [
    sessionCommand({
      id: "session.share",
      title: language.t("command.session.share"),
      description: language.t("command.session.share.description"),
      slash: "share",
      ...proxyAction("session.share"),
    }),
    sessionCommand({
      id: "session.unshare",
      title: language.t("command.session.unshare"),
      description: language.t("command.session.unshare.description"),
      slash: "unshare",
      ...proxyAction("session.unshare"),
    }),
  ]

  const fileCmds = () => [
    fileCommand({
      id: "file.open",
      title: language.t("command.file.open"),
      description: language.t("palette.search.placeholder"),
      keybind: "mod+k,mod+p",
      slash: "open",
      ...proxyAction("file.open"),
    }),
    fileCommand({
      id: "tab.close",
      title: language.t("command.tab.close"),
      keybind: "mod+w",
      onSelect: () => {
        // Native desktop accelerators trigger this command directly and do
        // not pass through WorkbenchShell's keydown guard.
        if (dialog.active) return
        if (isWorkbenchTabCloseProtected(wb.activeTab())) {
          wb.setStatusMessage(language.t("workbench.status.tabPinnedProtected", { default: "Pinned tab protected from closing" }))
          return
        }
        if (actions.canExecuteActivePanelAction("tab.close")) {
          actions.executeActivePanelAction("tab.close")
          return
        }
        const active = actions.activeTarget()
        if (!active) {
          if (platform.platform === "desktop") {
            void platform.runDesktopMenuAction?.("window.close")
          }
          return
        }

        const path = scopePath(active.scope)
        const panels = wb.spaceState(path)?.panels ?? []

        if (panels.length > 1) {
          const panel = panels.find((p) => p.id === active.panelID)
          if (panel?.slotState === "bound") {
            const session = sessionStore.getSession(panel.boundSessionId ?? "")
            const sessionTitle = session?.title ?? language.t("workbench.panelClose.title")
            void import("./parts/session-tree-dialogs").then((m) => {
              dialog.show(() => (
                <m.DialogClosePanel
                  sessionTitle={sessionTitle}
                  onClose={async () => {
                    await actions.closePanel({ scope: active.scope, panelID: active.panelID })
                  }}
                />
              ))
            })
          } else {
            void actions.closePanel({ scope: active.scope, panelID: active.panelID })
          }
          return
        }

        if (active.scope.kind === "space") {
          const name = scopeName(active.scope)
          const spacePathVal = path
          void import("./parts/workspace").then((m) => {
            dialog.show(() => (
              <m.DialogCloseTab name={name} path={spacePathVal} />
            ))
          })
          return
        }

        if (platform.platform === "desktop") {
          void platform.runDesktopMenuAction?.("window.close")
        }
      },
    }),
  ]

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      ...proxyAction("context.addSelection"),
    }),
  ]

  const viewCmds = () => [
    viewCommand({
      id: "sidebar.toggle",
      title: language.t("command.sidebar.toggle"),
      keybind: "mod+b",
      onSelect: () => wb.setDisplay("showSpaceRail", !wb.display().showSpaceRail),
    }),
    viewCommand({
      id: "settings.open",
      title: language.t("command.settings.open"),
      keybind: "ctrl+comma",
      onSelect: () => {
        void import("@/components/dialog-settings").then((x) => (
          dialog.show(() => <x.DialogSettings />)
        ))
      },
    }),
    viewCommand({
      id: "terminal.toggle",
      title: language.t("command.terminal.toggle"),
      slash: "terminal",
      ...proxyAction("terminal.toggle"),
    }),
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      ...proxyAction("review.toggle"),
    }),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      ...proxyAction("input.focus"),
    }),
  ]

  const terminalCmds = () => [
    terminalCommand({
      id: "terminal.new",
      title: language.t("command.terminal.new"),
      description: language.t("command.terminal.new.description"),
      ...proxyAction("terminal.new"),
    }),
  ]

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      ...proxyAction("message.previous"),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      ...proxyAction("message.next"),
    }),
  ]

  const modelCmds = () => [
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      ...proxyAction("model.choose"),
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      ...proxyAction("model.variant.cycle"),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      slash: "mcp",
      ...proxyAction("mcp.toggle"),
    }),
  ]

  const agentCmds = () => [
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      slash: "agent",
      ...proxyAction("agent.cycle"),
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      ...proxyAction("agent.cycle.reverse"),
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: language.t("command.permissions.autoaccept.enable"),
      ...proxyAction("permissions.autoaccept"),
    }),
  ]

  const commands = createMemo(() => [
    ...sessionCmds(),
    ...shareCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
    ...modelCmds(),
    ...mcpCmds(),
    ...agentCmds(),
    ...permissionsCmds(),
  ])

  createEffect(on(commands, (cmds) => {
    command.register("workbench.session", () => cmds)
  }))
}
