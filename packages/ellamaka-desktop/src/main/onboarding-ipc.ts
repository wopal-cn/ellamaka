import { resolveOnboardingMode } from "./onboarding-gate"
import {
  createDefaultOnboardingState,
  markCompleted,
  markStarted,
  ONBOARDING_STEPS,
  readOnboardingState,
  updateStep,
  writeOnboardingState,
  advanceToNextStep,
  rewindToStep,
  navigateToStep,
  setCurrentStep,
  type OnboardingStepName,
} from "./onboarding-state"
import { installWopalCli } from "./bootstrap-installer"
import { runSetupOperation } from "./setup-machine-client"
import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir, userInfo } from "node:os"
import { getUserShell, loadShellEnv } from "./shell-env"
import type { OnboardingStepResult } from "../preload/types"

import { statfsSync } from "node:fs"
import { getOnboardingLogger } from "./onboarding-logger"
import { getReleaseInfo } from "./release-info"

export function resolveSystemUserName(): string {
  try {
    const res = spawnSync("git", ["config", "user.name"], { encoding: "utf8" })
    if (res.status === 0 && res.stdout?.trim()) {
      return res.stdout.trim()
    }
  } catch {}

  try {
    const info = userInfo()
    if (info?.username?.trim()) {
      return info.username.trim()
    }
  } catch {}

  return process.env.USER || process.env.USERNAME || process.env.LOGNAME || ""
}

export async function performSystemCheck(homePath: string): Promise<OnboardingStepResult> {
  // 1. Check Git binary
  let gitVersion: string | null = null
  try {
    const check = spawnSync("git", ["--version"])
    if (check.status === 0) {
      gitVersion = check.stdout.toString().trim()
    }
  } catch {}

  if (!gitVersion) {
    return {
      status: "failed",
      error: {
        code: "GIT_NOT_FOUND",
        message: "Git CLI binary was not found on system PATH. WopalSpace requires Git. Please install Git and try again.",
      },
    }
  }

  // 2. Check WOPAL_HOME writable
  try {
    if (!existsSync(homePath)) {
      mkdirSync(homePath, { recursive: true })
    }
    accessSync(homePath, constants.W_OK)
  } catch (err) {
    return {
      status: "failed",
      error: {
        code: "WOPAL_HOME_NOT_WRITABLE",
        message: `Target WOPAL_HOME directory '${homePath}' is not writable: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }

  // 3. Check Network connectivity to R2 CDN (with fallback & tolerant timeout)
  let networkOk = false
  const cdnUrl = "https://download.coursedao.com/wopal-cli/latest/manifest.json"
  
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(cdnUrl, {
        method: attempt === 0 ? "HEAD" : "GET",
        headers: attempt === 1 ? { Range: "bytes=0-0" } : undefined,
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.ok || res.status < 500) {
        networkOk = true
        break
      }
    } catch {
      // Retry next attempt
    }
  }

  // Fallback check to general internet if CDN attempt timed out
  if (!networkOk) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch("https://1.1.1.1", { method: "HEAD", signal: controller.signal })
      clearTimeout(timer)
      if (res.ok || res.status < 500) {
        // General internet is reachable, tolerate CDN latency warning
        networkOk = true
      }
    } catch {
      networkOk = false
    }
  }

  if (!networkOk) {
    return {
      status: "failed",
      error: {
        code: "NETWORK_OFFLINE",
        message: "Failed to connect to Wopal release CDN (download.coursedao.com). Please check your internet connection.",
      },
    }
  }

  // 4. Check 500MB disk space
  try {
    const stat = statfsSync(homePath)
    const freeSpace = stat.bavail * stat.bsize
    if (freeSpace < 500 * 1024 * 1024) {
      return {
        status: "failed",
        error: {
          code: "INSUFFICIENT_DISK_SPACE",
          message: `Insufficient disk space. Required: 500MB. Available: ${(freeSpace / 1024 / 1024).toFixed(1)}MB`,
        },
      }
    }
  } catch (err) {
    // Ignore statfs errors (e.g. on unsupported systems)
  }

  return {
    status: "completed",
    result: {
      platform: process.platform,
      arch: process.arch,
      embeddedNodeVersion: process.version,
      gitVersion,
      networkStatus: "Connected (R2 CDN Reachable)",
      wopalHome: homePath,
      userName: resolveSystemUserName(),
    },
  }
}

export interface GithubTokenDetectionDeps {
  env?: NodeJS.ProcessEnv
  loadUserShellEnv?: () => NodeJS.ProcessEnv
  readGhToken?: () => string | null
}

export interface GithubCliProbe {
  installed: boolean
  authenticated: boolean
  account: string | null
}

export interface GithubAuthenticationProbeDeps extends GithubTokenDetectionDeps {
  probeGhCli?: () => GithubCliProbe
  verifyGithubToken?: (token: string) => Promise<{ account: string | null; valid: boolean }>
  broadcastProgress?: (progress: any) => void
}

function probeGithubCli(): GithubCliProbe {
  const version = spawnSync("gh", ["--version"], { stdio: "pipe", timeout: 3000 })
  if (version.status !== 0) {
    return { installed: false, authenticated: false, account: null }
  }

  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  const auth = spawnSync("gh", ["auth", "token"], { stdio: "pipe", env, timeout: 3000 })
  if (auth.status !== 0 || !auth.stdout?.toString().trim()) {
    return { installed: true, authenticated: false, account: null }
  }

  const accountResult = spawnSync("gh", ["api", "user", "--jq", ".login"], { stdio: "pipe", env, timeout: 5000 })
  const account = accountResult.status === 0 ? accountResult.stdout?.toString().trim() || null : null
  return { installed: true, authenticated: true, account }
}

export async function verifyGithubTokenViaApi(token: string): Promise<{ account: string | null; valid: boolean }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ellamaka-onboarding",
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { account: null, valid: false }
    const data = (await res.json()) as { login?: string }
    const account = data.login?.trim()
    return { account: account || null, valid: Boolean(account) }
  } catch {
    return { account: null, valid: false }
  }
}

export function loginGhWithToken(
  token: string,
  deps: {
    spawnFn?: (command: string, args: string[], options: { input: string; stdio: string }) => { status: number | null }
  } = {},
): boolean {
  try {
    const spawnFn = deps.spawnFn ?? spawnSync
    const res = spawnFn("gh", ["auth", "login", "--with-token"], { input: token, stdio: "pipe" })
    return res.status === 0
  } catch {
    // gh login failure is not fatal — fork falls back to API-based auth.
    return false
  }
}

export async function probeGithubAuthentication(
  homePath?: string,
  deps: GithubAuthenticationProbeDeps = {},
) {
  const t0 = Date.now()
  const step = (label: string) => {
    getOnboardingLogger(homePath).log(`[github-auth] ${label}（${Date.now() - t0}ms）`)
    deps.broadcastProgress?.({ phase: "github-auth", message: label })
  }
  step("开始检测 GitHub 凭据")
  const tokenInfo = detectGithubToken(homePath, {
    env: deps.env,
    loadUserShellEnv: deps.loadUserShellEnv,
    readGhToken: () => null,
  })
  step(tokenInfo ? `已发现 Token 来源: ${tokenInfo.source}` : "未发现环境内 Token")

  const ghCliT = Date.now()
  const ghCli = deps.probeGhCli ? deps.probeGhCli() : probeGithubCli()
  step(`GitHub CLI 探测完成（${Date.now() - ghCliT}ms）: ${ghCli.authenticated ? "已认证" : ghCli.installed ? "已安装未认证" : "未安装"}`)

  if (ghCli.authenticated) {
    return {
      detected: true,
      source: "gh-cli" as const,
      account: ghCli.account,
      ghCliInstalled: ghCli.installed,
      ghCliAuthenticated: ghCli.authenticated,
      tokenConfigured: tokenInfo !== null,
      tokenSource: tokenInfo?.source ?? null,
    }
  }

  if (!tokenInfo) {
    return {
      detected: false,
      source: null,
      account: null,
      ghCliInstalled: ghCli.installed,
      ghCliAuthenticated: ghCli.authenticated,
      tokenConfigured: false,
      tokenSource: null,
    }
  }

  const verify = deps.verifyGithubToken ?? verifyGithubTokenViaApi
  const verifyT = Date.now()
  step("向 GitHub API 验证 Token…")
  const verification = await verify(tokenInfo.token)
  step(`GitHub API 验证完成（${Date.now() - verifyT}ms）: ${verification.valid ? "有效" : "无效"}`)
  if (!verification.valid) {
    return {
      detected: false,
      source: null,
      account: null,
      ghCliInstalled: ghCli.installed,
      ghCliAuthenticated: ghCli.authenticated,
      tokenConfigured: true,
      tokenSource: tokenInfo.source,
    }
  }

  return {
    detected: true,
    source: tokenInfo.source,
    account: verification.account,
    ghCliInstalled: ghCli.installed,
    ghCliAuthenticated: ghCli.authenticated,
    tokenConfigured: true,
    tokenSource: tokenInfo.source,
  }
}

export function detectGithubToken(
  homePath?: string,
  deps: GithubTokenDetectionDeps = {},
): { token: string; source: string } | null {
  const env = deps.env ?? process.env
  if (env.GITHUB_TOKEN?.trim()) {
    return { token: env.GITHUB_TOKEN.trim(), source: "github-token-env" }
  }

  if (env.GH_TOKEN?.trim()) {
    return { token: env.GH_TOKEN.trim(), source: "gh-token-env" }
  }

  try {
    const shellEnv = deps.loadUserShellEnv
      ? deps.loadUserShellEnv()
      : loadShellEnv(getUserShell())
    if (shellEnv?.GITHUB_TOKEN?.trim()) {
      return { token: shellEnv.GITHUB_TOKEN.trim(), source: "github-token-shell" }
    }
    if (shellEnv?.GH_TOKEN?.trim()) {
      return { token: shellEnv.GH_TOKEN.trim(), source: "gh-token-shell" }
    }
  } catch {}

  try {
    const token = deps.readGhToken
      ? deps.readGhToken()
      : (() => {
          const res = spawnSync("gh", ["auth", "token"], { stdio: "pipe", timeout: 3000 })
          return res.status === 0 && res.stdout ? res.stdout.toString().trim() : null
        })()
    if (token) return { token, source: "gh-cli" }
  } catch {}

  const envPath = join(homePath ?? join(homedir(), ".wopal"), ".env")
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, "utf-8")
      const match = content.match(/^(GITHUB_TOKEN|GH_TOKEN)=(.+)$/m)
      if (match && match[1]?.trim()) {
        const val = match[2]?.trim().replace(/^["']|["']$/g, "")
        if (val) {
          return {
            token: val,
            source: match[1] === "GH_TOKEN" ? "wopal-gh-token" : "wopal-github-token",
          }
        }
      }
    } catch {}
  }

  return null
}

export function detectProviderAuth(homePath?: string, providerId = "opencode-go"): string | undefined {
  const authPath = join(homePath ?? join(homedir(), ".wopal"), "ellamaka", "data", "auth.json")
  if (existsSync(authPath)) {
    try {
      const content = readFileSync(authPath, "utf-8")
      const parsed = JSON.parse(content)
      if (parsed && parsed[providerId]?.key) return parsed[providerId].key
    } catch {}
  }
}

export function normalizeSetupResult(opRes: OnboardingStepResult): OnboardingStepResult {
  const raw = opRes.status as string
  if (raw === "completed") {
    return { status: "completed", result: opRes.result, error: opRes.error }
  }
  if (raw === "reused") {
    return { status: "reused", result: opRes.result, error: opRes.error }
  }
  if (raw === "skipped") {
    return { status: "skipped", result: opRes.result, error: opRes.error }
  }
  return { status: "failed", result: opRes.result, error: opRes.error }
}

export function probeWopalSpaceList(binPath: string, env?: Record<string, string>): Array<{ name: string; path: string; type?: string | null }> {
  try {
    if (!existsSync(binPath)) return []
    const res = spawnSync(binPath, ["space", "list", "--json", "--api-version", "1"], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: 3000,
    })
    if (res.status === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout)
      if (parsed?.ok && Array.isArray(parsed?.data?.items)) {
        return parsed.data.items.map((item: any) => ({
          name: item.name ?? String(item.path).split("/").filter(Boolean).at(-1) ?? "Space",
          path: item.path,
          type: item.type ?? "common",
        }))
      }
    }
  } catch {}
  return []
}

export function readEnvConfig(envPath: string) {
  if (!existsSync(envPath)) return null
  try {
    const text = readFileSync(envPath, "utf-8")
    const envVars: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith("#")) {
        const idx = trimmed.indexOf("=")
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim()
          let val = trimmed.slice(idx + 1).trim()
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
          }
          envVars[key] = val
        }
      }
    }

    const enabled = envVars["WOPAL_MEMORY_ENABLED"] !== "false"
    const memoryInjectionEnabled = envVars["WOPAL_MEMORY_INJECTION_ENABLED"] !== "false"
    const llmEndpoint = envVars["WOPAL_LLM_BASE_URL"] || envVars["WOPAL_MEMORY_LLM_ENDPOINT"] || ""
    const llmModel = envVars["WOPAL_LLM_MODEL"] || envVars["WOPAL_MEMORY_LLM_MODEL"] || ""
    const embeddingEndpoint = envVars["WOPAL_EMBEDDING_BASE_URL"] || envVars["WOPAL_MEMORY_EMBEDDING_ENDPOINT"] || ""
    const embeddingModel = envVars["WOPAL_EMBEDDING_MODEL"] || envVars["WOPAL_MEMORY_EMBEDDING_MODEL"] || ""
    const hasLlmKey = Boolean(envVars["WOPAL_LLM_API_KEY"] || envVars["WOPAL_MEMORY_LLM_KEY"])
    const hasEmbeddingKey = Boolean(envVars["WOPAL_EMBEDDING_API_KEY"] || envVars["WOPAL_MEMORY_EMBEDDING_KEY"] || envVars["WOPAL_LLM_API_KEY"])

    const hasAnyConfig =
      "WOPAL_MEMORY_ENABLED" in envVars ||
      Boolean(llmEndpoint || llmModel || embeddingModel || hasLlmKey)

    if (!hasAnyConfig) return null

    return {
      enabled,
      memoryInjectionEnabled,
      envPath,
      llmEndpoint,
      llmModel,
      embeddingEndpoint,
      embeddingModel,
      hasLlmKey,
      hasEmbeddingKey,
    }
  } catch {
    return null
  }
}

export interface MemoryConfigDetectionDeps {
  listSpaces?: typeof probeWopalSpaceList
}

export function detectMemoryConfig(homePath: string, deps: MemoryConfigDetectionDeps = {}) {
  const globalEnvPath = join(homePath, ".env")
  const globalConfig = readEnvConfig(globalEnvPath)

  let activeSpace: { name: string; path: string; type?: string | null } | null = null
  try {
    const isWin = process.platform === "win32"
    const binPath = join(homePath, "bin", isWin ? "wopal.exe" : "wopal")
    const spaces = (deps.listSpaces ?? probeWopalSpaceList)(binPath, { WOPAL_HOME: homePath })
    if (spaces.length > 0) {
      activeSpace = spaces[0]
    }
  } catch {}

  let spaceConfig: ReturnType<typeof readEnvConfig> = null
  if (activeSpace?.path) {
    spaceConfig = readEnvConfig(join(activeSpace.path, ".wopal", ".env"))
  }

  const effective = spaceConfig ?? globalConfig

  if (!effective && !globalConfig && !spaceConfig) {
    if (!activeSpace) return null
    return {
      state: "unconfigured" as const,
      enabled: false,
      memoryInjectionEnabled: true,
      envPath: globalEnvPath,
      llmEndpoint: "",
      llmModel: "",
      embeddingEndpoint: "",
      embeddingModel: "",
      hasLlmKey: false,
      hasEmbeddingKey: false,
      globalMemory: null,
      spaceMemory: null,
      effectiveSpace: activeSpace,
    }
  }

  const isReady = Boolean(
    effective &&
    effective.enabled &&
    (effective.llmEndpoint || effective.llmModel || effective.hasLlmKey)
  )
  const state = !effective ? "unconfigured" : !effective.enabled ? "disabled" : isReady ? "ready" : "incomplete"

  return {
    state,
    enabled: effective?.enabled ?? false,
    envPath: effective?.envPath ?? globalEnvPath,
    llmEndpoint: effective?.llmEndpoint ?? globalConfig?.llmEndpoint ?? "",
    llmModel: effective?.llmModel ?? globalConfig?.llmModel ?? "",
    embeddingEndpoint: effective?.embeddingEndpoint ?? globalConfig?.embeddingEndpoint ?? "",
    embeddingModel: effective?.embeddingModel ?? globalConfig?.embeddingModel ?? "",
    hasLlmKey: effective?.hasLlmKey ?? globalConfig?.hasLlmKey ?? false,
    hasEmbeddingKey: effective?.hasEmbeddingKey ?? globalConfig?.hasEmbeddingKey ?? false,
    globalMemory: globalConfig ? { ...globalConfig, state: globalConfig.enabled ? "ready" : "disabled" } : null,
    spaceMemory: spaceConfig ? { ...spaceConfig, state: spaceConfig.enabled ? "ready" : "disabled" } : null,
    effectiveSpace: activeSpace,
  }
}

export interface LocalCliProbeResult {
  installed: boolean
  binaryPath: string
  version?: string
  errorCode?: "CLI_BINARY_BROKEN"
  error?: string
}

export function probeLocalCli(
  binaryPath: string,
  deps: {
    exists?: (path: string) => boolean
    readVersion?: (path: string) => { status: number | null; stdout?: string | Buffer }
  } = {},
): LocalCliProbeResult {
  const binaryExists = deps.exists ?? existsSync
  if (!binaryExists(binaryPath)) {
    return { installed: false, binaryPath }
  }

  const readVersion = deps.readVersion ?? ((path: string) => spawnSync(path, ["--version"], { encoding: "utf8" }))
  try {
    const result = readVersion(binaryPath)
    if (result.status === 0) {
      const version = String(result.stdout ?? "").trim()
      return {
        installed: true,
        binaryPath,
        ...(version ? { version } : {}),
      }
    }
  } catch {}

  return {
    installed: false,
    binaryPath,
    errorCode: "CLI_BINARY_BROKEN",
    error: `检测到 CLI 文件，但无法执行版本检查：${binaryPath}`,
  }
}

export function clearSpaceMemoryEnvFile(targetEnvPath: string): boolean {
  try {
    if (!existsSync(targetEnvPath)) return true
    const text = readFileSync(targetEnvPath, "utf-8")
    const memoryKeys = new Set([
      "WOPAL_MEMORY_ENABLED",
      "WOPAL_MEMORY_INJECTION_ENABLED",
      "WOPAL_LLM_BASE_URL",
      "WOPAL_LLM_MODEL",
      "WOPAL_LLM_API_KEY",
      "WOPAL_MEMORY_LLM_ENDPOINT",
      "WOPAL_MEMORY_LLM_MODEL",
      "WOPAL_MEMORY_LLM_KEY",
      "WOPAL_EMBEDDING_BASE_URL",
      "WOPAL_EMBEDDING_MODEL",
      "WOPAL_EMBEDDING_API_KEY",
      "WOPAL_MEMORY_EMBEDDING_ENDPOINT",
      "WOPAL_MEMORY_EMBEDDING_MODEL",
      "WOPAL_MEMORY_EMBEDDING_KEY",
    ])

    const remainingLines: string[] = []
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf("=")
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim()
        if (!memoryKeys.has(key)) {
          remainingLines.push(line)
        }
      }
    }

    // Never delete the .env file — only clear memory keys and rewrite remaining lines
    writeFileSync(targetEnvPath, remainingLines.length > 0 ? remainingLines.join("\n") + "\n" : "", "utf-8")
    return true
  } catch (err) {
    console.error(`[onboarding-ipc] Failed to clear space memory env file at ${targetEnvPath}:`, err)
    return false
  }
}

export function writeMemoryEnvFile(
  targetEnvPath: string,
  payload: Record<string, unknown>,
  homePath?: string,
): boolean {
  try {
    const dir = join(targetEnvPath, "..")
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    let envVars: Record<string, string> = {}
    if (existsSync(targetEnvPath)) {
      const text = readFileSync(targetEnvPath, "utf-8")
      for (const line of text.split("\n")) {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith("#")) {
          const idx = trimmed.indexOf("=")
          if (idx > 0) {
            envVars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
          }
        }
      }
    }

    // Read global env vars for fallback key inheritance if writing to a space file
    let globalEnvVars: Record<string, string> = {}
    if (homePath) {
      const globalEnvPath = join(homePath, ".env")
      if (existsSync(globalEnvPath) && globalEnvPath !== targetEnvPath) {
        const globalText = readFileSync(globalEnvPath, "utf-8")
        for (const line of globalText.split("\n")) {
          const trimmed = line.trim()
          if (trimmed && !trimmed.startsWith("#")) {
            const idx = trimmed.indexOf("=")
            if (idx > 0) {
              globalEnvVars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
            }
          }
        }
      }
    }

    if (payload.enabled === false) {
      envVars["WOPAL_MEMORY_ENABLED"] = "false"
      delete envVars["WOPAL_MEMORY_INJECTION_ENABLED"]
    } else {
      envVars["WOPAL_MEMORY_ENABLED"] = "true"
      envVars["WOPAL_MEMORY_INJECTION_ENABLED"] = payload.memoryInjectionEnabled === false ? "false" : "true"
      if (payload.llmEndpoint) envVars["WOPAL_LLM_BASE_URL"] = String(payload.llmEndpoint)
      if (payload.llmModel) envVars["WOPAL_LLM_MODEL"] = String(payload.llmModel)

      // LLM Key: use typed key -> or existing key in file -> or inherit from global env
      if (payload.llmKey) {
        envVars["WOPAL_LLM_API_KEY"] = String(payload.llmKey)
      } else if (!envVars["WOPAL_LLM_API_KEY"] && globalEnvVars["WOPAL_LLM_API_KEY"]) {
        envVars["WOPAL_LLM_API_KEY"] = globalEnvVars["WOPAL_LLM_API_KEY"]
      }

      if (payload.embeddingEndpoint) envVars["WOPAL_EMBEDDING_BASE_URL"] = String(payload.embeddingEndpoint)
      if (payload.embeddingModel) envVars["WOPAL_EMBEDDING_MODEL"] = String(payload.embeddingModel)

      // Embedding Key: use typed key -> or existing key in file -> or reuse llm key -> or inherit from global
      if (payload.embeddingKey) {
        envVars["WOPAL_EMBEDDING_API_KEY"] = String(payload.embeddingKey)
      } else if (payload.reuseEmbedding || !envVars["WOPAL_EMBEDDING_API_KEY"]) {
        const fallbackKey = envVars["WOPAL_LLM_API_KEY"] || globalEnvVars["WOPAL_EMBEDDING_API_KEY"] || globalEnvVars["WOPAL_LLM_API_KEY"]
        if (fallbackKey) {
          envVars["WOPAL_EMBEDDING_API_KEY"] = fallbackKey
        }
      }
    }

    const lines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`)
    writeFileSync(targetEnvPath, lines.join("\n") + "\n", "utf-8")
    return true
  } catch (err) {
    console.error(`[onboarding-ipc] Failed to write memory env file at ${targetEnvPath}:`, err)
    return false
  }
}

export function resolveTargetEnvPath(homePath: string, scope?: string, spacePath?: string): string {
  if (scope === "space") {
    if (spacePath) {
      return join(spacePath, ".wopal", ".env")
    }
    try {
      const detected = detectMemoryConfig(homePath)
      if (detected?.effectiveSpace?.path) {
        return join(detected.effectiveSpace.path, ".wopal", ".env")
      }
    } catch {}
    throw new Error("Space scope configuration requires a valid space path.")
  }
  return join(homePath, ".env")
}

export function buildMemoryOperationInput(input?: unknown, homePath?: string): Record<string, unknown> {
  const payload = (input as Record<string, unknown> | undefined) ?? {}
  const result: Record<string, unknown> = {}

  if (typeof payload.enabled === "boolean") result.enabled = payload.enabled
  if (payload.scope) result.scope = payload.scope
  if (payload.spaceMode) result.spaceMode = payload.spaceMode
  if (typeof payload.memoryInjectionEnabled === "boolean") {
    result.memoryInjectionEnabled = payload.memoryInjectionEnabled
  }

  if (typeof payload.spacePath === "string" && payload.spacePath) {
    result.spacePath = payload.spacePath
  } else if (payload.scope === "space" && homePath) {
    try {
      const detected = detectMemoryConfig(homePath)
      if (detected?.effectiveSpace?.path) {
        result.spacePath = detected.effectiveSpace.path
      }
    } catch {}
  }

  // Skip is handled at the memory-config case level (returns "skipped"
  // without writing anything); it never reaches payload building.
  if (payload.enabled === false || payload.spaceMode === "disabled") {
    result.enabled = false
    return result
  }

  if (payload.spaceMode === "inherit") {
    return result
  }

  for (const field of [
    "llmEndpoint",
    "llmKey",
    "llmModel",
    "embeddingEndpoint",
    "embeddingKey",
    "embeddingModel",
  ]) {
    if (typeof payload[field] === "string" && payload[field]) result[field] = payload[field]
  }

  return result
}

export type StepExecutor = (
  step: OnboardingStepName | "inspect" | "github-auth",
  input?: unknown,
  onProgress?: (progress: any) => void,
  abortSignal?: AbortSignal,
) => Promise<OnboardingStepResult>

export interface OnboardingIpcDeps {
  homePath?: string
  executeStep?: StepExecutor
  broadcastProgress?: (progress: any) => void
  // Persists WOPAL_HOME into the user shell profile. Defaults to a no-op so that
  // tests never rewrite the real user shell profile; production wiring injects
  // the real implementation (see main/ipc.ts).
  persistWopalHomeEnv?: (wopalHome: string) => { success: boolean; message?: string }
  // GitHub auth step hooks. Defaults are used in production; tests inject
  // stubs so the github-auth step never touches the network or gh CLI.
  verifyGithubToken?: (token: string) => Promise<{ account: string | null; valid: boolean }>
  probeGhCli?: () => GithubCliProbe
  loginGhWithToken?: (token: string) => boolean
}

function noopPersistWopalHomeEnv(_wopalHome: string): { success: boolean; message?: string } {
  return { success: true }
}

const STEP_OPERATION_LABELS: Record<string, string> = {
  "system-check": "检查系统环境",
  "install-cli": "安装与配置基础组件",
  "github-auth": "配置 GitHub 认证",
  "ai-provider": "配置 AI Provider",
  "ontology-setup": "准备能力本体与运行时配置",
  "create-space": "创建或复用工作空间",
  "memory-config": "配置记忆系统",
  "done": "完成空间设置",
}

export function createOnboardingIpcHandlers(deps: OnboardingIpcDeps = {}) {
  let currentOperation: Promise<OnboardingStepResult> | null = null
  let currentAbortController: AbortController | null = null

  // In-memory snapshot of the last `wopal inspect` result. Probes reuse it
  // instead of re-running the full (network-heavy) inspection on every step.
  // Each successful execute step updates the affected dimensions in place,
  // so the snapshot stays fresh without re-inspecting.
  let inspectSnapshot: Record<string, unknown> | null = null
  let inspectSnapshotError: { code?: string; message: string } | null = null

  const getInspection = async (
    homePath: string,
  ): Promise<{ result: Record<string, unknown> | null; error: { code?: string; message: string } | null; fromSnapshot: boolean }> => {
    if (inspectSnapshot) {
      return { result: inspectSnapshot, error: null, fromSnapshot: true }
    }
    const executor = deps.executeStep ?? defaultExecuteStep
    const res = await executor("inspect")
    if (res.status === "failed") {
      inspectSnapshotError = {
        code: res.error?.code,
        message: res.error?.message ?? "无法检查环境。",
      }
      return { result: null, error: inspectSnapshotError, fromSnapshot: false }
    }
    inspectSnapshot = (res.result ?? {}) as Record<string, unknown>
    inspectSnapshotError = null
    return { result: inspectSnapshot, error: null, fromSnapshot: false }
  }

  const updateInspectionFromStep = (stepName: string, input: unknown, result: unknown) => {
    if (!inspectSnapshot) return
    const data = (result ?? {}) as Record<string, unknown>
    const stepInput = (input ?? {}) as Record<string, unknown>
    const snap = inspectSnapshot
    switch (stepName) {
      case "install-cli": {
        // Only the "ellamaka" subStep (install-engine) mutates the engine
        // dimension; the "wopal" subStep installs the wopal CLI itself.
        if (stepInput.subStep === "ellamaka" && data.version) {
          snap.engineInstalled = true
          snap.engineRunning = true
          snap.engineVersion = data.version
        }
        break
      }
      case "github-auth": {
        const security = (snap.security ?? {}) as Record<string, unknown>
        const github = (security.github ?? {}) as Record<string, unknown>
        github.tokenConfigured = true
        security.github = github
        snap.security = security
        break
      }
      case "ai-provider": {
        const security = (snap.security ?? {}) as Record<string, unknown>
        const providers = (security.providers ?? {}) as Record<string, unknown>
        const providerId = (data.providerId as string) || "opencode-go"
        providers[providerId] = { configured: true, type: "api" }
        security.providers = providers
        snap.security = security
        break
      }
      case "ontology-setup": {
        // prepare-ontology result: ontologyPath/mode/availableTypes.
        // prepare-runtime runs right after it in the same execute call and, on
        // success, materialises settings + base capabilities → runtime.ready. A
        // prepare-runtime failure returns early from the step, so this snapshot
        // update only runs when both succeeded.
        if (data.mode) {
          snap.ontologyInstalled = true
          snap.ontologyMode = data.mode
        }
        if (Array.isArray(data.availableTypes)) {
          snap.availableTypes = data.availableTypes
        }
        const runtime = (snap.runtime ?? {}) as Record<string, unknown>
        runtime.ready = true
        snap.runtime = runtime
        break
      }
      case "create-space": {
        // initialize-space result: spaceName/spacePath
        if (data.spaceName && data.spacePath) {
          const spaces = Array.isArray(snap.spaces) ? [...snap.spaces] : []
          spaces.push({
            name: data.spaceName,
            path: data.spacePath,
            hasSkeleton: true,
            type: null,
          })
          snap.spaces = spaces
        }
        break
      }
      case "memory-config": {
        // configure-memory result: state/enabled/injectionEnabled/envPath/llm/embedding
        const memory = (snap.memory ?? {}) as Record<string, unknown>
        for (const key of ["state", "enabled", "injectionEnabled", "envPath", "llm", "embedding"]) {
          if (data[key] !== undefined) memory[key] = data[key]
        }
        snap.memory = memory
        break
      }
    }
  }

  // Unified trace: writes the same message to the onboarding log file AND
  // broadcasts it to the renderer LogDrawer so both stay in sync.
  const trace = (homePath: string, phase: string, message: string) => {
    getOnboardingLogger(homePath).log(`[${phase}] ${message}`)
    deps.broadcastProgress?.({ phase, message })
  }

  const defaultExecuteStep: StepExecutor = async (step, input, onProgress, abortSignal) => {
    // Resolve the active WOPAL_HOME. deps.homePath is the user-confirmed
    // directory (set by onboardingSetWopalHome / system-check); it wins over
    // the process env so every wopal CLI invocation downstream uses the same
    // home the user chose. process.env.WOPAL_HOME is kept in sync so
    // runSetupOperation's { ...process.env } env carries the right value.
    const homePath = deps.homePath ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
    deps.homePath = homePath
    process.env.WOPAL_HOME = homePath

    const logger = getOnboardingLogger(homePath)
    logger.log(`Executing step: ${step} (WOPAL_HOME=${homePath})`)
    
    const isWin = process.platform === "win32"
    const binPath = join(homePath, "bin", isWin ? "wopal.exe" : "wopal")

switch (step as string) {
        case "inspect":
          return normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "inspect",
            input: {},
            onProgress,
          }))

        case "system-check": {
          const inputHome = (input as Record<string, unknown> | undefined)?.customHomePath as string | undefined
          const targetHome = inputHome?.trim() ? inputHome.trim() : homePath
          const resolvedHome = targetHome.startsWith("~") ? join(homedir(), targetHome.slice(1)) : targetHome
          deps.homePath = resolvedHome
          process.env.WOPAL_HOME = resolvedHome
          ;(deps.persistWopalHomeEnv ?? noopPersistWopalHomeEnv)(resolvedHome)
          // Always invalidate existing inspect snapshot and re-inspect for the confirmed WOPAL_HOME directory,
          // ensuring later steps get fresh status for the newly selected path.
          inspectSnapshot = null
          await getInspection(resolvedHome)
          return performSystemCheck(resolvedHome)
        }

        case "install-cli": {
          const subStep = (input as Record<string, unknown> | undefined)?.subStep
          // Ensure the inspect snapshot exists before deciding what to install.
          // Both wopal and ellamaka short-circuit from it when already present.
          if (!inspectSnapshot) {
            await getInspection(homePath)
          }
          // Short-circuit from the inspect snapshot when the tool is already
          // installed — no need to spawn wopal or hit the network again.
          if (subStep === "wopal") {
            const snapshot = inspectSnapshot
            const products = (snapshot?.products as Record<string, unknown> | undefined)
            const wopalCliInfo = (products?.wopalCli as { installed?: boolean; version?: string | null } | undefined)
            const cliInfo = (products?.cli as { installed?: boolean; version?: string | null } | undefined)
            if (wopalCliInfo?.installed) {
              return {
                status: "reused",
                result: { version: wopalCliInfo.version ?? undefined, upgraded: false },
              }
            }
            if (cliInfo?.installed) {
              // Fallback for older wopal CLI builds that only report the
              // ellamaka engine CLI under products.cli.
              return {
                status: "reused",
                result: { version: cliInfo.version ?? undefined, upgraded: false },
              }
            }
            const res = await installWopalCli({
              homePath,
              forceUpgrade: (input as Record<string, unknown> | undefined)?.forceUpgrade as boolean | undefined,
              onProgress,
              abortSignal,
            })
            const cliProbe = probeLocalCli(binPath)
            if (res.status !== "failed" && cliProbe.version) {
              return {
                ...res,
                result: { ...(res.result ?? {}), version: cliProbe.version },
              }
            }
            return res
          }
          if (subStep === "ellamaka") {
            const engineBinary = join(homePath, "bin", process.platform === "win32" ? "ellamaka.exe" : "ellamaka")
            // Engine already installed per snapshot AND physical binary exists in target home → reuse without re-download.
            if (inspectSnapshot?.engineInstalled === true && existsSync(engineBinary)) {
              return {
                status: "reused",
                result: { version: inspectSnapshot.engineVersion ?? undefined, upgraded: false },
              }
            }
            const payload = { ...((input as Record<string, unknown>) ?? {}) }
            delete payload.homePath
            delete payload.forkUrl
            delete payload.subStep
            if (!payload.requirements || typeof payload.requirements !== "object") {
              payload.requirements = {}
            }
            return normalizeSetupResult(await runSetupOperation({
              binaryPath: binPath,
              operation: "install-engine",
              input: payload,
              onProgress,
              abortSignal,
            }))
          }

          const wopalRes = await installWopalCli({
            homePath,
            forceUpgrade: (input as Record<string, unknown> | undefined)?.forceUpgrade as boolean | undefined,
            onProgress,
            abortSignal,
          })
          if (wopalRes.status === "failed") return wopalRes

          const payload = { ...((input as Record<string, unknown>) ?? {}) }
          delete payload.homePath
          delete payload.forkUrl
          if (!payload.requirements || typeof payload.requirements !== "object") {
            payload.requirements = {}
          }
          const ellamakaRes = normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "install-engine",
            input: payload,
            onProgress,
            abortSignal,
          }))
          if (ellamakaRes.status === "failed") return ellamakaRes

          return {
            status: "completed",
            result: {
              wopal: wopalRes.result,
              ellamaka: ellamakaRes.result,
            },
          }
        }

        case "install-wopal-cli":
          return installWopalCli({
            homePath,
            forceUpgrade: (input as Record<string, unknown> | undefined)?.forceUpgrade as boolean | undefined,
            onProgress,
            abortSignal,
          })

        case "install-ellamaka-cli": {
          const payload = (input as Record<string, unknown>) ?? {}
          delete payload.homePath
          delete payload.forkUrl
          return normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "install-engine",
            input: payload,
            onProgress,
            abortSignal,
          }))
        }

        case "github-auth": {
          const payload = (input as Record<string, unknown>) ?? {}
          if (payload.skip) {
            return { status: "skipped" }
          }
          const token = (payload.token as string | undefined)?.trim() || detectGithubToken(homePath)?.token
          if (!token) {
            return { status: "skipped" }
          }

          // Verify the token against the GitHub API before persisting it.
          // An invalid token must not reach configure-github (no .env write).
          const verify = deps.verifyGithubToken ?? verifyGithubTokenViaApi
          const verification = await verify(token)
          if (!verification.valid) {
            return {
              status: "failed",
              error: { code: "GITHUB_TOKEN_INVALID", message: "GitHub Token 无效，请检查后重试。" },
            }
          }

          // Auto-login gh when available so CLI-based fork operations work
          // out of the box. Login failure is not fatal — the fork falls back
          // to API auth via the token written to .env below.
          const ghCli = deps.probeGhCli ? deps.probeGhCli() : probeGithubCli()
          let loginGh = false
          if (ghCli.installed) {
            loginGh = (deps.loginGhWithToken ?? loginGhWithToken)(token)
          }

          const setupResult = normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "configure-github",
            input: { token },
            onProgress,
            abortSignal,
          }))
          if (setupResult.status === "failed") {
            return setupResult
          }
          return {
            status: "completed",
            result: {
              ...setupResult.result,
              verified: true,
              account: verification.account,
              loginGh,
            },
          }
        }

        case "ai-provider": {
          const payload = (input as Record<string, unknown>) ?? {}
          const providerId = (payload.provider as string) || (payload.providerId as string) || "opencode-go"

          const apiKey = (payload.apiKey as string | undefined)?.trim() || detectProviderAuth(homePath, providerId)

          if (payload.skip || !apiKey) {
            return { status: "skipped" }
          }

          return normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "configure-provider",
            input: { providerId, apiKey },
            onProgress,
            abortSignal,
          }))
        }

        case "ontology-setup": {
          const payload = (input as Record<string, unknown>) ?? {}
          const mode = (payload.mode as string) === "fork" ? "fork" : "clone"
          const source = payload.source as string | undefined
          const opInput: Record<string, unknown> = { mode }
          if (source) opInput.source = source
          const ontRes = normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "prepare-ontology",
            input: opInput,
            onProgress,
            abortSignal,
          }))
          if (ontRes.status === "completed" || ontRes.status === "reused") {
            // prepare-runtime materialises runtime config (settings, scripts,
            // base capabilities). A CLI failure is reported via the result (not a
            // throw), so inspect it and surface the failure — the step must not
            // report success (and the completion gate must not trust
            // runtime.ready) when runtime preparation failed.
            let runtimeRes: OnboardingStepResult
            try {
              runtimeRes = normalizeSetupResult(await runSetupOperation({
                binaryPath: binPath,
                operation: "prepare-runtime",
                input: {},
                onProgress,
                abortSignal,
              }))
            } catch (err) {
              // Spawn-level failure: log it (never an empty catch) and fail loud.
              const msg = err instanceof Error ? err.message : String(err)
              logger.log(`[ontology-setup] prepare-runtime threw: ${msg}`)
              return {
                status: "failed",
                error: { code: "PREPARE_RUNTIME_FAILED", message: `运行时准备失败：${msg}` },
              }
            }
            if (runtimeRes.status === "failed") {
              return {
                status: "failed",
                error: {
                  code: runtimeRes.error?.code ?? "PREPARE_RUNTIME_FAILED",
                  message: runtimeRes.error?.message ?? "运行时准备失败",
                  suggestion: runtimeRes.error?.suggestion,
                  details: runtimeRes.error?.details,
                },
              }
            }
          }
          return ontRes
        }

        case "create-space": {
          const payload = (input as Record<string, unknown>) ?? {}
          if (payload.skip) {
            // Verify existing spaces before allowing skip
            const inspectRes = await runSetupOperation({
              binaryPath: binPath,
              operation: "inspect",
              input: {},
            })
            const spaces = (inspectRes.result as any)?.spaces ?? []
            if (spaces.length === 0) {
              return {
                status: "failed",
                error: { code: "NO_EXISTING_SPACE", message: "Cannot skip space creation on a fresh environment. At least one Space must be registered." },
              }
            }
            return { status: "skipped" }
          }
          const path = payload.path as string
          if (!path) {
            return { status: "failed", error: { code: "INVALID_INPUT", message: "Space path is required." } }
          }
          return normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "initialize-space",
            input: { path, type: (payload.type as string) || undefined },
            onProgress,
            abortSignal,
          }))
        }

        case "memory-config": {
          const isSkip = Boolean((input as Record<string, unknown> | undefined)?.skip)
          if (isSkip) {
            // Skip = "don't configure memory", not "disable memory".
            // No env file is written and no space env file is cleared.
            return {
              status: "skipped",
              result: {
                memoryEnabled: false,
                scope: "global",
                state: "unconfigured",
                outcome: "skipped",
              },
            }
          }

          const memInput = buildMemoryOperationInput(input, homePath)
          const isSpaceScope = memInput.scope === "space"
          const spaceMode = (memInput.spaceMode as string) || (isSpaceScope ? "custom" : undefined)
          const spacePath = typeof memInput.spacePath === "string" ? memInput.spacePath : undefined
          const targetEnvPath = resolveTargetEnvPath(homePath, memInput.scope as string, spacePath)

          if (isSpaceScope && spaceMode === "inherit") {
            clearSpaceMemoryEnvFile(targetEnvPath)
          } else {
            writeMemoryEnvFile(targetEnvPath, memInput, homePath)
          }

          // The CLI configure-memory operation owns global configuration only.
          // Space configuration is written directly above and must not invoke it,
          // otherwise an inherited space payload can overwrite the global switch.
          let cliResult: OnboardingStepResult | null = null
          if (!isSpaceScope) {
            try {
              cliResult = normalizeSetupResult(await runSetupOperation({
                binaryPath: binPath,
                operation: "configure-memory",
                input: memInput,
                onProgress,
                abortSignal,
              }))
            } catch {}
          }

          const globalEnvPath = join(homePath, ".env")
          const globalConfig = readEnvConfig(globalEnvPath)
          const isGlobalEnabled = Boolean(globalConfig?.enabled)

          const memoryEnabled = isSpaceScope && spaceMode === "inherit" ? isGlobalEnabled : memInput.enabled !== false

          return {
            status: "completed",
            result: {
              memoryEnabled,
              memoryInjectionEnabled: isSpaceScope && spaceMode === "inherit"
                ? (globalConfig?.memoryInjectionEnabled !== false)
                : (memInput.memoryInjectionEnabled !== false),
              scope: isSpaceScope ? "space" : "global",
              spaceMode: isSpaceScope ? spaceMode : undefined,
              envPath: isSpaceScope && spaceMode === "inherit" ? globalEnvPath : targetEnvPath,
              llmEndpoint: isSpaceScope && spaceMode === "inherit"
                ? (globalConfig?.llmEndpoint ?? "")
                : (memInput.llmEndpoint ?? (cliResult?.result?.llmEndpoint as string | undefined) ?? ""),
              llmModel: isSpaceScope && spaceMode === "inherit"
                ? (globalConfig?.llmModel ?? "")
                : (memInput.llmModel ?? (cliResult?.result?.llmModel as string | undefined) ?? ""),
              embeddingEndpoint: isSpaceScope && spaceMode === "inherit"
                ? (globalConfig?.embeddingEndpoint ?? "")
                : (memInput.embeddingEndpoint ?? (cliResult?.result?.embeddingEndpoint as string | undefined) ?? ""),
              embeddingModel: isSpaceScope && spaceMode === "inherit"
                ? (globalConfig?.embeddingModel ?? "")
                : (memInput.embeddingModel ?? (cliResult?.result?.embeddingModel as string | undefined) ?? ""),
              llmKeyConfigured: isSpaceScope && spaceMode === "inherit"
                ? Boolean(globalConfig?.hasLlmKey)
                : Boolean(memInput.llmKey || cliResult?.result?.llmKeyConfigured),
              embeddingKeyConfigured: isSpaceScope && spaceMode === "inherit"
                ? Boolean(globalConfig?.hasEmbeddingKey)
                : Boolean(memInput.embeddingKey || cliResult?.result?.embeddingKeyConfigured),
              state: memoryEnabled ? "ready" : "disabled",
              outcome: isSpaceScope && spaceMode === "inherit" ? "cleared" : "saved",
            },
          }
        }

        case "done":
        case "star-guide": {
          const payload = (input as Record<string, unknown>) ?? {}
          if (payload.skip) return { status: "skipped" }
          return normalizeSetupResult(await runSetupOperation({
            binaryPath: binPath,
            operation: "star",
            input: { repo: "wopal-cn/wopal-space-ontology", accepted: true, browserFallback: true },
            onProgress,
          }))
        }

        default:
          return { status: "failed", error: { code: "ONBOARDING_STEP_INVALID", message: `Unknown step: ${step}` } }
      }
  }

  return {
    "get-onboarding-mode": async () => {
      const mode = resolveOnboardingMode(deps.homePath)
      return { mode }
    },

    // Renderer-side log lines (e.g. step transitions, state restore) are
    // forwarded here so the onboarding.log file matches the UI LogDrawer.
    "onboarding-renderer-log": async (_event: unknown, message: string) => {
      if (typeof message !== "string" || !message.trim()) return { status: "ok" }
      const homePath = deps.homePath ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
      getOnboardingLogger(homePath).log(`[renderer] ${message.trim()}`)
      return { status: "ok" }
    },

    "onboarding-get-state": async () => {
      return readOnboardingState(deps.homePath)
    },

    "onboarding-set-current-step": async (_event: unknown, step: OnboardingStepName) => {
      if (!ONBOARDING_STEPS.includes(step)) {
        return { status: "error", message: `Invalid step: ${step}` }
      }
      let state = readOnboardingState(deps.homePath) ?? createDefaultOnboardingState()
      state = navigateToStep(state, step)
      writeOnboardingState(state, deps.homePath)
      return { status: "ok", currentStep: state.currentStep }
    },

    "onboarding-probe": async (_event: unknown, kind: string) => {
        const homePath = deps.homePath || process.env.WOPAL_HOME || join(homedir(), ".wopal")
        deps.homePath = homePath
        process.env.WOPAL_HOME = homePath
        const isWin = process.platform === "win32"
        const binPath = join(homePath, "bin", isWin ? "wopal.exe" : "wopal")

        switch (kind) {
          case "home": {
            const homePath = deps.homePath || process.env.WOPAL_HOME || join(homedir(), ".wopal")
            return { homePath, wopalHome: homePath }
          }
          case "system-info": {
            // Read-only static system info for the first-step UI. Never writes
            // WOPAL_HOME or onboarding state — actual checking happens on "下一步".
            let gitVer: string | null = null
            try {
              const check = spawnSync("git", ["--version"])
              if (check.status === 0) gitVer = check.stdout.toString().trim()
            } catch {}
            return {
              platform: process.platform,
              arch: process.arch,
              nodeVersion: process.version,
              gitVersion: gitVer,
            }
          }
          case "ontology-setup":
          case "ontology": {
            const ontologyPath = join(homePath, "ontologies", "wopal-space-ontology")
            const pathExists = existsSync(ontologyPath)
            const inspectT = Date.now()
            const { result: inspection, error: inspectionError, fromSnapshot } = await getInspection(homePath)
            trace(homePath, "ontology-probe", `空间能力本体检查完成（${Date.now() - inspectT}ms）${fromSnapshot ? "（快照命中）" : "（首次 inspect）"}`)
            if (!inspection) {
              return {
                status: "broken",
                ontologyInstalled: false,
                ontologyMode: null,
                ontologyPath,
                availableTypes: [],
                error: inspectionError?.message ?? "无法检查空间能力本体。",
              }
            }
            if (inspectionError) {
              return {
                status: "broken",
                ontologyInstalled: false,
                ontologyMode: null,
                ontologyPath,
                availableTypes: [],
                error: inspectionError.message,
              }
            }
            const reportedInstalled = Boolean(inspection.ontologyInstalled)
            const rawMode = inspection.ontologyMode
            const ontologyMode = rawMode === "fork" || rawMode === "clone" ? rawMode : null
            const ontologyInstalled = reportedInstalled && ontologyMode !== null
            const status = ontologyInstalled ? "ready" : pathExists || reportedInstalled ? "broken" : "missing"
            return {
              status,
              ontologyInstalled,
              ontologyMode,
              ontologyPath,
              availableTypes: Array.isArray(inspection.availableTypes)
                ? inspection.availableTypes
                : [],
              error: status === "broken" ? "检测到本体目录，但它不是可复用的有效 Git 仓库。" : undefined,
            }
          }
          case "wopal-cli":
            return probeLocalCli(join(homePath, "bin", isWin ? "wopal.exe" : "wopal"))
          case "ellamaka-cli":
            return probeLocalCli(join(homePath, "bin", isWin ? "ellamaka.exe" : "ellamaka"))
          case "github-auth": {
            return await probeGithubAuthentication(homePath, { broadcastProgress: deps.broadcastProgress })
          }
          case "ai-provider": {
            const existingKey = detectProviderAuth(homePath, "opencode-go")
            return {
              hasKey: !!existingKey,
              maskedKey: existingKey ? `${existingKey.slice(0, 3)}...${existingKey.slice(-4)}` : null,
            }
          }
          case "runtime": {
            try {
              const ontologyDir = join(homePath, "ontologies", "wopal-space-ontology")
              const agentsDir = join(homePath, "agents")
              const skillsDir = join(homePath, "skills")
              const rulesDir = join(homePath, "rules")

              const hasOntology = existsSync(ontologyDir)
              const hasCapabilities = existsSync(agentsDir) || existsSync(skillsDir) || existsSync(rulesDir)

              if (hasOntology && hasCapabilities) {
                return {
                  ready: true,
                  homePath,
                  config: { missingKeys: [] },
                  scripts: { missing: [], stale: [] },
                  capabilities: { missing: [], empty: [], stale: [] },
                }
              }

              const { result: inspection, error: inspectionError } = await getInspection(homePath)
              if (!inspection) {
                return {
                  ready: false,
                  homePath,
                  error: inspectionError?.message ?? "无法检查本体能力配置。",
                }
              }
              const runtime = inspection.runtime
              if (!runtime || typeof runtime !== "object") {
                return {
                  ready: false,
                  homePath,
                  error: "检查结果缺少本体能力状态。",
                }
              }
              return runtime
            } catch (err) {
              return {
                ready: false,
                homePath,
                error: err instanceof Error ? err.message : String(err),
              }
            }
          }

          case "environment": {
            try {
              const homeDir = homePath
              const ontologyDir = join(homeDir, "ontologies", "wopal-space-ontology")
              const gitDir = join(ontologyDir, ".git")
              const installed = existsSync(gitDir) || existsSync(ontologyDir)

              // Both branches read from the inspect snapshot. The snapshot is
              // built once (first probe) and incrementally updated by each
              // execute step, so we never re-spawn wopal just to list spaces.
              const { result: inspection, error: inspectionError } = await getInspection(homeDir)
              if (!inspection) {
                return {
                  availableTypes: [],
                  spaces: [],
                  ontologyInstalled: installed,
                  ontologyMode: null,
                  homePath: homeDir,
                  wopalHome: homeDir,
                  defaultSpacePath: join(homedir(), "WopalSpace"),
                  error: inspectionError?.message ?? "无法检查工作空间环境。",
                  errorCode: inspectionError?.code ?? "ENVIRONMENT_INSPECT_FAILED",
                }
              }
              const hasAvailableTypes = Array.isArray(inspection.availableTypes)
              const availableTypes = hasAvailableTypes
                ? inspection.availableTypes
                : [{ type: "common", branch: "main" }]
              return {
                availableTypes,
                spaces: Array.isArray(inspection.spaces) ? inspection.spaces : [],
                ontologyInstalled: installed || Boolean(inspection.ontologyInstalled),
                ontologyMode: inspection.ontologyMode ?? null,
                homePath: homeDir,
                wopalHome: homeDir,
                defaultSpacePath: join(homedir(), "WopalSpace"),
                legacyContract: !hasAvailableTypes,
              }
            } catch (err) {
              return {
                availableTypes: [],
                spaces: [],
                ontologyInstalled: false,
                ontologyMode: null,
                homePath,
                wopalHome: homePath,
                defaultSpacePath: join(homedir(), "WopalSpace"),
                error: err instanceof Error ? err.message : String(err),
                errorCode: "ENVIRONMENT_INSPECT_FAILED",
              }
            }
          }
          case "memory": {
            try {
              const detected = detectMemoryConfig(homePath)
              if (detected) {
                if (!detected.effectiveSpace) {
                  // The wopal CLI probe can fail (missing binary, timeout,
                  // path mismatch). Fall back to the inspect snapshot, which
                  // create-space already keeps fresh, so the space scope tab
                  // stays clickable even when the CLI query fails.
                  const { result: inspection } = await getInspection(homePath)
                  const spaces = Array.isArray(inspection?.spaces) ? inspection.spaces : []
                  if (spaces.length > 0) {
                    detected.effectiveSpace = spaces[0] as { name: string; path: string; type?: string | null }
                  }
                }
                if (detected.effectiveSpace && !detected.spaceMemory) {
                  // The CLI probe also failed to read the space env, so
                  // detectMemoryConfig reported no space config. Re-read the
                  // real space .env from the snapshot path — a force-disabled
                  // space must surface as spaceMemory, otherwise the renderer
                  // misreads it as "inherit global".
                  const spaceConfig = readEnvConfig(join(detected.effectiveSpace.path, ".wopal", ".env"))
                  if (spaceConfig) {
                    detected.spaceMemory = { ...spaceConfig, state: spaceConfig.enabled ? "ready" : "disabled" }
                  }
                }
                return detected
              }
              const { result: inspection, error: inspectionError } = await getInspection(homePath)
              if (!inspection) {
                return {
                  state: "unconfigured",
                  enabled: false,
                  envPath: join(homePath, ".env"),
                  error: inspectionError?.message ?? "无法检查记忆配置。",
                }
              }
              const memory = (inspection.memory ?? {}) as Record<string, unknown>
              const spaces = Array.isArray(inspection.spaces) ? inspection.spaces : []
              const effectiveSpace = memory.effectiveSpace ?? spaces[0] ?? null
              return effectiveSpace ? { ...memory, effectiveSpace } : memory
            } catch (err) {
              return {
                state: "unconfigured",
                enabled: false,
                envPath: join(homePath, ".env"),
                error: err instanceof Error ? err.message : String(err),
              }
            }
          }
          case "system-user": {
            let appVersion: string | undefined
            try {
              appVersion = getReleaseInfo().displayVersion
            } catch {}
            return { userName: resolveSystemUserName(), appVersion }
          }
          default:
            return { error: "Unknown probe kind" }
        }
      },

      "onboarding-execute-step": async (
      _event: unknown,
      stepName: OnboardingStepName | "github-auth",
      input?: unknown,
    ): Promise<OnboardingStepResult> => {
      // github-auth is a sub-operation of the ontology-setup step (no longer a
      // wizard step itself): it may be invoked directly with a token payload.
      const isKnownStep = ONBOARDING_STEPS.includes(stepName as OnboardingStepName) || stepName === "github-auth"
      if (!isKnownStep) {
        return {
          status: "failed",
          error: {
            code: "ONBOARDING_STEP_INVALID",
            message: `Invalid step name: ${stepName}`,
          },
        }
      }

      if (currentOperation !== null) {
        return {
          status: "failed",
          error: {
            code: "ONBOARDING_OPERATION_BUSY",
            message: "另一个安装或配置任务仍在运行，请等待当前任务结束后再重试。",
          },
        }
      }

      const run = async (): Promise<OnboardingStepResult> => {
        const logger = getOnboardingLogger(deps.homePath)
        const operationLabel = STEP_OPERATION_LABELS[stepName]
        const startingMessage = `开始${operationLabel}…`
        logger.log(`[${stepName}] ${startingMessage}`)
        deps.broadcastProgress?.({
          step: stepName,
          phase: "starting",
          message: startingMessage,
        })
        // github-auth is a sub-operation of the ontology-setup step, not a
        // wizard step — it must not pollute the onboarding state's steps map.
        const isWizardStep = ONBOARDING_STEPS.includes(stepName as OnboardingStepName)
        let state = readOnboardingState(deps.homePath) ?? createDefaultOnboardingState()
        state = markStarted(state)
        if (isWizardStep) {
          state = updateStep(state, stepName as OnboardingStepName, "in-progress")
          writeOnboardingState(state, deps.homePath)
        }

        const abortController = new AbortController()
        currentAbortController = abortController

        try {
          const executor = deps.executeStep ?? defaultExecuteStep
          const res = await executor(stepName, input, (p) => deps.broadcastProgress?.({ step: stepName, ...p }), abortController.signal)

          state = readOnboardingState(deps.homePath) ?? state
          if (isWizardStep) {
            if (res.status === "completed" || res.status === "reused") {
              state = updateStep(state, stepName as OnboardingStepName, "done")
              updateInspectionFromStep(stepName, input, res.result)
            } else if (res.status === "skipped") {
              state = updateStep(state, stepName as OnboardingStepName, "skipped")
            } else {
              state = updateStep(state, stepName as OnboardingStepName, "failed", res.error?.message ?? "Execution failed")
            }
            writeOnboardingState(state, deps.homePath)
          } else if (res.status === "completed" || res.status === "reused") {
            // Sub-operations still refresh the inspect snapshot in place.
            updateInspectionFromStep(stepName, input, res.result)
          }
          if (res.status === "failed") {
            const code = res.error?.code ?? "STEP_FAILED"
            const message = res.error?.message ?? "执行失败"
            const failureMessage = `${operationLabel}失败 [${code}]: ${message}`
            const diagnostics = [
              failureMessage,
              res.error?.suggestion ? `Suggestion: ${res.error.suggestion}` : "",
              res.error?.details ?? "",
            ].filter(Boolean).join("\n")
            logger.log(`[${stepName}] ${diagnostics}`)
            deps.broadcastProgress?.({
              step: stepName,
              phase: "failed",
              message: failureMessage,
              suggestion: res.error?.suggestion,
              details: res.error?.details,
            })
          } else {
            const completionMessage = `${operationLabel}完成（${res.status}）`
            logger.log(`[${stepName}] ${completionMessage}`)
            deps.broadcastProgress?.({
              step: stepName,
              phase: "completed",
              message: completionMessage,
            })
          }
          return res
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const failureMessage = `${operationLabel}失败 [STEP_EXECUTION_ERROR]: ${msg}`
          const details = err instanceof Error ? err.stack : undefined
          logger.log(`[${stepName}] ${failureMessage}${details ? `\n${details}` : ""}`)
          deps.broadcastProgress?.({
            step: stepName,
            phase: "failed",
            message: failureMessage,
            details,
          })
          state = updateStep(state, stepName as OnboardingStepName, "failed", msg)
          if (isWizardStep) writeOnboardingState(state, deps.homePath)
          return {
            status: "failed",
            error: { code: "STEP_EXECUTION_ERROR", message: msg, details },
          }
        } finally {
          currentOperation = null
          currentAbortController = null
        }
      }

      currentOperation = run()
      return currentOperation
    },

    "onboarding-complete": async () => {
      const homePath = deps.homePath ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
      let inspection: Record<string, unknown> | null
      try {
        const result = await getInspection(homePath)
        inspection = result.result
      } catch (err) {
        return {
          status: "failed" as const,
          error: {
            code: "ONBOARDING_READINESS_CHECK_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }

      if (!inspection) {
        return {
          status: "failed" as const,
          error: {
            code: "ONBOARDING_READINESS_CHECK_FAILED",
            message: "Unable to verify Wopal runtime readiness.",
          },
        }
      }

      // Derive readiness from the snapshot: engine + ontology installed,
      // runtime prepared, and at least one registered space.
      const runtime = (inspection.runtime ?? {}) as Record<string, unknown>
      const ready =
        Boolean(inspection.engineInstalled) &&
        Boolean(inspection.ontologyInstalled) &&
        runtime.ready === true &&
        Array.isArray(inspection.spaces) &&
        inspection.spaces.length > 0

      if (!ready) {
        return {
          status: "failed" as const,
          result: inspection,
          error: {
            code: "ONBOARDING_NOT_READY",
            message: "Wopal runtime is not healthy yet.",
          },
        }
      }

      let state = readOnboardingState(deps.homePath) ?? createDefaultOnboardingState()
      state = markCompleted(state)
      if (!writeOnboardingState(state, homePath)) {
        return {
          status: "failed" as const,
          error: {
            code: "ONBOARDING_STATE_WRITE_FAILED",
            message: "Runtime is healthy, but the onboarding completion state could not be saved.",
          },
        }
      }
      // Persist WOPAL_HOME to user environment variables / shell profile
      ;(deps.persistWopalHomeEnv ?? noopPersistWopalHomeEnv)(homePath)
      // Onboarding finished — clear the debug log so a completed wizard
      // leaves no per-run trace behind.
      getOnboardingLogger(homePath).clear()
      return { status: "completed" as const, result: inspection }
    },

    "onboarding-cancel-step": async () => {
      if (currentAbortController) {
        currentAbortController.abort()
        return { status: "ok" }
      }
      return { status: "no-op" }
    },

    "onboarding-set-wopal-home": async (_event: unknown, newHomePath: string) => {
      if (typeof newHomePath === "string" && newHomePath.trim().length > 0) {
        const trimmed = newHomePath.trim()
        // Reject path traversal attacks or raw dangerous inputs
        if (trimmed.includes("\0") || trimmed.includes("..")) {
          return { status: "error", message: "Invalid or unsafe home path" }
        }
        const resolved = trimmed.startsWith("~") ? join(homedir(), trimmed.slice(1)) : trimmed
        deps.homePath = resolved
        process.env.WOPAL_HOME = resolved
        return { status: "ok", homePath: resolved }
      }
      return { status: "error", message: "Invalid home path" }
    },
  }
}
