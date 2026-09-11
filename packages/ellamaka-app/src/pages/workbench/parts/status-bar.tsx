import { Show, createMemo, For, createEffect } from "solid-js"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { useWorkbenchState } from "../view-store"
import { useSessionStore } from "../session-store"
import { StatusBarStatusPopover, StatusBarServerStatusPopover } from "@/components/status-popover"
import { getStatusBarSegments } from "./status-bar-segments"
import { WorkbenchActiveDirectoryProvider } from "../workbench-directory-provider"
import { useWorkbenchRuntime } from "../workbench-runtime"
import { StatusBarDiagnosticsCenter } from "./status-bar-diagnostics"

export function StatusBar() {
  const wb = useWorkbenchState()
  const sessionStore = useSessionStore()
  const server = useServer()
  const runtime = useWorkbenchRuntime()
  const language = useLanguage()

  const activePath = createMemo(() => wb.activeTab()?.path ?? "")
  const space = createMemo(() => wb.spaceState(activePath()))
  const spaceName = createMemo(() => wb.activeTab()?.name ?? "")

  const segments = createMemo(() => {
    const name = spaceName()
    const sp = space()
    if (!name || !sp) return []
    return getStatusBarSegments({
      spaceName: name,
      activePanelID: sp.activePanelID,
      panels: sp.panels,
      getSessionTitle: (id) => sessionStore.getSession(id)?.title,
    })
  })

  createEffect(() => {
    const status = runtime.status
    if (status === "online") {
      wb.removeDiagnostic("runtime-connection-status")
    } else {
      let text = ""
      let type: "error" | "warning" | "info" = "warning"

      if (status === "offline") {
        text = language.t("workbench.runtime.offline") || "已断开连接"
        type = "error"
      } else if (status === "degraded") {
        text = language.t("workbench.runtime.degraded") || "事件流重连中"
        type = "warning"
      } else if (status === "recovering") {
        text = language.t("workbench.runtime.recovering") || "正在重连"
        type = "info"
      }

      wb.pushDiagnostic(type, text, {
        id: "runtime-connection-status",
        autoDismiss: false,
        onRetry: runtime.retry,
        source: "Connection",
      })
    }
  })

  return (
    <footer class="relative z-30 flex h-6 shrink-0 items-center justify-between gap-2 border-t border-v2-border-border-base bg-v2-background-bg-base px-2 text-10-regular text-v2-text-text-muted select-none">
      {/* 左区：空间 / panel / 会话 / 路径 的现代紧凑层级链 */}
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <For each={segments()}>
          {(seg, idx) => (
            <>
              <Show when={idx() > 0}>
                <span class="text-v2-text-text-faint select-none">/</span>
              </Show>
              <span class="truncate text-v2-text-text-muted" title={seg.type === "path" ? "/" + seg.text : seg.text}>
                {seg.text}
              </span>
            </>
          )}
        </For>
      </div>

      {/* 中区：绝对居中诊断与提示中心 */}
      <StatusBarDiagnosticsCenter />

      {/* 右区：Server 状态控制按钮 + 名字，带有左边框分割 */}
      <div class="flex max-w-48 shrink-0 items-center gap-1 border-l border-v2-border-border-base pl-2">
        <WorkbenchActiveDirectoryProvider fallback={<StatusBarServerStatusPopover />}>
          {() => <StatusBarStatusPopover />}
        </WorkbenchActiveDirectoryProvider>
        <span class="truncate select-none ml-1">{server.name}</span>
      </div>
    </footer>
  )
}
