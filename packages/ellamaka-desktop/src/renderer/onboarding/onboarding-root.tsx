import { createSignal, onMount, Show, Switch, Match, For } from "solid-js"
import {
  createStepController,
  getStepMetadata,
  getStepContent,
  ONBOARDING_STEPS,
  PHASE_CONFIGS,
  getPhaseForStep,
  isRetryActionVisible,
  isOptionalStep,
  type OnboardingStepName,
} from "./step-controller"
import { SystemCheckStep } from "./steps/system-check"
import { InstallCliStep } from "./steps/install-cli"
import { OntologySetupStep } from "./steps/ontology-setup"
import { AiProviderStep } from "./steps/ai-provider"
import { CreateSpaceStep } from "./steps/create-space"
import { MemoryConfigStep } from "./steps/memory-config"
import { DoneStep } from "./steps/done"
import { LogDrawer } from "./components/LogDrawer"
import { ProgressDisplay } from "./components/ProgressDisplay"
import { StepGuide } from "./components/StepGuide"
import { zhCN } from "./content/zh-CN"
import { getStepGuideSource, STEP_GUIDE_ASSETS } from "./content/step-guides"
import "./onboarding.css"

export interface LogEntry {
  text: string
  isError?: boolean
}

// Step categorization for nav button behavior
const FORM_SUBMIT_STEPS = new Set<OnboardingStepName>([
  "system-check",
  "install-cli",
  "ontology-setup",
  "create-space",
  "ai-provider",
  "memory-config",
])

export function OnboardingRoot() {
  const [currentStep, setCurrentStep] = createSignal<OnboardingStepName | "done">("system-check")
  const [progressMsg, setProgressMsg] = createSignal<string>("")
  const [errorInfo, setErrorInfo] = createSignal<{ code?: string; message: string; details?: string } | null>(null)
  const [logs, setLogs] = createSignal<LogEntry[]>([{ text: "[system] 初始化 Ellamaka Onboarding 环境..." }])
  const [working, setWorking] = createSignal(false)
  const [stepResult, setStepResult] = createSignal<{ success: boolean } | null>(null)
  const [doneLaunching, setDoneLaunching] = createSignal<boolean>(false)
  const [hasExistingSpaces, setHasExistingSpaces] = createSignal(false)
  const [maxUnlockedPhase, setMaxUnlockedPhase] = createSignal<number>(1)
  const [initialized, setInitialized] = createSignal(false)
  const [systemUserName, setSystemUserName] = createSignal<string>("")

  const controller = createStepController("system-check")

  // UI-only append. Messages that originate in the main process (step
  // progress broadcasts) are already written to onboarding.log by main; we
  // must NOT mirror them back or the file gets every message twice.
  const appendLog = (text: string, isError = false) => {
    if (!text.trim()) return
    const clean = text.replace(/\x1b\[[0-9;]*m/g, "")
    setLogs((prev) => [...prev.slice(-200), { text: `[${new Date().toLocaleTimeString()}] ${clean}`, isError }])
  }

  // Messages that originate in the renderer (navigation, state restore,
  // errors) have no main-side counterpart, so mirror them into the file to
  // keep the UI LogDrawer and onboarding.log consistent.
  const mirrorToFile = (text: string) => {
    if (!text.trim()) return
    void window.api.onboardingRendererLog(text).catch(() => {})
  }

  onMount(() => {
    // Mirror the boot banner (already seeded in the UI log) into the file so
    // onboarding.log records the start of this session the same way the UI does.
    void window.api.onboardingRendererLog("[system] 初始化 Ellamaka Onboarding 环境...").catch(() => {})

    const unsub = window.api.onOnboardingProgress((prog) => {
      const msg = prog.message || prog.phase || ""
      if (msg) {
        setProgressMsg(msg)
        appendLog(msg, prog.phase === "failed")
      }
      if (prog.suggestion) appendLog(`建议: ${prog.suggestion}`, prog.phase === "failed")
      if (prog.details) appendLog(prog.details, prog.phase === "failed")
    })

    void (async () => {
      try {
        const [state, userProbe] = await Promise.all([
          window.api.onboardingGetState(),
          window.api.onboardingProbe("system-user").catch(() => null),
        ])

        const probeResult = userProbe as { userName?: string } | null
        const name = probeResult?.userName?.trim()
        if (name) setSystemUserName(name)

        if (state && state.currentStep && !state.completed) {
          const savedStep = state.currentStep
          if (savedStep !== currentStep()) {
            setCurrentStep(savedStep)
            controller.setCurrentStep(savedStep)
            updateUnlockedPhase(savedStep)
            appendLog(`[system] 已自动从本地 onboarding.json 恢复当前进度: ${savedStep}`)
            mirrorToFile(`[system] 已自动从本地 onboarding.json 恢复当前进度: ${savedStep}`)
          }
        }
      } catch (err) {
        appendLog(`[warning] 获取步骤恢复状态失败: ${err instanceof Error ? err.message : String(err)}`)
        mirrorToFile(`[warning] 获取步骤恢复状态失败: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setInitialized(true)
      }
    })()

    return unsub
  })

  const updateUnlockedPhase = (step: OnboardingStepName | "done") => {
    const p = getPhaseForStep(step).phase
    if (p > maxUnlockedPhase()) {
      setMaxUnlockedPhase(p)
    }
  }

  const handleNext = () => {
    setErrorInfo(null)
    setStepResult(null)
    controller.setCurrentStep(currentStep())
    controller.next()
    const nextStep = controller.getCurrentStep()
    setCurrentStep(nextStep)
    updateUnlockedPhase(nextStep)
    appendLog(`[step] 进入步骤: ${getStepMetadata(nextStep).title}`)
    mirrorToFile(`[step] 进入步骤: ${getStepMetadata(nextStep).title}`)
    if (nextStep !== "done") {
      void window.api.onboardingSetCurrentStep(nextStep)
    }
  }

  const handlePrev = () => {
    setErrorInfo(null)
    setStepResult(null)
    controller.setCurrentStep(currentStep())
    controller.prev()
    const prevStep = controller.getCurrentStep()
    setCurrentStep(prevStep)
    appendLog(`[step] 返回步骤: ${getStepMetadata(prevStep).title}`)
    mirrorToFile(`[step] 返回步骤: ${getStepMetadata(prevStep).title}`)
    if (prevStep !== "done") {
      void window.api.onboardingSetCurrentStep(prevStep)
    }
  }

  const handleJumpPhase = (phaseNum: 1 | 2 | 3 | 4) => {
    if (phaseNum > maxUnlockedPhase()) return
    setErrorInfo(null)
    setStepResult(null)
    const config = PHASE_CONFIGS.find((p) => p.phase === phaseNum)
    if (!config || config.steps.length === 0) return
    const target = config.steps[0]
    setCurrentStep(target)
    controller.setCurrentStep(target)
    appendLog(`[step] 切换到阶段 ${phaseNum}: ${config.title}`)
    mirrorToFile(`[step] 切换到阶段 ${phaseNum}: ${config.title}`)
    if (target !== "done") {
      void window.api.onboardingSetCurrentStep(target)
    }
  }

  const handleSkip = async () => {
    setErrorInfo(null)
    setStepResult(null)
    const step = currentStep()
    if (step !== "done") {
      const res = await window.api.onboardingExecuteStep(step as OnboardingStepName, { skip: true })
      if (res.status === "failed") {
        handleError({ message: res.error?.message ?? "跳过失败" })
        return
      }
    }
    handleNext()
  }

  const handleError = (err: { code?: string; message: string; details?: string } | string | null) => {
    if (!err) {
      setErrorInfo(null)
      setStepResult(null)
      return
    }
    const info = typeof err === "string" ? { message: err } : err
    setErrorInfo(info)
    setStepResult({ success: false })
    appendLog(`[ERROR] ${info.message}`, true)
    mirrorToFile(`[ERROR] ${info.message}`)
    if (info.details) {
      appendLog(info.details, true)
      mirrorToFile(info.details)
    }
  }

  const handleRetry = () => {
    setErrorInfo(null)
    setStepResult(null)
    const step = currentStep()
    if (step === "done") return
    // Trigger the step's own form submit / re-run logic
    const form = document.getElementById(`onboarding-step-${step}`)
    if (form instanceof HTMLFormElement) {
      form.requestSubmit()
    } else {
      // For steps without a form (e.g. runtime-setup wraps in a form but may not match),
      // fallback: dispatch a custom event so auto-advance steps can re-mount
      const event = new CustomEvent("ob-retry", { bubbles: true })
      document.dispatchEvent(event)
    }
  }

  const handleStepStatusChange = (status: "idle" | "working" | "success" | "error") => {
    if (status === "working") {
      setWorking(true)
      setStepResult(null)
    } else if (status === "idle") {
      setWorking(false)
      setStepResult(null)
    } else if (status === "success") {
      setWorking(false)
      setStepResult({ success: true })
    } else {
      setWorking(false)
      setStepResult({ success: false })
    }
  }

  const currentPhase = () => getPhaseForStep(currentStep())
  const meta = () => getStepMetadata(currentStep())
  const content = () => getStepContent(currentStep())
  const guideSource = () => getStepGuideSource(currentStep())

  const isDone = () => currentStep() === "done"

  const isCurrentOptional = () => {
    if (isDone()) return false
    const step = currentStep()
    // create-space optionality is determined by the component itself (existing spaces)
    if (step === "create-space") return false
    return isOptionalStep(step as OnboardingStepName, { hasExistingSpaces: hasExistingSpaces() })
  }

  // --- Navigation button state derivation ---
  const stepName = () => currentStep() as OnboardingStepName

  // Previous button: enabled when there is a real previous step and not working
  const prevEnabled = () => {
    if (isDone()) return true // allow going back from done
    const idx = ONBOARDING_STEPS.indexOf(stepName())
    return idx > 0 && !working()
  }

  // Retry button: visible when step failed; disabled while working
  const retryVisible = () => {
    return isRetryActionVisible(currentStep(), {
      working: working(),
      success: stepResult()?.success,
    })
  }

  const retryEnabled = () => !working() && !isDone()

  const retryLabel = () => (stepName() === "install-cli" ? "重试安装" : "重试")

  // Next button: visible on all steps, including done (launches workbench)
  const nextVisible = () => {
    if (isDone()) return true
    if (stepResult()?.success === false) return false
    return true
  }

  const nextEnabled = () => {
    if (working()) return false
    if (isDone()) return !doneLaunching()
    // For form-submit steps: enabled when step succeeded (advance) or idle (submit)
    if (FORM_SUBMIT_STEPS.has(stepName())) {
      if (stepResult()?.success === true) return true // advance to next step
      if (stepResult()?.success === false) return false // need retry first
      return true // idle — submit
    }
    return false
  }

  const nextLabel = () => {
    if (isDone()) {
      return doneLaunching() ? "正在启动…" : "🚀 启动工作台"
    }
    if (stepResult()?.success === true) return "下一步"
    // Step-specific action labels for the primary submit action
    const step = stepName()
    if (step === "system-check") return "下一步"
    if (step === "install-cli") return "开始安装"
    if (step === "ontology-setup") return "准备能力本体"
    if (step === "ai-provider") return "保存配置"
    if (step === "create-space") return "创建工作空间"
    if (step === "memory-config") return "保存配置"
    return "下一步"
  }

  const handleNextClick = () => {
    if (isDone()) {
      const launchBtn = document.querySelector<HTMLButtonElement>(".ob-done-launch-button")
      if (launchBtn && !launchBtn.disabled) {
        launchBtn.click()
      }
      return
    }
    // If step already succeeded, advance to next step directly
    if (stepResult()?.success === true) {
      handleNext()
      return
    }
    if (FORM_SUBMIT_STEPS.has(stepName())) {
      // Step not yet executed: submit the form to trigger step logic
      const form = document.getElementById(`onboarding-step-${stepName()}`)
      if (form instanceof HTMLFormElement) {
        form.requestSubmit()
      } else {
        handleNext()
      }
    } else {
      handleNext()
    }
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
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
          <span style={{ "font-weight": "700", "font-size": "15px", color: "#fff" }}>WopalSpace 配置向导</span>
        </div>

        {/* 4-Phase Tracker Bar */}
        <div class="ob-tracker">
          <For each={PHASE_CONFIGS}>
            {(phaseConfig) => {
              const isActive = () => currentPhase().phase === phaseConfig.phase
              const isPast = () => currentPhase().phase > phaseConfig.phase
              const isLocked = () => phaseConfig.phase > maxUnlockedPhase()
              return (
                <button
                  class={`ob-step-nav-pill ${isActive() ? "active" : ""} ${isPast() ? "completed" : ""} ${isLocked() ? "locked" : ""}`}
                  onClick={() => handleJumpPhase(phaseConfig.phase)}
                  disabled={isLocked() || working()}
                  title={
                    isLocked()
                      ? `阶段 ${phaseConfig.phase}: 完成前置阶段后解锁`
                      : `阶段 ${phaseConfig.phase}: ${phaseConfig.title}`
                  }
                >
                  <span>
                    {isLocked() ? "🔒 " : isPast() ? "✓ " : ""}
                    {phaseConfig.phase}. {phaseConfig.title}
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </header>

      <main class="ob-main-wrapper">
        <div class="ob-main-content">
          <div class="ob-wizard-stage">
            <div class="ob-grid-layout">
              {/* Left: Phase Info */}
              <div class="ob-step-info">
                <div class="ob-step-info-card">
                  <div class="ob-step-number">
                    阶段 {currentPhase().phase} / 4 · {currentPhase().title}
                  </div>
                  <h3 class="ob-step-info-title">{meta().title}</h3>
                  <StepGuide step={currentStep()} source={guideSource()} assets={STEP_GUIDE_ASSETS} />
                </div>
              </div>

              {/* Right: Card View */}
              <div class="ob-card">
                <details class="ob-step-guide-mobile">
                  <summary>查看本步骤说明</summary>
                  <div class="ob-step-guide-mobile-content">
                    <div class="ob-step-number">
                      阶段 {currentPhase().phase} / 4 · {currentPhase().title}
                    </div>
                    <h3 class="ob-step-info-title">{meta().title}</h3>
                    <StepGuide step={currentStep()} source={guideSource()} assets={STEP_GUIDE_ASSETS} />
                  </div>
                </details>

                <Show when={currentStep() !== "done" && currentStep() !== "system-check"}>
                  <div class="ob-card-header" style={{ "justify-content": "center", "text-align": "center" }}>
                    <div class="ob-card-heading">
                      <h2 class="ob-card-title" style={{ "text-align": "center" }}>
                        {meta().title}
                      </h2>
                      <Show when={isCurrentOptional()}>
                        <span class="ob-optional-tag">可选</span>
                      </Show>
                    </div>
                    <Show when={currentStep() !== "memory-config" && currentStep() !== "ontology-setup"}>
                      <p class="ob-card-description">{content()?.goal ?? meta().description}</p>
                    </Show>
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
                      </div>
                      <button
                        type="button"
                        class="ob-error-close"
                        aria-label="关闭错误提示"
                        onClick={() => setErrorInfo(null)}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </Show>

                {/* Card Body - Scrollable */}
                <div class="ob-card-body">
                  <Show
                    when={initialized()}
                    fallback={
                      <div class="ob-progress-container" style={{ padding: "40px 0", "text-align": "center" }}>
                        <div
                          class="ob-spinner"
                          style={{ width: "24px", height: "24px", "border-width": "2px", margin: "0 auto 12px" }}
                        />
                        <div style={{ "font-size": "13px", color: "var(--ob-text-subtle)" }}>正在恢复当前配置进度…</div>
                      </div>
                    }
                  >
                    <Switch>
                      {/* Phase 1 Steps - rendered directly so currentStep reflects sub-step */}
                      <Match when={currentStep() === "system-check"}>
                        <SystemCheckStep
                          userName={systemUserName()}
                          onComplete={handleNext}
                          onError={handleError}
                          onStatusChange={handleStepStatusChange}
                        />
                      </Match>
                      <Match when={currentStep() === "install-cli"}>
                        <InstallCliStep
                          onComplete={handleNext}
                          onError={handleError}
                          onStatusChange={handleStepStatusChange}
                        />
                      </Match>

                      {/* Phase 2 Steps */}
                      <Match when={currentStep() === "ontology-setup"}>
                        <OntologySetupStep
                          onComplete={handleNext}
                          onError={handleError}
                          onStatusChange={handleStepStatusChange}
                        />
                      </Match>

                      {/* Phase 3 Steps */}
                      <Match when={currentStep() === "create-space"}>
                        <CreateSpaceStep
                          onComplete={handleNext}
                          onError={handleError}
                          onStatusChange={handleStepStatusChange}
                        />
                      </Match>
                      <Match when={currentStep() === "ai-provider"}>
                        <AiProviderStep
                          onComplete={handleNext}
                          onError={handleError}
                          onStatusChange={handleStepStatusChange}
                        />
                      </Match>
                      <Match when={currentStep() === "memory-config"}>
                        <MemoryConfigStep
                          onComplete={handleNext}
                          onError={handleError}
                          onStatusChange={handleStepStatusChange}
                        />
                      </Match>

                      {/* Phase 4 Steps */}
                      <Match when={currentStep() === "done"}>
                        <DoneStep onLaunchingChange={setDoneLaunching} />
                      </Match>
                    </Switch>
                  </Show>
                </div>

                {/* Fixed Navigation Bar — always visible at card bottom */}
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
                    <Show when={isCurrentOptional() && !working() && stepResult()?.success !== true}>
                      <button type="button" class="ob-button ob-button-secondary" onClick={handleSkip}>
                        跳过本步骤
                      </button>
                    </Show>
                  </div>

                  <Show when={!working() && retryVisible()}>
                    <button
                      type="button"
                      class="ob-button ob-retry-button"
                      onClick={handleRetry}
                      disabled={!retryEnabled()}
                    >
                      {retryLabel()}
                    </button>
                  </Show>

                  <Show when={!working() && nextVisible()}>
                    <button
                      type="button"
                      class="ob-button ob-nav-next"
                      onClick={handleNextClick}
                      disabled={!nextEnabled()}
                    >
                      {nextLabel()}
                    </button>
                  </Show>
                </div>
              </div>
            </div>
          </div>

          <LogDrawer logs={logs()} statusMsg={progressMsg() || "系统就绪"} onClear={() => setLogs([])} />
        </div>
      </main>

      <footer class="ob-footer">
        <div>Wopal.cn &copy; 2026</div>
      </footer>
    </div>
  )
}
