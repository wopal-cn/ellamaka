import { createSignal, Show } from "solid-js"
import { zhCN } from "../content/zh-CN"

export interface ErrorCardProps {
  /** Stable error code for mapping */
  code?: string
  /** User-friendly Chinese title */
  title: string
  /** What happened */
  message: string
  /** Impact description */
  impact?: string
  /** Suggested action */
  action?: string
  /** Technical details (stderr, stack, etc.) */
  technicalDetails?: string
  /** Whether retry is available */
  onRetry?: () => void
  /** Whether skip is available */
  onSkip?: () => void
}

const ERROR_MAP: Record<string, { title: string; impact: string; action: string }> = {
  GIT_NOT_FOUND: {
    title: "未找到 Git",
    impact: "WopalSpace 需要 Git 来管理本体仓库和空间版本。",
    action: "请先安装 Git，然后重新检查。",
  },
  NETWORK_OFFLINE: {
    title: "网络连接失败",
    impact: "无法下载必要的组件和本体仓库。",
    action: "请检查网络连接，然后重试。",
  },
  WOPAL_HOME_NOT_WRITABLE: {
    title: "目录权限不足",
    impact: "无法在选定位置创建 Wopal 运行时文件。",
    action: "请选择一个你有写入权限的目录，或修改当前目录权限。",
  },
  INSUFFICIENT_DISK_SPACE: {
    title: "磁盘空间不足",
    impact: "安装 WopalSpace 需要至少 500MB 可用空间。",
    action: "请清理磁盘空间后重试。",
  },
  INSTALLER_DOWNLOAD_FAILED: {
    title: "安装程序下载失败",
    impact: "无法获取 Wopal CLI 安装脚本。",
    action: "请检查网络连接，或稍后重试。",
  },
  INSTALLATION_FAILED: {
    title: "安装失败",
    impact: "Wopal CLI 未能正确安装。",
    action: "请查看技术详情了解原因，然后重试。",
  },
  SETUP_ENGINE_FAILED: {
    title: "引擎安装失败",
    impact: "Ellamaka 引擎未能正确安装。",
    action: "请检查网络连接和磁盘空间，然后重试。",
  },
  SETUP_ONTOLOGY_PREPARE_FAILED: {
    title: "本体准备失败",
    impact: "无法获取或准备本体仓库。",
    action: "请检查网络连接和 GitHub 认证状态，然后重试。",
  },
  SETUP_RUNTIME_PREPARE_FAILED: {
    title: "运行时准备失败",
    impact: "全局设置或基础能力未能正确配置。",
    action: "请检查本体仓库完整性，然后重试。",
  },
  SETUP_SPACE_FAILED: {
    title: "空间创建失败",
    impact: "无法初始化工作空间。",
    action: "请检查路径权限和类型选择，然后重试。",
  },
  ONBOARDING_NOT_READY: {
    title: "运行时未就绪",
    impact: "部分组件尚未正确配置，无法完成设置。",
    action: "请返回相应步骤完成配置，或查看日志了解详情。",
  },
}

export function ErrorCard(props: ErrorCardProps) {
  const [showDetails, setShowDetails] = createSignal(false)
  const mapped = () => (props.code ? ERROR_MAP[props.code] : undefined)

  const displayTitle = () => props.title || mapped()?.title || "发生错误"
  const displayImpact = () => props.impact || mapped()?.impact || "当前步骤未能完成。"
  const displayAction = () => props.action || mapped()?.action || "请重试或查看日志了解详情。"

  const handleCopyDetails = async () => {
    const details = [
      `Error: ${props.code ?? "UNKNOWN"}`,
      `Message: ${props.message}`,
      props.technicalDetails ? `\nTechnical Details:\n${props.technicalDetails}` : "",
    ].join("\n")
    try {
      await navigator.clipboard.writeText(details)
    } catch {
      // ignore
    }
  }

  return (
    <div class="ob-error-card">
      <div class="ob-error-card-header">
        <span class="ob-error-icon">⚠️</span>
        <span class="ob-error-title">{displayTitle()}</span>
      </div>

      <div class="ob-error-section">
        <div class="ob-error-label">{zhCN.errors.title}</div>
        <div class="ob-error-message">{props.message}</div>
      </div>

      <div class="ob-error-section">
        <div class="ob-error-label">{zhCN.errors.impact}</div>
        <div class="ob-error-impact">{displayImpact()}</div>
      </div>

      <div class="ob-error-section">
        <div class="ob-error-label">{zhCN.errors.action}</div>
        <div class="ob-error-action">{displayAction()}</div>
      </div>

      <Show when={props.technicalDetails}>
        <div class="ob-error-details-toggle">
          <button
            class="ob-button-secondary ob-button-small"
            onClick={() => setShowDetails(!showDetails())}
          >
            {showDetails() ? "隐藏" : "显示"} {zhCN.errors.technicalDetails}
          </button>
          <button
            class="ob-button-secondary ob-button-small"
            onClick={handleCopyDetails}
          >
            {zhCN.actions.copy}
          </button>
        </div>
        <Show when={showDetails()}>
          <pre class="ob-error-details">{props.technicalDetails}</pre>
        </Show>
      </Show>
    </div>
  )
}
