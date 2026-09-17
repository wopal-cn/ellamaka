import { createSignal, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useOnboardingClient } from "../onboarding-client-context"

export interface StepProps {
  userName?: string
  onComplete: () => void
  onError: (msg: string | null) => void
  onStatusChange?: (status: "idle" | "working" | "success" | "error") => void
}

export function SystemCheckStep(props: StepProps) {
  const client = useOnboardingClient()
  const platform = usePlatform()
  const [isRunning, setIsRunning] = createSignal<boolean>(true)
  const [isPassed, setIsPassed] = createSignal<boolean>(false)
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null)
  const [wopalHome, setWopalHome] = createSignal<string>("")
  const [sysInfo, setSysInfo] = createSignal<{
    platform?: string
    arch?: string
    nodeVer?: string
    gitVer?: string
  }>({})

  // Read-only probe: inspects the current home WITHOUT advancing state or
  // writing any onboarding file. Only called on mount to show system info.
  const probe = async (targetPath?: string) => {
    const checkHome = targetPath ?? wopalHome()
    try {
      const res = await client.probe("system-info")
      const data = (res as Record<string, unknown>) || {}
      setSysInfo({
        platform: (data.platform as string) || "darwin",
        arch: (data.arch as string) || "arm64",
        nodeVer: (data.nodeVersion as string) || "v24.x",
        gitVer: (data.gitVersion as string) || "git version 2.x",
      })
      if (checkHome) setWopalHome(checkHome)
    } catch {
      // ignore probe failure — system info is cosmetic
    }
  }

  // Confirmation-time check: runs the system-check execute (which persists
  // WOPAL_HOME and writes onboarding state). Only called when the user
  // explicitly clicks "下一步".
  const runCheck = async (targetPath?: string): Promise<boolean> => {
    props.onError(null)
    props.onStatusChange?.("working")
    setIsRunning(true)
    setIsPassed(false)
    setErrorMsg(null)
    const checkHome = targetPath ?? wopalHome()
    try {
      const res = await client.executeStep("system-check", {
        customHomePath: checkHome || undefined,
      })
      if (res.status === "completed" || res.status === "reused") {
        setIsPassed(true)
        props.onStatusChange?.("success")
        const data = (res.result as Record<string, string>) || {}
        setSysInfo({
          platform: data.platform || "darwin",
          arch: data.arch || "arm64",
          nodeVer: data.embeddedNodeVersion || data.nodeVersion || "v24.x",
          gitVer: data.gitVersion || data.gitStatus || "git version 2.x",
        })
        if (data.wopalHome) {
          setWopalHome(data.wopalHome)
        }
        return true
      } else {
        const msg = res.error?.message ?? "系统环境检查失败。"
        setErrorMsg(msg)
        props.onStatusChange?.("error")
        props.onError(msg)
        return false
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg)
      props.onStatusChange?.("error")
      props.onError(msg)
      return false
    } finally {
      setIsRunning(false)
    }
  }

  onMount(async () => {
    props.onStatusChange?.("working")
    setIsRunning(true)
    try {
      const probeRes = await client.probe("home")
      const realHome =
        typeof probeRes.homePath === "string"
          ? probeRes.homePath
          : typeof probeRes.wopalHome === "string"
            ? probeRes.wopalHome
            : ""
      const home = realHome || ""
      setWopalHome(home)
      await probe(home || undefined)
    } catch {
      // ignore probe error
    } finally {
      setIsRunning(false)
      // Restore the root "idle" state so the 下一步 button re-enables after
      // the read-only probe completes. Without this, onMount's "working"
      // leaves the button permanently disabled.
      props.onStatusChange?.("idle")
    }
  })

  const handleBrowseHome = async () => {
    if (!platform.openDirectoryPickerDialog) return
    try {
      const result = await platform.openDirectoryPickerDialog({
        title: "选择 WOPAL_HOME 工作目录",
      })
      const selected = typeof result === "string" ? result : Array.isArray(result) ? result[0] : null
      if (selected) {
        setWopalHome(selected)
        setIsPassed(false)
        setErrorMsg(null)
        // Browse only selects the path — the actual check/write happens on "下一步".
        await probe(selected)
      }
    } catch {
      // ignore dialog cancel
    }
  }

  const handleInputChange = (val: string) => {
    setWopalHome(val)
    setIsPassed(false)
    setErrorMsg(null)
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    if (isRunning()) return
    const trimmed = wopalHome().trim()
    if (!trimmed) {
      setErrorMsg("请输入或选择一个工作目录。")
      props.onError("请输入或选择一个工作目录。")
      return
    }
    // The chosen home rides the execute input (`customHomePath`); the server
    // persists it as part of running the step.
    const passed = await runCheck(trimmed)
    if (passed) props.onComplete()
  }

  return (
    <form
      id="onboarding-step-system-check"
      class="ob-syscheck-content"
      onSubmit={handleSubmit}
    >
      {/* 1. Warm Greeting Header */}
      <div class="ob-syscheck-hero">
        <div class="ob-syscheck-emoji">👋</div>
        <h3 class="ob-syscheck-title">
          {props.userName ? `嗨，${props.userName}！欢迎来到 WopalSpace` : "欢迎来到 WopalSpace"}
        </h3>
      </div>

      {/* 2. Environment Inspection Card */}
      <div class="ob-syscheck-card">
        <div class="ob-result-row">
          <span class="ob-result-label">系统架构</span>
          <span class="ob-result-value">{sysInfo().platform || "darwin"} ({sysInfo().arch || "arm64"})</span>
        </div>
        <div class="ob-result-row">
          <span class="ob-result-label">Git</span>
          <span class="ob-result-value">{sysInfo().gitVer || "已准备"}</span>
        </div>
      </div>

      {/* 3. Working Directory Card */}
      <div class="ob-syscheck-card">
        <label class="ob-syscheck-home-label" for="syscheck-home-input">工作主目录 (WOPAL_HOME)</label>
        <input
          id="syscheck-home-input"
          type="text"
          class="ob-input ob-syscheck-home-input"
          value={wopalHome()}
          onInput={(e) => handleInputChange(e.currentTarget.value)}
          placeholder="~/.wopal"
          disabled={isRunning()}
        />
        <div class="ob-syscheck-home-actions">
          <Show when={platform.openDirectoryPickerDialog !== undefined}>
            <button
              type="button"
              class="ob-button ob-button-secondary ob-syscheck-browse"
              onClick={handleBrowseHome}
              disabled={isRunning()}
            >
              <span>📁</span>
              <span>选择 / 更改工作目录…</span>
            </button>
          </Show>
        </div>
      </div>

      <Show when={isRunning()}>
        <div class="ob-progress-container" style={{ padding: "16px 0" }}>
          <div class="ob-spinner" />
          <div class="ob-progress-phase">正在初始化并检查环境（首次检查需 5-10 秒）…</div>
        </div>
      </Show>

      <Show when={!isRunning() && errorMsg()}>
        <div class="ob-syscheck-error">
          <span class="ob-syscheck-error-icon">✗</span>
          <div>
            <div class="ob-syscheck-error-title">环境检查未通过</div>
            <div class="ob-syscheck-error-message">{errorMsg()}</div>
          </div>
        </div>
      </Show>
    </form>
  )
}
