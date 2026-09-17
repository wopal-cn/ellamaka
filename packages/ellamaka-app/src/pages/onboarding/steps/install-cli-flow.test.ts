import { describe, expect, test } from "bun:test"
import { formatInstallFailure, resolveInstallRetryTarget } from "./install-cli-flow"

describe("install-cli-flow", () => {
  test("formats engine network failures as actionable Chinese guidance", () => {
    const failure = formatInstallFailure("ellamaka", {
      code: "ENGINE_DOWNLOAD_FAILED",
      message: "Failed to download ellamaka engine",
      details: "fetch failed: ECONNRESET",
    })

    expect(failure.code).toBe("ENGINE_DOWNLOAD_FAILED")
    expect(failure.message).toBe("Ellamaka AI 引擎下载失败。")
    expect(failure.suggestion).toContain("网络连接或代理设置")
    expect(failure.suggestion).toContain("下方“重试安装”")
    expect(failure.details).toContain("ECONNRESET")
  })

  test("formats timeout failures without exposing raw millisecond errors", () => {
    const failure = formatInstallFailure("ellamaka", {
      code: "SETUP_OPERATION_TIMEOUT",
      message: "Operation 'install-engine' timed out after 300000ms.",
    })

    expect(failure.message).toBe("Ellamaka AI 引擎下载超时。")
    expect(failure.message).not.toContain("300000")
  })

  test("recognizes installer curl failures as network download failures", () => {
    const failure = formatInstallFailure("wopal", {
      code: "INSTALLATION_FAILED",
      message: "curl: (6) Could not resolve host: cdn.example.com",
    })

    expect(failure.message).toBe("Wopal CLI 下载失败。")
    expect(failure.suggestion).toContain("代理设置")
  })

  test("retries only Ellamaka when Wopal already succeeded", () => {
    expect(resolveInstallRetryTarget({ wopalReady: true, failedTool: "ellamaka" })).toBe("ellamaka")
    expect(resolveInstallRetryTarget({ wopalReady: false, failedTool: "ellamaka" })).toBe("wopal")
    expect(resolveInstallRetryTarget({ wopalReady: true, failedTool: "wopal" })).toBe("wopal")
  })
})
