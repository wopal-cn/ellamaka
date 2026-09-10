import { Show, createMemo } from "solid-js"
import { Tooltip } from "@wopal/ui/tooltip"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { useLanguage } from "@/context/language"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import {
  contextPercentage,
  contextTone,
  type ContextMetricsSnapshot,
} from "@/components/session-context-label"

const toneClass: Record<string, string> = {
  normal: "text-v2-text-text-muted",
  warning: "text-amber-500",
  critical: "text-red-500",
}

/**
 * SessionContextHeaderTrigger — panel header 的 context 占用百分比按钮。
 *
 * 展示当前 session 的 context 占用百分比；hover 显示 tokens 摘要 tooltip；
 * 点击行为与原 Context 视图按钮一致（切换视图，由外部传入 onClick）。
 *
 * 数据来源：directory child store（不依赖路由 params）；provider 列表来自
 * useProviders 的 workbench 回退链（本 directory → 全局）。
 */
export function SessionContextHeaderTrigger(props: {
  sessionId: string
  directory: string
  active: boolean
  onClick: (e: MouseEvent) => void
}) {
  const serverSync = useServerSync()
  const providers = useProviders()
  const language = useLanguage()

  // Use serverSync.child() to obtain a reactive Solid Store proxy rather than
  // the plain-object `children` dictionary. Direct `children[key]` access
  // silently returns undefined when the store hasn't been created yet, which
  // causes the memo to capture zero reactive dependencies and never re-fire.
  // child({ bootstrap: false }) also normalises the directory key (trailing
  // slashes, backslashes) and pins the store for the component's lifetime.
  const messages = createMemo(() => {
    const dir = props.directory
    if (!dir) return []
    const [store] = serverSync.child(dir, { bootstrap: false })
    return store.message[props.sessionId] ?? []
  })

  const metrics = createMemo<ContextMetricsSnapshot | undefined>(() => {
    const resolved = getSessionContextMetrics(messages(), [...providers.all().values()])
    if (!resolved.context) return undefined
    return {
      total: resolved.context.total,
      limit: resolved.context.limit,
      usage: resolved.context.usage,
    }
  })

  const percentage = createMemo(() => contextPercentage(metrics()))
  const tone = createMemo(() => contextTone(percentage()))

  const tooltipValue = createMemo(() => {
    const ctx = metrics()
    if (!ctx) return language.t("context.usage.tooltipNoLimit", { tokens: "0" })
    const tokens = ctx.total.toLocaleString(language.intl())
    if (ctx.usage === null) return language.t("context.usage.tooltipNoLimit", { tokens })
    return language.t("context.usage.tooltip", { tokens, percent: ctx.usage })
  })

  return (
    <Tooltip value={tooltipValue()} placement="bottom">
      <button
        type="button"
        data-component="session-context-header-trigger"
        class="h-5 inline-flex items-center justify-center px-1.5 rounded-md text-10-medium transition-all select-none"
        classList={{
          [toneClass[tone()]]: true,
          "cursor-pointer hover:bg-v2-overlay-simple-overlay-hover": !props.active,
          "bg-v2-overlay-simple-overlay-pressed text-v2-text-text-strong font-semibold shadow-xs": props.active,
        }}
        aria-label={language.t("context.usage.view")}
        onClick={props.onClick}
      >
        <Show when={percentage() !== undefined} fallback={<span>—</span>}>
          <span>{percentage()}%</span>
        </Show>
      </button>
    </Tooltip>
  )
}