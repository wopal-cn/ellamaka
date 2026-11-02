import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { checkServerHealth } from "@/utils/server-health"
import type { CorePreparationState, CorePreparationStep, ServerHealth } from "@/utils/server-health"
import { useServer } from "@/context/server"
import { useOnboardingClient } from "../onboarding-client-context"

/**
 * Visible Core Preparation step.
 *
 * Sits after Space on purpose: future preparation can use Ontology resources,
 * and running it last keeps the failure surface small — foundation, Ontology and Space are already committed,
 * so a failed preparation only affects the runtime itself
 * (DESIGN-onboarding.md `## Core Preparation Timing`).
 *
 * The step both triggers preparation and renders its live progress. `prepare`
 * is idempotent, so a host that is already READY finishes immediately.
 */

const STEP_LABELS: Record<string, string> = {
  "dsh.closure": "下载运行时依赖",
  "dsh.home": "准备运行时目录",
  "dsh.profiles": "装配能力配置",
}

const STATE_LABELS: Record<string, string> = {
  READY: "已完成",
  PREPARING: "进行中",
  NEEDS_PREPARATION: "待准备",
  BUSY: "等待中",
  DEGRADED: "降级",
}

const PHASE_LABELS: Record<string, string> = {
  lock: "等待准备权限",
  materialize: "下载并安装依赖",
  "closure.completed": "依赖准备完成",
  "home.prepare": "准备运行目录",
  "home.completed": "运行目录准备完成",
  "profiles.prepare": "装配运行配置",
  "profiles.completed": "运行配置完成",
  failed: "准备失败",
  cancelled: "已取消",
  blocked: "等待其他任务",
}

const phaseLabel = (phase: string) => PHASE_LABELS[phase] ?? phase

export interface RuntimePreparationStepProps {
  onStart?: () => void
  /** Called once preparation reaches a terminal state the wizard may leave. */
  onReady?: () => void
  /** Called when preparation fails outright so the wizard can show the error. */
  onFailed?: (message: string) => void
  onProgress?: (message: string) => void
}

export function RuntimePreparationStep(props: RuntimePreparationStepProps) {
  const server = useServer()
  const client = useOnboardingClient()
  return (
    <RuntimePreparationView
      {...props}
      prepare={() => client.prepareRuntime()}
      health={() => (server.current ? checkServerHealth(server.current.http, fetch) : Promise.resolve(undefined))}
    />
  )
}

export function RuntimePreparationView(
  props: RuntimePreparationStepProps & {
    prepare: () => Promise<{ status: "ready" | "degraded" | "disabled"; diagnostic?: string }>
    health: () => Promise<ServerHealth | undefined>
  },
) {
  const [steps, setSteps] = createSignal<readonly CorePreparationStep[]>([])
  const [state, setState] = createSignal<CorePreparationState | undefined>(undefined)
  const [run, setRun] = createSignal<{ step: string; phase: string; elapsedMs: number } | undefined>(undefined)
  const [degraded, setDegraded] = createSignal<string | undefined>(undefined)
  const [disabled, setDisabled] = createSignal(false)
  let settled = false
  let active = true
  const reported = new Map<string, string>()
  let lastRunMessage = ""

  const probe = async () => {
    const health = await props.health()
    if (!active || !health) return
    const preparation = health.preparation
    if (!preparation) {
      setState(health.dsh?.web === "ready" || health.dsh?.tools === "ready" ? "READY" : undefined)
      return
    }
    setState(preparation.state)
    setSteps(preparation.steps)
    setRun(preparation.state === "PREPARING" ? preparation.run : undefined)
    if (preparation.state === "PREPARING" && preparation.run) {
      const elapsed = Math.floor(preparation.run.elapsedMs / 5000) * 5
      const message = `${STEP_LABELS[preparation.run.step] ?? preparation.run.step}：${phaseLabel(preparation.run.phase)}，已用时 ${elapsed} 秒`
      if (message !== lastRunMessage) {
        lastRunMessage = message
        props.onProgress?.(message)
      }
    }
    for (const step of preparation.steps) {
      if (reported.get(step.step) === step.state) continue
      reported.set(step.step, step.state)
      if (step.state === "NEEDS_PREPARATION") continue
      props.onProgress?.(`${STEP_LABELS[step.step] ?? step.step}：${STATE_LABELS[step.state] ?? step.state}`)
    }
  }

  onMount(() => {
    props.onStart?.()
    props.onProgress?.("开始检查并准备运行环境。")
    const timer = setInterval(() => void probe(), 1200)
    void probe()
    void (async () => {
      try {
        const result = await props.prepare()
        if (!active) return
        if (result.status === "disabled") {
          setDisabled(true)
          settled = true
          props.onProgress?.("DSH 网页和工具均已关闭，跳过运行环境准备。")
          props.onReady?.()
          return
        }
        if (result.status === "degraded") {
          setDegraded(result.diagnostic ?? "运行时准备降级")
          props.onProgress?.(`运行时准备降级：${result.diagnostic ?? "请检查运行时状态"}`)
          settled = true
          props.onReady?.()
          return
        }
        await probe()
        if (!active) return
        settled = true
        props.onProgress?.("运行环境准备完成。")
        props.onReady?.()
      } catch (error) {
        if (settled || !active) return
        settled = true
        const message = error instanceof Error ? error.message : String(error)
        props.onProgress?.(`运行环境准备失败：${message}`)
        props.onFailed?.(message)
      }
    })()
    onCleanup(() => {
      active = false
      clearInterval(timer)
    })
  })

  const percent = () => {
    const all = steps()
    if (all.length === 0) return undefined
    return Math.round((all.filter((entry) => entry.state === "READY").length / all.length) * 100)
  }

  return (
    <div class="ob-step-content">
      <p class="ob-description">
        正在准备这份构建的运行时环境：下载固定的依赖闭包、建立运行时目录并装配能力配置。首次运行需要数十秒，之后长期复用。
      </p>

      <Show when={percent() !== undefined}>
        <div class="ob-progress-bar-track">
          <div class="ob-progress-bar-fill" style={{ width: `${percent()}%` }} />
        </div>
      </Show>

      <div class="ob-result-details">
        <For each={steps()}>
          {(entry) => (
            <div class="ob-result-row">
              <span class="ob-result-label">{STEP_LABELS[entry.step] ?? entry.step}</span>
              <span class="ob-result-value">
                {run()?.step === entry.step
                  ? `进行中 · ${phaseLabel(run()?.phase ?? "")}`
                  : (STATE_LABELS[entry.state] ?? entry.state)}
              </span>
            </div>
          )}
        </For>
      </div>

      <Show when={steps().length === 0}>
        <div class="ob-hint">状态：{disabled() ? "已跳过" : (STATE_LABELS[state() ?? ""] ?? "准备中")}</div>
      </Show>

      <Show when={degraded()}>
        <div class="ob-error-banner" role="alert">
          <div class="ob-error-indicator">!</div>
          <div class="ob-error-text">
            <div class="ob-error-heading">运行时准备降级</div>
            <div class="ob-error-message">{degraded()}</div>
          </div>
        </div>
      </Show>
    </div>
  )
}
