import { createSignal, onMount, Show } from "solid-js"
import { ResultPanel } from "../components/ResultPanel"
import { useOnboardingClient } from "../onboarding-client-context"
import {
  formatInstallFailure,
  resolveInstallRetryTarget,
  type InstallFailure,
} from "./install-cli-flow"

function readString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export interface StepProps {
  onStatusChange?: (status: "idle" | "working" | "success" | "error") => void
  onComplete: () => void
  onError: (err: { code?: string; message: string; details?: string } | null) => void
}

export function InstallCliStep(props: StepProps) {
  const client = useOnboardingClient()
  const [phaseMessage, setPhaseMessage] = createSignal("正在准备组件安装与校验…")
  const [currentTool, setCurrentTool] = createSignal<"wopal" | "ellamaka">("wopal")
  const [isWorking, setIsWorking] = createSignal(true)
  const [wopalStatus, setWopalStatus] = createSignal<{ done: boolean; version?: string; upgraded?: boolean }>({ done: false })
  const [ellamakaStatus, setEllamakaStatus] = createSignal<{ done: boolean; version?: string; upgraded?: boolean }>({ done: false })
  const [failure, setFailure] = createSignal<InstallFailure | null>(null)
  let operationActive = false

  const formatVersionString = (ver?: string) => {
    if (!ver) return "已就绪"
    const cleaned = String(ver).trim()
    if (/^\d/.test(cleaned)) return `v${cleaned}`
    return cleaned
  }

  const startInstall = async () => {
    if (operationActive) return
    const startTool = resolveInstallRetryTarget({
      wopalReady: wopalStatus().done,
      failedTool: failure() ? currentTool() : null,
    })
    operationActive = true
    props.onError(null)
    setFailure(null)
    setIsWorking(true)
    props.onStatusChange?.("working")
    if (startTool === "wopal") setWopalStatus({ done: false })
    setEllamakaStatus({ done: false })

    try {
      if (startTool === "wopal") {
        setCurrentTool("wopal")
        setPhaseMessage("正在检查并安装 Wopal CLI 工具链…")

        const wopalRes = await client.executeStep("install-cli", { subStep: "wopal" })

        if (wopalRes.status === "failed") {
          setFailure(formatInstallFailure("wopal", wopalRes.error ?? {}))
          setIsWorking(false)
          props.onStatusChange?.("error")
          return
        }

        const wopalVersion = readString(wopalRes.result?.version) || readString(wopalRes.result?.wopalVersion)
        const wopalUpgraded = wopalRes.result?.upgraded === true
        setWopalStatus({ done: true, version: formatVersionString(wopalVersion), upgraded: wopalUpgraded })
      }

      setCurrentTool("ellamaka")
      setPhaseMessage("正在下载并配置 Ellamaka AI 引擎…")

      const ellamakaRes = await client.executeStep("install-cli", { subStep: "ellamaka" })

      if (ellamakaRes.status === "failed") {
        setFailure(formatInstallFailure("ellamaka", ellamakaRes.error ?? {}))
        setIsWorking(false)
        props.onStatusChange?.("error")
        return
      }

      const ellamakaVersion = readString(ellamakaRes.result?.version) || readString(ellamakaRes.result?.engineVersion)
      const ellamakaUpgraded = ellamakaRes.result?.upgraded === true
      setEllamakaStatus({ done: true, version: formatVersionString(ellamakaVersion), upgraded: ellamakaUpgraded })

      // All finished
      setIsWorking(false)
      props.onStatusChange?.("success")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setFailure(formatInstallFailure(currentTool(), { message: msg }))
      setIsWorking(false)
      props.onStatusChange?.("error")
    } finally {
      operationActive = false
    }
  }

  onMount(() => {
    void startInstall()
  })

  return (
    <form
      id="onboarding-step-install-cli"
      class="ob-step-content"
      onSubmit={(event) => {
        event.preventDefault()
        void startInstall()
      }}
    >
      <ResultPanel
        title={isWorking() ? phaseMessage() : failure() ? "组件安装失败" : "基础组件与 AI 运行时引擎已就绪"}
        variant={isWorking() ? "working" : failure() ? "error" : "success"}
        message={failure() ? `${failure()!.message} ${failure()!.suggestion ?? ""}`.trim() : undefined}
      >
        <div class="ob-result-details">
          <div class="ob-result-row">
            <span class="ob-result-label">Wopal CLI 命令行工具</span>
            <span class="ob-result-value">
              <Show
                when={wopalStatus().done}
                fallback={
                  <span style={{ color: "var(--ob-text-subtle)" }}>
                    {currentTool() === "wopal" && isWorking() ? "正在安装校验…" : failure() && currentTool() === "wopal" ? (
                      <span class="ob-result-value ob-result-error">安装失败</span>
                    ) : "等待中"}
                  </span>
                }
              >
                <span style={{ color: "#34d399", "font-weight": "600" }}>
                  ✓ {wopalStatus().version}
                  {wopalStatus().upgraded ? " (已检测最新版)" : ""}
                </span>
              </Show>
            </span>
          </div>

          <div class="ob-result-row">
            <span class="ob-result-label">Ellamaka AI 引擎</span>
            <span class="ob-result-value">
              <Show
                when={ellamakaStatus().done}
                fallback={
                  <span style={{ color: "var(--ob-text-subtle)" }}>
                    {currentTool() === "ellamaka" && isWorking() ? "正在下载配置…" : failure() && currentTool() === "ellamaka" ? (
                      <span class="ob-result-value ob-result-error">安装失败</span>
                    ) : "等待中"}
                  </span>
                }
              >
                <span style={{ color: "#34d399", "font-weight": "600" }}>
                  ✓ {ellamakaStatus().version}
                  {ellamakaStatus().upgraded ? " (已更新)" : ""}
                </span>
              </Show>
            </span>
          </div>
        </div>
      </ResultPanel>
    </form>
  )
}
