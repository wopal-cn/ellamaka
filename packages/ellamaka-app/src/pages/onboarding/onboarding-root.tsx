import { createSignal, For, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import { useNavigate } from "@solidjs/router"
import {
  createStepController,
  getStepMetadata,
  getStepContent,
  ONBOARDING_STEPS,
  PHASE_CONFIGS,
  getPhaseForStep,
  canNavigateToPhase,
  requiresRuntimePreparation,
  applyRuntimePreparationGate,
  isOptionalStep,
  type OnboardingStepName,
} from "./step-controller"
import { FoundationStep } from "./steps/system-check"
import { GithubAuthStep } from "./steps/github-auth"
import { OntologySetupStep, type OntologySetupInput } from "./steps/ontology-setup"
import { AiProviderStep } from "./steps/ai-provider"
import { CreateSpaceStep, type CreateSpaceInput } from "./steps/create-space"
import { RuntimePreparationStep } from "./steps/runtime-preparation"
import { DoneStep } from "./steps/done"
import { ProgressDisplay } from "./components/ProgressDisplay"
import { LogDrawer } from "./components/LogDrawer"
import { StepGuide } from "./components/StepGuide"
import { getStepGuideSource, STEP_GUIDE_ASSETS } from "./content/step-guides"
import { useOnboardingClient } from "./onboarding-client-context"
import {
  goalsForSetup,
  githubForkReady,
  resolveSetupStep,
  setupErrorView,
  setupFailureRecovery,
  setupActionLabel,
  type SetupErrorView,
  type SetupStep,
} from "./setup-flow"
import { type SetupActionId, type SetupEventView, type SetupInspect, type SetupRun } from "./setup-client"
import "./onboarding.css"

export interface LogEntry {
  text: string
  isError?: boolean
}

const FORM_SUBMIT_STEPS = new Set<OnboardingStepName>(["system-check", "ontology-setup", "create-space", "ai-provider"])

function stepFromSetup(step: SetupStep): OnboardingStepName | "done" {
  if (step === "foundation") return "system-check"
  if (step === "github") return "github-auth"
  if (step === "ontology") return "ontology-setup"
  if (step === "space") return "create-space"
  if (step === "provider") return "ai-provider"
  return "done"
}

function runError(run: SetupRun) {
  if (run.status === "failed") {
    return Object.assign(new Error(run.error?.message ?? "Setup action failed."), {
      cause: { body: run.error ?? { code: "SETUP_OPERATION_FAILED", message: "Setup action failed." } },
    })
  }
  if (run.status === "cancelled") {
    return Object.assign(new Error(run.error?.message ?? "Setup action was cancelled."), {
      cause: { body: run.error ?? { code: "SETUP_OPERATION_CANCELLED", message: "Setup action was cancelled." } },
    })
  }
  return undefined
}

export function OnboardingRoot() {
  const client = useOnboardingClient()
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = createSignal<OnboardingStepName | "done">("system-check")
  const [facts, setFacts] = createSignal<SetupInspect>()
  const [initialized, setInitialized] = createSignal(false)
  const [working, setWorking] = createSignal(false)
  const [progressMsg, setProgressMsg] = createSignal("")
  const [logs, setLogs] = createSignal<LogEntry[]>([{ text: "正在读取初始化状态。" }])
  const [errorInfo, setErrorInfo] = createSignal<SetupErrorView | null>(null)
  const [runId, setRunId] = createSignal<string>()
  const [providerSkipped, setProviderSkipped] = createSignal(false)
  const [ontologyMode, setOntologyMode] = createSignal<"fork" | "clone">("clone")
  // Runtime readiness gates navigation only; it is never persisted as Setup state.
  const [runtimeReady, setRuntimeReady] = createSignal(false)
  const [launching, setLaunching] = createSignal(false)
  const [completionError, setCompletionError] = createSignal<string | null>(null)
  let doneLaunch: (() => void) | null = null
  let followAbort: AbortController | undefined
  let ontologyModeChosen = false
  const controller = createStepController("system-check")

  const appendLog = (text: string, isError = false) => {
    if (!text.trim()) return
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "")
    setLogs((previous) => [...previous.slice(-200), { text: `[${new Date().toLocaleTimeString()}] ${clean}`, isError }])
  }

  const providerWasSkipped = () => providerSkipped() || facts()?.state.steps.provider === "skipped"

  const selection = (action?: SetupActionId) => ({
    ontologyMode: action === "github" ? ("fork" as const) : ontologyMode(),
    provider: action === "provider" || !providerWasSkipped(),
  })

  const applyFacts = (next: SetupInspect) => {
    setFacts(next)
    if (!ontologyModeChosen) {
      setOntologyMode(next.ontology.items[0]?.mode ?? (githubForkReady(next) ? "fork" : "clone"))
    }
  }

  const setVisibleStep = (next: OnboardingStepName | "done") => {
    if (currentStep() !== next) {
      setProgressMsg("")
      appendLog(`进入：${getStepMetadata(next).title}`)
    }
    setCurrentStep(next)
    controller.setCurrentStep(next)
  }

  const reload = async (options: { preserveStep?: boolean } = {}) => {
    const next = await client.inspect()
    applyFacts(next)
    if (!options.preserveStep) {
      setVisibleStep(applyRuntimePreparationGate(stepFromSetup(resolveSetupStep(next)), runtimeReady()))
    }
    return next
  }

  const handleEvent = (event: SetupEventView) => {
    setProgressMsg(event.message)
    appendLog(event.message, event.phase === "failed")
    if (event.error?.suggestion) appendLog(`建议: ${event.error.suggestion}`, event.phase === "failed")
  }

  const runAction = async (actionId: SetupActionId, input?: Record<string, unknown>) => {
    setWorking(true)
    setErrorInfo(null)
    setCompletionError(null)
    setProgressMsg("正在检查初始化状态…")
    appendLog("正在检查初始化状态并准备执行。")
    followAbort?.abort()
    followAbort = new AbortController()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      const fresh = await client.inspect()
      applyFacts(fresh)
      const plan = await client.plan(goalsForSetup(fresh, selection(actionId)))
      const action = plan.actions.find((candidate) => candidate.actionId === actionId)
      if (!action) {
        appendLog("该步骤已完成，复用现有结果。")
        return fresh
      }

      const actionTitle = setupActionLabel(actionId, input, getStepMetadata(currentStep()).title)
      appendLog(`开始执行：${actionTitle}`)
      setProgressMsg(`正在执行：${actionTitle}`)
      let elapsed = 0
      heartbeat = setInterval(() => {
        elapsed += 10
        appendLog(`${actionTitle}正在进行，已用时 ${elapsed} 秒。`)
      }, 10_000)
      const started = await client.execute({ planId: plan.planId, actionId, ...(input ? { input } : {}) })
      setRunId(started.runId)
      const final = await client.follow(started.runId, handleEvent, {
        signal: followAbort.signal,
        after: 0,
      })
      const failure = runError(final)
      if (failure) throw failure
      const next = await client.inspect()
      applyFacts(next)
      return next
    } catch (error) {
      const view = setupErrorView(error)
      setErrorInfo(view)
      setProgressMsg("")
      appendLog(`${view.code ? `${view.code}: ` : ""}${view.message}`, true)
      const recovery = setupFailureRecovery(actionId, view)
      let refreshed: SetupInspect | undefined
      if (recovery.refreshFacts) {
        try {
          refreshed = await reload({ preserveStep: true })
        } catch {
          // Keep the original action error visible when refresh also fails.
        }
      }
      if (recovery.deriveStepFromFacts && refreshed) {
        setVisibleStep(stepFromSetup(resolveSetupStep(refreshed)))
      }
      return undefined
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      setWorking(false)
      setRunId(undefined)
    }
  }

  // Runtime preparation always runs after Space, even when provider is already
  // configured: it is the last heavy step and must stay visible.
  const afterSpace = () => setVisibleStep("runtime-preparation")

  const advanceAfter = (step: SetupStep, next: SetupInspect) => {
    if (step === "foundation")
      return setVisibleStep(applyRuntimePreparationGate(stepFromSetup(resolveSetupStep(next)), runtimeReady()))
    if (step === "github") return setVisibleStep("ontology-setup")
    if (step === "ontology")
      return setVisibleStep(next.space.items.some((item) => item.verified) ? "runtime-preparation" : "create-space")
    if (step === "space") return afterSpace()
    if (step === "provider") return setVisibleStep("done")
  }

  const runFoundation = async (homePath?: string) => {
    const current = facts()
    if (current && !current.home.binding.locked) {
      if (!homePath) return
      setWorking(true)
      setErrorInfo(null)
      setProgressMsg("正在确认 Wopal Home…")
      appendLog(`正在确认 Wopal Home：${homePath}`)
      try {
        const selected = await client.selectHome(homePath)
        appendLog(
          selected.mode === "development"
            ? `已锁定开发测试 Home：${selected.path}（不会写入 Shell）`
            : `已保存并锁定 WOPAL_HOME：${selected.path}`,
        )
        await reload({ preserveStep: true })
      } catch (error) {
        const view = setupErrorView(error)
        setErrorInfo(view)
        setProgressMsg("")
        appendLog(`${view.code ? `${view.code}: ` : ""}${view.message}`, true)
        setWorking(false)
        return
      } finally {
        setWorking(false)
      }
    }
    const next = await runAction("foundation")
    if (next) advanceAfter("foundation", next)
  }

  const refreshGithubIdentity = async () => {
    setWorking(true)
    setErrorInfo(null)
    setProgressMsg("正在重新检测 GitHub 登录…")
    try {
      const next = await reload({ preserveStep: true })
      if (githubForkReady(next)) {
        appendLog(`已检测到 GitHub 身份：${next.credentials.github.account ?? "已登录"}`)
        setProgressMsg("")
        setVisibleStep("ontology-setup")
      } else {
        setProgressMsg("")
        appendLog("仍未检测到本机 gh 登录。")
      }
    } catch (error) {
      const view = setupErrorView(error)
      setErrorInfo(view)
      setProgressMsg("")
      appendLog(view.message, true)
    } finally {
      setWorking(false)
    }
  }

  const continueWithClone = async () => {
    const next = await runAction("github", { skip: true })
    if (!next) return
    ontologyModeChosen = true
    setOntologyMode("clone")
    setErrorInfo(null)
    advanceAfter("github", next)
  }

  const runOntology = async (input: OntologySetupInput) => {
    ontologyModeChosen = true
    setOntologyMode(input.mode)
    const next = await runAction("ontology", {
      mode: input.mode,
      ...(input.source ? { source: input.source } : {}),
    })
    if (next) advanceAfter("ontology", next)
  }

  const runSpace = async (input: CreateSpaceInput) => {
    const next = await runAction("space", { name: input.name, path: input.path, type: input.type })
    if (next) advanceAfter("space", next)
  }

  const runProvider = async (input: { providerId: string; apiKey: string }) => {
    const next = await runAction("provider", input)
    if (next) advanceAfter("provider", next)
  }

  const skipProvider = async () => {
    const next = await runAction("provider", { skip: true })
    if (!next) return
    setProviderSkipped(true)
    advanceAfter("provider", next)
  }

  const launch = async () => {
    if (launching()) return
    setLaunching(true)
    setCompletionError(null)
    appendLog("正在检查初始化结果并启动工作台。")
    try {
      const fresh = await client.inspect()
      applyFacts(fresh)
      if (requiresRuntimePreparation(runtimeReady())) {
        setCompletionError("请先完成运行环境准备。")
        setVisibleStep("runtime-preparation")
        return
      }
      const plan = await client.plan(goalsForSetup(fresh, selection()))
      if (plan.actions.length > 0) {
        setCompletionError(`仍有未完成的初始化步骤：${plan.actions.map((action) => action.actionId).join(", ")}。`)
        return
      }
      await client.complete(plan.planId)
      navigate("/workbench")
    } catch (error) {
      const view = setupErrorView(error)
      setCompletionError(view.message)
      setErrorInfo(view)
      appendLog(view.message, true)
    } finally {
      setLaunching(false)
    }
  }

  const handleCancel = async () => {
    const id = runId()
    if (!id) return
    try {
      const run = await client.cancel(id)
      setProgressMsg(run.error?.message ?? `任务状态：${run.status}`)
      if (run.status === "cancelled") {
        setErrorInfo({ code: "SETUP_OPERATION_CANCELLED", message: run.error?.message ?? "初始化已取消。" })
      }
      await reload({ preserveStep: true })
    } catch (error) {
      setErrorInfo(setupErrorView(error))
    } finally {
      followAbort?.abort()
      setRunId(undefined)
      setWorking(false)
    }
  }

  onMount(() => {
    void (async () => {
      try {
        const next = await client.inspect()
        applyFacts(next)
        setVisibleStep(applyRuntimePreparationGate(stepFromSetup(resolveSetupStep(next)), runtimeReady()))
        if (next.state.status === "corrupt") {
          setErrorInfo({
            code: "SETUP_STATE_CORRUPT",
            message: "初始化状态文件不可读取；请修复或移除该文件后再继续。",
          })
        }
      } catch (error) {
        setErrorInfo(setupErrorView(error))
      } finally {
        setInitialized(true)
      }
    })()
  })

  onCleanup(() => followAbort?.abort())

  // The form-only calls below are guarded by `!isDone()`.
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-assertion
  const stepName = () => currentStep() as OnboardingStepName
  const currentPhase = () => getPhaseForStep(currentStep())
  const meta = () => getStepMetadata(currentStep())
  const content = () => getStepContent(currentStep())
  const guideSource = () => getStepGuideSource(currentStep())
  const isDone = () => currentStep() === "done"
  const isCurrentOptional = () => isDone() || isOptionalStep(stepName())

  const stepSatisfied = () => {
    const value = facts()
    if (!value) return false
    if (currentStep() === "system-check") {
      return value.home.foundation.ready && value.home.writable
    }
    if (currentStep() === "github-auth") return githubForkReady(value)
    if (currentStep() === "ontology-setup")
      return (
        value.ontology.status === "ready" &&
        value.ontology.items.length > 0 &&
        value.home.settings.valid &&
        value.home.settings.ellamaka.valid &&
        value.home.capabilities.ready
      )
    if (currentStep() === "create-space") return value.space.items.some((item) => item.verified)
    if (currentStep() === "runtime-preparation") return runtimeReady()
    if (currentStep() === "ai-provider") return value.credentials.providers.length > 0 || providerWasSkipped()
    return false
  }

  const prevEnabled = () => {
    if (isDone()) return true
    const index = ONBOARDING_STEPS.indexOf(stepName())
    return index > 0 && !working()
  }

  const handlePrev = () => {
    setErrorInfo(null)
    controller.setCurrentStep(currentStep())
    controller.prev()
    setVisibleStep(controller.getCurrentStep())
  }

  const nextLabel = () => {
    if (isDone()) return launching() ? "正在启动…" : "🚀 启动工作台"
    if (stepSatisfied()) return "下一步"
    if (stepName() === "system-check") return "初始化工作目录"
    if (stepName() === "github-auth") return "重新检测 GitHub 登录"
    if (stepName() === "ontology-setup") return "准备能力本体"
    if (stepName() === "create-space") return "创建工作空间"
    if (stepName() === "runtime-preparation") return "继续"
    if (stepName() === "ai-provider") return "保存配置"
    return "下一步"
  }

  const submitVisibleForm = () => {
    const form = document.getElementById(`onboarding-step-${stepName()}`)
    if (form instanceof HTMLFormElement) form.requestSubmit()
  }

  const handleNext = () => {
    if (isDone()) {
      doneLaunch?.()
      return
    }
    if (stepSatisfied()) {
      const next = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(stepName()) + 1] ?? "done"
      setVisibleStep(next)
      return
    }
    if (stepName() === "github-auth") {
      void refreshGithubIdentity()
      return
    }
    if (FORM_SUBMIT_STEPS.has(stepName())) submitVisibleForm()
  }

  return (
    <div class="onboarding-container">
      <div class="ob-window-chrome" />

      <header class="ob-header">
        <div class="ob-brand">
          <img
            src="/ellamaka-text-logo.png?v=2"
            class="ob-brand-logo"
            alt="Ellamaka Logo"
            onError={(event) => (event.currentTarget.style.display = "none")}
          />
          <span style={{ "font-weight": "700", "font-size": "15px", color: "#fff" }}>WopalSpace 配置向导</span>
        </div>

        <div class="ob-tracker">
          <For each={PHASE_CONFIGS}>
            {(phase) => (
              <button
                class={`ob-step-nav-pill ${currentPhase().phase === phase.phase ? "active" : ""} ${currentPhase().phase > phase.phase ? "completed" : ""}`}
                onClick={() => setVisibleStep(phase.steps[0] ?? "done")}
                disabled={phase.steps.length === 0 || !canNavigateToPhase(currentStep(), phase.phase, working())}
              >
                <span>
                  {currentPhase().phase > phase.phase ? "✓ " : ""}
                  {phase.phase}. {phase.title}
                </span>
              </button>
            )}
          </For>
        </div>
      </header>

      <main class="ob-main-wrapper">
        <div class="ob-main-content">
          <div class="ob-wizard-stage">
            <div class="ob-grid-layout">
              <div class="ob-step-info">
                <div class="ob-step-info-card">
                  <div class="ob-step-number">
                    阶段 {currentPhase().phase} / 4 · {currentPhase().title}
                  </div>
                  <h3 class="ob-step-info-title">{meta().title}</h3>
                  <StepGuide step={currentStep()} source={guideSource()} assets={STEP_GUIDE_ASSETS} />
                </div>
              </div>

              <div class="ob-card">
                <details class="ob-step-guide-mobile">
                  <summary>查看本步骤说明</summary>
                  <div class="ob-step-guide-mobile-content">
                    <h3 class="ob-step-info-title">{meta().title}</h3>
                    <StepGuide step={currentStep()} source={guideSource()} assets={STEP_GUIDE_ASSETS} />
                  </div>
                </details>

                <Show when={!isDone() && currentStep() !== "system-check"}>
                  <div class="ob-card-header" style={{ "justify-content": "center", "text-align": "center" }}>
                    <div class="ob-card-heading">
                      <h2 class="ob-card-title" style={{ "text-align": "center" }}>
                        {meta().title}
                      </h2>
                      <Show when={isCurrentOptional()}>
                        <span class="ob-optional-tag">可选</span>
                      </Show>
                    </div>
                    <p class="ob-card-description">{content()?.goal ?? meta().description}</p>
                  </div>
                </Show>

                <Show when={errorInfo()}>
                  <div class="ob-feedback-slot">
                    <div class="ob-error-banner" role="alert">
                      <div class="ob-error-indicator">!</div>
                      <div class="ob-error-text">
                        <div class="ob-error-heading">
                          <span class="ob-error-title">当前步骤未完成</span>
                          <Show when={errorInfo()?.code}>
                            <code class="ob-error-code">{errorInfo()?.code}</code>
                          </Show>
                        </div>
                        <div class="ob-error-message">{errorInfo()?.message}</div>
                        <Show when={errorInfo()?.suggestion}>
                          <div class="ob-error-message">{errorInfo()?.suggestion}</div>
                        </Show>
                      </div>
                    </div>
                  </div>
                </Show>

                <div class="ob-card-body">
                  <Show when={working() && progressMsg()}>
                    <ProgressDisplay phase={progressMsg()} />
                  </Show>
                  <Show when={initialized()} fallback={<ProgressDisplay phase="正在读取 Setup 服务状态…" />}>
                    <Show when={facts()} fallback={<ProgressDisplay phase="正在读取 Setup 服务状态…" />}>
                      <Switch>
                        <Match when={currentStep() === "system-check"}>
                          <FoundationStep
                            facts={facts()!}
                            working={working()}
                            onRun={(homePath) => void runFoundation(homePath)}
                          />
                        </Match>
                        <Match when={currentStep() === "github-auth"}>
                          <GithubAuthStep
                            facts={facts()!}
                            working={working()}
                            onRefreshIdentity={() => void refreshGithubIdentity()}
                            onContinueClone={() => void continueWithClone()}
                          />
                        </Match>
                        <Match when={currentStep() === "ontology-setup"}>
                          <OntologySetupStep
                            facts={facts()!}
                            working={working()}
                            onRun={(input) => void runOntology(input)}
                          />
                        </Match>
                        <Match when={currentStep() === "create-space"}>
                          <CreateSpaceStep
                            facts={facts()!}
                            working={working()}
                            onRun={(input) => void runSpace(input)}
                          />
                        </Match>
                        <Match when={currentStep() === "runtime-preparation"}>
                          <RuntimePreparationStep
                            onStart={() => setRuntimeReady(false)}
                            onReady={() => setRuntimeReady(true)}
                            onFailed={(message) => setErrorInfo({ code: "SETUP_RUNTIME_FAILED", message })}
                            onProgress={(message) => {
                              setProgressMsg(message)
                              appendLog(message)
                            }}
                          />
                        </Match>
                        <Match when={currentStep() === "ai-provider"}>
                          <AiProviderStep
                            facts={facts()!}
                            working={working()}
                            onSubmit={(input) => void runProvider(input)}
                            onSkip={() => void skipProvider()}
                          />
                        </Match>
                        <Match when={currentStep() === "done"}>
                          <DoneStep
                            launch={launch}
                            launching={launching()}
                            error={completionError()}
                            onRegisterLaunch={(fn) => (doneLaunch = fn)}
                          />
                        </Match>
                      </Switch>
                    </Show>
                  </Show>
                </div>

                <div class="ob-fixed-nav">
                  <button
                    type="button"
                    class="ob-button ob-button-secondary ob-nav-prev"
                    onClick={handlePrev}
                    disabled={!prevEnabled()}
                  >
                    上一步
                  </button>
                  <div class="ob-fixed-nav-center">
                    <Show when={working() && currentStep() !== "done" && runId()}>
                      <button type="button" class="ob-button ob-button-secondary" onClick={() => void handleCancel()}>
                        取消初始化
                      </button>
                    </Show>
                  </div>
                  <button
                    type="button"
                    class="ob-button ob-nav-next"
                    onClick={handleNext}
                    disabled={
                      working() ||
                      !initialized() ||
                      (isDone() && launching()) ||
                      (currentStep() === "runtime-preparation" && !runtimeReady())
                    }
                  >
                    {nextLabel()}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <LogDrawer
            logs={logs()}
            statusMsg={progressMsg() || (errorInfo() ? "需要处理" : "系统就绪")}
            onClear={() => setLogs([])}
          />
        </div>
      </main>
    </div>
  )
}
