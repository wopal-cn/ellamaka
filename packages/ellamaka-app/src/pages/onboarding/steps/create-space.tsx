import { createEffect, createSignal, onCleanup, onMount, Show, For } from "solid-js"
import { usePlatform } from "@/context/platform"
import { ProgressDisplay } from "../components/ProgressDisplay"
import { ResultPanel } from "../components/ResultPanel"
import { useOnboardingClient } from "../onboarding-client-context"

export interface StepProps {
  onStatusChange?: (status: "idle" | "working" | "success" | "error") => void
  onComplete: () => void
  onSkip?: () => void
  /** Report the primary submit action's label for the shared bottom nav bar. */
  onPrimaryLabelChange?: (label: string | null) => void
  onError: (error: {
    code?: string
    message: string
    details?: string
  } | string | null) => void
}

interface AvailableType {
  type: string
  description?: string | null
}

interface SpaceEntry {
  name: string
  path: string
  type?: string | null
}

interface SpaceResult {
  name: string
  path: string
  type: string
  status: "completed" | "reused"
  message?: string
}

export function CreateSpaceStep(props: StepProps) {
  const client = useOnboardingClient()
  const platform = usePlatform()
  const [spaceDir, setSpaceDir] = createSignal<string>("")
  const [spaceType, setSpaceType] = createSignal<string>("")
  const [availableTypes, setAvailableTypes] = createSignal<AvailableType[]>([])
  const [existingSpaces, setExistingSpaces] = createSignal<SpaceEntry[]>([])
  const [isSubmitting, setIsSubmitting] = createSignal<boolean>(false)
  const [isLoading, setIsLoading] = createSignal<boolean>(true)
  const [probeError, setProbeError] = createSignal<string | null>(null)
  const [resultInfo, setResultInfo] = createSignal<SpaceResult | null>(null)

  const [showCreateForm, setShowCreateForm] = createSignal<boolean>(false)

  const loadEnvironment = async () => {
    props.onError(null)
    setProbeError(null)
    setIsLoading(true)
    try {
      const envData = await client.probe("environment")
      const error = typeof envData.error === "string" ? envData.error : null
      if (error) throw new Error(error)

      const types = Array.isArray(envData.availableTypes)
        ? envData.availableTypes as AvailableType[]
        : []
      if (types.length === 0) {
        throw new Error("未检测到可用的空间类型，请返回上一步重新初始化。")
      }
      setAvailableTypes(types)
      if (!types.some((item) => item.type === spaceType())) {
        setSpaceType(types[0].type)
      }

      // Probing is read-only: existing spaces are listed for the user to
      // confirm, never auto-skipped. The step is marked done only when the
      // user submits (either "next" to reuse, or a create form).
      const spaces = Array.isArray(envData.spaces)
        ? envData.spaces as SpaceEntry[]
        : []
      setExistingSpaces(spaces)

      const defaultPath = typeof envData.defaultSpacePath === "string"
        ? envData.defaultSpacePath
        : ""
      if (defaultPath && !spaceDir()) {
        setSpaceDir(defaultPath)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setProbeError(message)
      props.onStatusChange?.("error")
      props.onError(message)
    } finally {
      setIsLoading(false)
    }
  }

  onMount(() => {
    void loadEnvironment()
  })

  // The shared bottom nav bar owns the primary button. When existing spaces are
  // listed, that button reuses them rather than creating a new space, so its
  // label must say so instead of the misleading "创建工作空间".
  createEffect(() => {
    const blocked = isLoading() || probeError() || resultInfo()
    const reusesExisting = existingSpaces().length > 0 && !showCreateForm()
    props.onPrimaryLabelChange?.(blocked ? null : reusesExisting ? "使用已有空间" : null)
  })

  onCleanup(() => props.onPrimaryLabelChange?.(null))

  const handleSkipCreate = async () => {
    props.onError(null)
    props.onStatusChange?.("working")
    setIsSubmitting(true)
    try {
      const res = await client.executeStep("create-space", { skip: true })
      if (res.status === "skipped" || res.status === "completed" || res.status === "reused") {
        props.onStatusChange?.("success")
        props.onComplete()
      } else {
        props.onStatusChange?.("error")
        props.onError(res.error?.message ?? "无法复用现有工作空间。")
      }
    } catch (err) {
      props.onStatusChange?.("error")
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    if (existingSpaces().length > 0 && !showCreateForm() && !resultInfo()) {
      await handleSkipCreate()
      return
    }

    if (!spaceDir().trim()) {
      props.onStatusChange?.("error")
      props.onError("请选择或输入工作空间目录。")
      return
    }
    if (!spaceType() || availableTypes().length === 0) {
      props.onStatusChange?.("error")
      props.onError("能力类型不可用，请返回上一步重新配置。")
      return
    }

    props.onError(null)
    props.onStatusChange?.("working")
    setIsSubmitting(true)

    try {
      const res = await client.executeStep("create-space", {
        path: spaceDir().trim(),
        type: spaceType(),
      })
      if (res.status === "completed" || res.status === "reused") {
        const result = res.result ?? {}
        setResultInfo({
          name: typeof result.spaceName === "string" ? result.spaceName : spaceDir().split("/").filter(Boolean).at(-1) ?? "Space",
          path: typeof result.spacePath === "string" ? result.spacePath : spaceDir().trim(),
          type: spaceType(),
          status: res.status,
          message: typeof result.message === "string" ? result.message : undefined,
        })
        props.onStatusChange?.("success")
      } else {
        props.onStatusChange?.("error")
        const message = res.error?.message ?? "工作空间创建失败。"
        const details = [
          res.error?.suggestion ? `建议: ${res.error.suggestion}` : "",
          res.error?.details ?? "",
        ].filter(Boolean).join("\n")
        props.onError({
          code: res.error?.code,
          message,
          details: details || undefined,
        })
      }
    } catch (err) {
      props.onStatusChange?.("error")
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleBrowse = async () => {
    if (!platform.openDirectoryPickerDialog) return
    try {
      const result = await platform.openDirectoryPickerDialog({
        title: "选择工作空间根目录",
      })
      if (typeof result === "string") {
        setSpaceDir(result)
      } else if (Array.isArray(result) && result[0]) {
        setSpaceDir(result[0])
      }
    } catch {
      // ignore dialog cancel
    }
  }

  return (
    <form id="onboarding-step-create-space" onSubmit={handleSubmit} class="ob-step-content">
      <Show when={isLoading()}>
        <ProgressDisplay phase="正在检测已有工作空间与能力类型…" />
      </Show>

      <Show when={!isLoading() && probeError()}>
        <div class="ob-result-summary">
          <div class="ob-result-icon ob-result-error">✗</div>
          <div class="ob-result-title">工作空间环境检查未通过</div>
          <div class="ob-result-subtitle">{probeError()}</div>
          <div class="ob-credential-actions">
            <button type="button" class="ob-button" onClick={() => void loadEnvironment()}>
              重新检查
            </button>
          </div>
        </div>
      </Show>

      <Show when={resultInfo()}>
        <ResultPanel title={resultInfo()?.status === "reused" ? "已复用现有工作空间" : "工作空间已创建"}>
          <div class="ob-result-details">
            <div class="ob-result-row">
              <span class="ob-result-label">名称</span>
              <span class="ob-result-value">{resultInfo()?.name}</span>
            </div>
            <div class="ob-result-row">
              <span class="ob-result-label">路径</span>
              <span class="ob-result-value ob-result-mono">{resultInfo()?.path}</span>
            </div>
            <div class="ob-result-row">
              <span class="ob-result-label">类型</span>
              <span class="ob-result-value">{resultInfo()?.type}</span>
            </div>
          </div>
        </ResultPanel>
      </Show>

      {/* Show existing spaces clean summary card when spaces exist and user is not creating a new one */}
      <Show when={!isLoading() && !probeError() && !resultInfo() && existingSpaces().length > 0 && !showCreateForm()}>
        <ResultPanel
          title="已检测到现有工作空间"
          actions={
            <button
              type="button"
              class="ob-button ob-button-secondary"
              onClick={() => {
                setShowCreateForm(true)
                props.onStatusChange?.("idle")
              }}
            >
              + 创建新工作空间
            </button>
          }
        >
          <div class="ob-result-details">
            <For each={existingSpaces()}>
              {(space) => (
                <div class="ob-result-row">
                  <span class="ob-result-label">{space.name}</span>
                  <span class="ob-result-value ob-result-mono">
                    {space.path} {space.type ? `[${space.type}]` : ""}
                  </span>
                </div>
              )}
            </For>
          </div>
        </ResultPanel>
      </Show>

      {/* Show create space form when no existing space or user chose to create new */}
      <Show when={!isLoading() && !probeError() && !resultInfo() && (existingSpaces().length === 0 || showCreateForm())}>
        <Show when={existingSpaces().length > 0}>
          <div>
            <button
              type="button"
              class="ob-button ob-button-secondary"
              onClick={() => {
                setShowCreateForm(false)
                props.onStatusChange?.("success")
              }}
            >
              ← 返回使用已有空间
            </button>
          </div>
        </Show>

        <div class="ob-form-group">
          <label class="ob-label">工作空间目录</label>
          <div class="ob-input-row" style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              class="ob-input"
              style={{ flex: 1 }}
              value={spaceDir()}
              onInput={(e) => setSpaceDir(e.currentTarget.value)}
              placeholder="~/WopalSpace"
              disabled={isSubmitting()}
            />
            <Show when={platform.openDirectoryPickerDialog !== undefined}>
              <button
                type="button"
                class="ob-button ob-button-secondary"
                onClick={handleBrowse}
                disabled={isSubmitting()}
                style={{ padding: "0 14px", "white-space": "nowrap", "font-size": "13px" }}
              >
                选择目录
              </button>
            </Show>
          </div>
          <p style={{ "font-size": "12px", color: "var(--ob-text-subtle)", "margin-top": "6px" }}>
            该目录将承载项目文件与 <code>.wopal-space/</code> 空间配置。
          </p>
        </div>

        <div class="ob-form-group">
          <label class="ob-label" for="space-type-select">
            空间类型
          </label>
          <select
            id="space-type-select"
            class="ob-input"
            value={spaceType()}
            onChange={(e) => setSpaceType(e.currentTarget.value)}
            disabled={isSubmitting() || isLoading()}
            style={{ "text-transform": "capitalize" }}
          >
            <Show when={isLoading()}>
              <option value="">正在加载类型…</option>
            </Show>
            <For each={availableTypes()}>
              {(t) => (
                <option value={t.type}>
                  {t.description ? `${t.type} · ${t.description}` : t.type}
                </option>
              )}
            </For>
          </select>
        </div>
      </Show>
    </form>
  )
}
