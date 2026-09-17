export type InstallTool = "wopal" | "ellamaka"

export interface RawInstallFailure {
  code?: string
  message?: string
  details?: string
  suggestion?: string
}

export interface InstallFailure {
  code?: string
  message: string
  details?: string
  suggestion?: string
}

const TIMEOUT_PATTERN = /timeout|timed out|stalled|超时|无响应/i
const NETWORK_PATTERN = /download|network|fetch|socket|curl|could not resolve|econn|enotfound|eai_again|网络|下载/i

export function formatInstallFailure(tool: InstallTool, error: RawInstallFailure): InstallFailure {
  const fallback = tool === "wopal" ? "Wopal CLI 安装失败。" : "Ellamaka AI 引擎安装失败。"
  const evidence = [error.code, error.message, error.details].filter(Boolean).join(" ")
  const timedOut = TIMEOUT_PATTERN.test(evidence)
  const networkFailure = timedOut || NETWORK_PATTERN.test(evidence)

  if (!networkFailure) {
    return {
      code: error.code,
      message: error.message || fallback,
      details: error.details,
      suggestion: error.suggestion,
    }
  }

  const component = tool === "wopal" ? "Wopal CLI" : "Ellamaka AI 引擎"
  const separator = tool === "wopal" ? " " : ""
  return {
    code: error.code,
    message: timedOut ? `${component}${separator}下载超时。` : `${component}${separator}下载失败。`,
    details: error.details,
    suggestion: "请检查网络连接或代理设置，确认可以访问下载服务后，点击下方“重试安装”。",
  }
}

export function resolveInstallRetryTarget(input: {
  wopalReady: boolean
  failedTool: InstallTool | null
}): InstallTool {
  return input.wopalReady && input.failedTool === "ellamaka" ? "ellamaka" : "wopal"
}
