import { ProgressCircle } from "@wopal/ui/progress-circle"
import { Popover } from "@wopal/ui/popover"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"

/**
 * SessionContextPopup — context usage 浮层入口。
 *
 * 渲染一个圆形进度环 trigger + popover 浮层（tokens / usage bar / cost / metrics）。
 * 圆环填充度反映 token 使用率。
 *
 * Trigger 配置：
 * - 默认：自带一个带 ProgressCircle 的 button
 * - `children` slot：传入 JSX.Element 作为外部 trigger（保持视觉与官方 `SessionContextUsage`
 *   圆环一致，但点击行为切到弹出 popover 而不是打开侧边 tab）。
 *   外部 trigger 必须是可点击元素且能被 Popover 的 trigger ref 接管（一般为 Button）。
 */
export function SessionContextPopup(props: {
  sessionId?: string
  directory?: string
  placement?: "top" | "bottom" | "left" | "right" | "top-start" | "top-end" | "bottom-start" | "bottom-end"
  children?: JSX.Element
}) {
  const sync = useSync()
  const language = useLanguage()
  const providers = useProviders()
  const [open, setOpen] = createSignal(false)

  const messages = createMemo(() => {
    if (!props.sessionId) return []
    return sync.data.message[props.sessionId] ?? []
  })

  const metrics = createMemo(() =>
    getSessionContextMetrics(messages(), [...providers.all().values()]),
  )

  const context = createMemo(() => metrics().context)
  const cost = createMemo(() => metrics().totalCost)

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const usage = createMemo(() => context()?.usage ?? 0)

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return { user, assistant }
  })

  const ringColor = createMemo(() => {
    const u = usage()
    if (u >= 100) return "[&_[data-slot=progress-circle-progress]]:stroke-red-500"
    if (u >= 80) return "[&_[data-slot=progress-circle-progress]]:stroke-amber-400"
    return ""
  })

  const defaultTrigger = (
    <button
      type="button"
      class="flex items-center justify-center cursor-pointer rounded hover:bg-v2-overlay-simple-overlay-hover p-0.5"
      aria-label="Context usage"
    >
      <ProgressCircle
        size={16}
        strokeWidth={2}
        percentage={usage()}
        class={ringColor()}
      />
    </button>
  )

  return (
    <Show when={props.sessionId}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        placement={props.placement ?? "bottom-start"}
        gutter={4}
        trigger={props.children ?? defaultTrigger}
        class="w-72"
      >
        <Show
          when={context()}
          fallback={
            <div class="p-3 text-12-regular text-v2-text-text-muted">
              No context data
            </div>
          }
        >
          {(ctx) => (
            <div class="flex flex-col gap-3 p-3">
              <div class="flex items-center justify-between">
                <span class="text-12-medium text-v2-text-text-base">
                  Context Usage
                </span>
                <span class="text-11-regular text-v2-text-text-muted">
                  {ctx().modelLabel}
                </span>
              </div>

              <div class="flex items-center justify-between">
                <span class="text-11-medium text-v2-text-text-base">
                  {Math.round(usage())}% usage
                </span>
                <span class="text-11-regular text-v2-text-text-muted">
                  {ctx().total.toLocaleString(language.intl())}
                  <Show when={ctx().limit}>
                    {" / "}
                    {ctx().limit!.toLocaleString(language.intl())}
                  </Show>
                  {" tokens"}
                </span>
              </div>

              <div class="flex flex-col gap-0.5 text-11-regular">
                <MetricRow
                  label="Input"
                  value={ctx().input.toLocaleString(language.intl())}
                />
                <MetricRow
                  label="Output"
                  value={ctx().output.toLocaleString(language.intl())}
                />
                <MetricRow
                  label="Cache R/W"
                  value={`${ctx().cacheRead.toLocaleString(language.intl())} / ${ctx().cacheWrite.toLocaleString(language.intl())}`}
                />
                <MetricRow
                  label="User Messages"
                  value={counts().user.toLocaleString(language.intl())}
                />
                <MetricRow
                  label="Assistant Messages"
                  value={counts().assistant.toLocaleString(language.intl())}
                />
              </div>

              <div class="flex items-center justify-between border-t border-v2-border-border-base pt-2">
                <span class="text-11-regular text-v2-text-text-muted">
                  Cost
                </span>
                <span class="text-11-medium text-v2-text-text-base">
                  {usd().format(cost())}
                </span>
              </div>
            </div>
          )}
        </Show>
      </Popover>
    </Show>
  )
}

function MetricRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between">
      <span class="text-v2-text-text-muted">{props.label}</span>
      <span class="text-v2-text-text-base">{props.value}</span>
    </div>
  )
}
