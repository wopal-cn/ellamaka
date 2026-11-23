import { createContext, useContext, type JSX } from "solid-js"

/**
 * SessionSurfaceContext marks a Session subtree as embedded outside the
 * canonical Session page layout.
 *
 * 官方 `SessionContextUsage` 组件的圆环点击默认行为是「打开侧边 context tab」。
 * 但 workbench 的 chat 视图没有官方 Layout 的 side-panel / fileTree / reviewPanel
 * 基础设施，打开侧边 tab 会失败或行为不一致。
 *
 * 此 context 在 PanelChat 的 provider chain 中提供，让 `SessionContextUsage`
 * detect 到时切换为 popup 行为（复用 `ContextPopup` 组件渲染浮层）。
 *
 * 注入点：`components/session-context-usage.tsx` 内的 early-return guard。
 * 上游 merge 时保留 import + guard 这两行最小注入即可。
 */
type SessionSurfaceContextValue = {
  readonly kind: "embedded"
}

const SessionSurfaceContext = createContext<SessionSurfaceContextValue>()

export function EmbeddedSessionSurfaceProvider(props: { children: JSX.Element }) {
  return <SessionSurfaceContext.Provider value={{ kind: "embedded" }}>{props.children}</SessionSurfaceContext.Provider>
}

export function useSessionSurface(): SessionSurfaceContextValue | undefined {
  return useContext(SessionSurfaceContext)
}
