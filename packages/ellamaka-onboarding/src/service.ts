/**
 * The onboarding orchestration engine.
 *
 * Owns state persistence (`$WOPAL_HOME/ellamaka/state/onboarding.json`),
 * step dispatch, the single-flight operation lock, operation timeout/cancel,
 * and the event stream consumed by the SSE layer. Contains no Electron or HTTP
 * coupling: the router is a thin translation layer on top.
 *
 * @module @wopal/ellamaka-onboarding/service
 */
import { EventEmitter } from "node:events"
import { spawnSync } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, userInfo } from "node:os"
import { dirname, join } from "node:path"

import {
  asRecord,
  ellamakaBinaryPath,
  getWopalHome,
  installWopalCli,
  readBoolean,
  readString,
  runSetupOperation,
  wopalBinaryPath,
} from "./machine-runner"
import {
  ONBOARDING_OPERATION_BUSY,
  ONBOARDING_STEPS,
  type OnboardingExecutableStep,
  type OnboardingProgressCallback,
  type OnboardingProbeResult,
  type OnboardingState,
  type OnboardingStateView,
  type OnboardingStepExecutor,
  type OnboardingStepName,
  type OnboardingStepResult,
  type OnboardingStepStatus,
} from "./types"

export { ONBOARDING_STEPS, ONBOARDING_OPERATION_BUSY }
export { getWopalHome }
export type { OnboardingStepName }

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export type { OnboardingState, OnboardingStateView, OnboardingStepResult, OnboardingStepStatus }

/** `$WOPAL_HOME/ellamaka/state/onboarding.json`. */
export function getOnboardingStatePath(home?: string): string {
  return join(getWopalHome(home), "ellamaka", "state", "onboarding.json")
}

export function createDefaultOnboardingState(): OnboardingState {
  const steps = ONBOARDING_STEPS.reduce(
    (acc, step) => {
      acc[step] = "pending"
      return acc
    },
    {} as Record<OnboardingStepName, OnboardingStepStatus>,
  )
  return {
    version: 1,
    currentStep: "system-check",
    steps,
    errors: {},
    completed: false,
    startedAt: null,
    updatedAt: null,
  }
}

function formatDateTimestamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** Legacy step-name aliases (pre-merge wizard names). */
const LEGACY_CURRENT_STEP: Record<string, OnboardingState["currentStep"]> = {
  "star-guide": "done",
  "install-wopal-cli": "install-cli",
  "install-ellamaka-cli": "install-cli",
  "github-auth": "ontology-setup",
}

const LEGACY_STEP_KEYS: Record<string, OnboardingStepName> = {
  "install-wopal-cli": "install-cli",
  "install-ellamaka-cli": "install-cli",
  "star-guide": "done",
}

function isValidStepName(value: unknown): value is OnboardingStepName {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value)
}

/** Whether `step` may be executed (wizard steps plus pseudo steps). */
export function isExecutableStep(value: unknown): value is OnboardingExecutableStep {
  return value === "inspect" || value === "github-auth" || isValidStepName(value)
}

/**
 * Read the state file, migrating legacy names and quarantining corrupted
 * files to a timestamped `.bak` backup.
 */
export function readOnboardingState(home?: string): OnboardingState | null {
  const statePath = getOnboardingStatePath(home)
  if (!existsSync(statePath)) return null

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as OnboardingState
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.steps !== "object") {
      throw new Error("Invalid schema structure")
    }

    const legacyCurrent = LEGACY_CURRENT_STEP[String(parsed.currentStep)]
    if (legacyCurrent) parsed.currentStep = legacyCurrent

    const steps = parsed.steps as Record<string, OnboardingStepStatus>
    for (const [legacyKey, nextKey] of Object.entries(LEGACY_STEP_KEYS)) {
      if (steps[legacyKey] !== undefined) {
        if (steps[nextKey] === undefined || steps[legacyKey] === "done") steps[nextKey] = steps[legacyKey]!
        delete steps[legacyKey]
      }
    }
    delete steps["github-auth"]

    return parsed
  } catch {
    try {
      renameSync(statePath, `${statePath}.bak.${formatDateTimestamp()}`)
    } catch {
      try {
        unlinkSync(statePath)
      } catch {
        // Best effort; the caller treats a missing file as "no state".
      }
    }
    return null
  }
}

/** Atomically write the state file (tmp + rename, 0600 on POSIX). */
export function writeOnboardingState(state: OnboardingState, home?: string): boolean {
  const statePath = getOnboardingStatePath(home)
  const dirPath = dirname(statePath)
  try {
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })
    const tmpPath = `${statePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8")
    if (process.platform !== "win32") chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, statePath)
    return true
  } catch (err) {
    console.error("[onboarding] Failed to write state:", err)
    return false
  }
}

function updateStep(
  state: OnboardingState,
  step: OnboardingStepName,
  status: OnboardingStepStatus,
  error?: string,
): OnboardingState {
  const now = new Date().toISOString()
  const nextErrors = { ...state.errors }
  if (error) nextErrors[step] = error
  else if (status !== "failed") delete nextErrors[step]
  return { ...state, currentStep: step, steps: { ...state.steps, [step]: status }, errors: nextErrors, updatedAt: now }
}

function markStarted(state: OnboardingState): OnboardingState {
  if (state.startedAt) return state
  const now = new Date().toISOString()
  return { ...state, startedAt: now, updatedAt: now }
}

function markCompleted(state: OnboardingState): OnboardingState {
  const now = new Date().toISOString()
  return { ...state, completed: true, currentStep: "done", steps: { ...state.steps, done: "done" }, updatedAt: now }
}

/** Thrown when an operation is requested while another one is running. */
export class OnboardingBusyError extends Error {
  readonly code = ONBOARDING_OPERATION_BUSY
  constructor(message = "另一个安装或配置任务仍在运行，请等待当前任务结束后再重试。") {
    super(message)
    this.name = "OnboardingBusyError"
  }
}

// ---------------------------------------------------------------------------
// Local environment probes (extracted from the Desktop main process)
// ---------------------------------------------------------------------------

export function resolveSystemUserName(): string {
  try {
    const res = spawnSync("git", ["config", "user.name"], { encoding: "utf8" })
    if (res.status === 0 && res.stdout?.trim()) return res.stdout.trim()
  } catch {}
  try {
    const info = userInfo()
    if (info?.username?.trim()) return info.username.trim()
  } catch {}
  return process.env.USER || process.env.USERNAME || process.env.LOGNAME || ""
}

export type LocalCliProbeResult = Record<string, unknown> & {
  installed: boolean
  binaryPath: string
  version?: string
  errorCode?: "CLI_BINARY_BROKEN"
  error?: string
}

export function probeLocalCli(binaryPath: string): LocalCliProbeResult {
  if (!existsSync(binaryPath)) return { installed: false, binaryPath }
  try {
    const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8" })
    if (result.status === 0) {
      const version = String(result.stdout ?? "").trim()
      return { installed: true, binaryPath, ...(version ? { version } : {}) }
    }
  } catch {}
  return {
    installed: false,
    binaryPath,
    errorCode: "CLI_BINARY_BROKEN",
    error: `检测到 CLI 文件，但无法执行版本检查：${binaryPath}`,
  }
}

export function probeWopalSpaceList(
  binPath: string,
  env?: Record<string, string>,
): Array<{ name: string; path: string; type?: string | null }> {
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

function probeGithubCli(): { installed: boolean; authenticated: boolean; account: string | null } {
  const version = spawnSync("gh", ["--version"], { stdio: "pipe", timeout: 3000 })
  if (version.status !== 0) return { installed: false, authenticated: false, account: null }

  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  const auth = spawnSync("gh", ["auth", "token"], { stdio: "pipe", env, timeout: 3000 })
  if (auth.status !== 0 || !auth.stdout?.toString().trim())
    return { installed: true, authenticated: false, account: null }

  const accountResult = spawnSync("gh", ["api", "user", "--jq", ".login"], { stdio: "pipe", env, timeout: 5000 })
  const account = accountResult.status === 0 ? accountResult.stdout?.toString().trim() || null : null
  return { installed: true, authenticated: true, account }
}

export function detectGithubToken(homePath?: string): { token: string; source: string } | null {
  const env = process.env
  if (env.GITHUB_TOKEN?.trim()) return { token: env.GITHUB_TOKEN.trim(), source: "github-token-env" }
  if (env.GH_TOKEN?.trim()) return { token: env.GH_TOKEN.trim(), source: "gh-token-env" }

  try {
    const res = spawnSync("gh", ["auth", "token"], { stdio: "pipe", timeout: 3000 })
    const token = res.status === 0 && res.stdout ? res.stdout.toString().trim() : ""
    if (token) return { token, source: "gh-cli" }
  } catch {}

  const envPath = join(homePath ?? getWopalHome(), ".env")
  if (existsSync(envPath)) {
    try {
      const match = readFileSync(envPath, "utf-8").match(/^(GITHUB_TOKEN|GH_TOKEN)=(.+)$/m)
      if (match?.[1]?.trim() && match[2]?.trim()) {
        const val = match[2].trim().replace(/^["']|["']$/g, "")
        if (val) return { token: val, source: match[1] === "GH_TOKEN" ? "wopal-gh-token" : "wopal-github-token" }
      }
    } catch {}
  }

  return null
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
    const account = readString(asRecord(await res.json())?.login)?.trim()
    return { account: account || null, valid: Boolean(account) }
  } catch {
    return { account: null, valid: false }
  }
}

export function loginGhWithToken(token: string): boolean {
  try {
    return spawnSync("gh", ["auth", "login", "--with-token"], { input: token, stdio: "pipe" }).status === 0
  } catch {
    // gh login failure is not fatal — the token still lands in `.env`.
    return false
  }
}

export function detectProviderAuth(homePath?: string, providerId = "opencode-go"): string | undefined {
  const authPath = join(homePath ?? getWopalHome(), "ellamaka", "data", "auth.json")
  if (existsSync(authPath)) {
    try {
      const parsed = JSON.parse(readFileSync(authPath, "utf-8"))
      if (parsed && parsed[providerId]?.key) return parsed[providerId].key
    } catch {}
  }
  return undefined
}

export function readEnvConfig(envPath: string) {
  if (!existsSync(envPath)) return null
  try {
    const envVars: Record<string, string> = {}
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const idx = trimmed.indexOf("=")
      if (idx > 0) {
        let val = trimmed.slice(idx + 1).trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
          val = val.slice(1, -1)
        envVars[trimmed.slice(0, idx).trim()] = val
      }
    }

    const enabled = envVars["WOPAL_MEMORY_ENABLED"] !== "false"
    const memoryInjectionEnabled = envVars["WOPAL_MEMORY_INJECTION_ENABLED"] !== "false"
    const llmEndpoint = envVars["WOPAL_LLM_BASE_URL"] || envVars["WOPAL_MEMORY_LLM_ENDPOINT"] || ""
    const llmModel = envVars["WOPAL_LLM_MODEL"] || envVars["WOPAL_MEMORY_LLM_MODEL"] || ""
    const embeddingEndpoint = envVars["WOPAL_EMBEDDING_BASE_URL"] || envVars["WOPAL_MEMORY_EMBEDDING_ENDPOINT"] || ""
    const embeddingModel = envVars["WOPAL_EMBEDDING_MODEL"] || envVars["WOPAL_MEMORY_EMBEDDING_MODEL"] || ""
    const hasLlmKey = Boolean(envVars["WOPAL_LLM_API_KEY"] || envVars["WOPAL_MEMORY_LLM_KEY"])
    const hasEmbeddingKey = Boolean(
      envVars["WOPAL_EMBEDDING_API_KEY"] || envVars["WOPAL_MEMORY_EMBEDDING_KEY"] || envVars["WOPAL_LLM_API_KEY"],
    )

    if (!("WOPAL_MEMORY_ENABLED" in envVars) && !(llmEndpoint || llmModel || embeddingModel || hasLlmKey)) return null

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

export function detectMemoryConfig(homePath: string) {
  const globalEnvPath = join(homePath, ".env")
  const globalConfig = readEnvConfig(globalEnvPath)

  let activeSpace: { name: string; path: string; type?: string | null } | null = null
  try {
    const isWin = process.platform === "win32"
    const spaces = probeWopalSpaceList(join(homePath, "bin", isWin ? "wopal.exe" : "wopal"), { WOPAL_HOME: homePath })
    if (spaces.length > 0) activeSpace = spaces[0]!
  } catch {}

  const spaceConfig = activeSpace?.path ? readEnvConfig(join(activeSpace.path, ".wopal", ".env")) : null
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
    effective && effective.enabled && (effective.llmEndpoint || effective.llmModel || effective.hasLlmKey),
  )
  const state = !effective ? "unconfigured" : !effective.enabled ? "disabled" : isReady ? "ready" : "incomplete"

  return {
    state,
    enabled: effective?.enabled ?? false,
    memoryInjectionEnabled: effective?.memoryInjectionEnabled ?? true,
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

export function writeMemoryEnvFile(
  targetEnvPath: string,
  payload: Record<string, unknown>,
  homePath?: string,
): boolean {
  try {
    const dir = dirname(targetEnvPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const envVars: Record<string, string> = {}
    if (existsSync(targetEnvPath)) {
      for (const line of readFileSync(targetEnvPath, "utf-8").split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const idx = trimmed.indexOf("=")
        if (idx > 0) envVars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
      }
    }

    const globalEnvVars: Record<string, string> = {}
    if (homePath) {
      const globalEnvPath = join(homePath, ".env")
      if (existsSync(globalEnvPath) && globalEnvPath !== targetEnvPath) {
        for (const line of readFileSync(globalEnvPath, "utf-8").split("\n")) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith("#")) continue
          const idx = trimmed.indexOf("=")
          if (idx > 0) globalEnvVars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
        }
      }
    }

    if (payload.enabled === false) {
      envVars["WOPAL_MEMORY_ENABLED"] = "false"
      delete envVars["WOPAL_MEMORY_INJECTION_ENABLED"]
    } else {
      envVars["WOPAL_MEMORY_ENABLED"] = "true"
      envVars["WOPAL_MEMORY_INJECTION_ENABLED"] = payload.memoryInjectionEnabled === false ? "false" : "true"
      const llmEndpoint = readString(payload.llmEndpoint)
      if (llmEndpoint) envVars["WOPAL_LLM_BASE_URL"] = llmEndpoint
      const llmModel = readString(payload.llmModel)
      if (llmModel) envVars["WOPAL_LLM_MODEL"] = llmModel

      const llmKey = readString(payload.llmKey)
      if (llmKey) envVars["WOPAL_LLM_API_KEY"] = llmKey
      else if (!envVars["WOPAL_LLM_API_KEY"] && globalEnvVars["WOPAL_LLM_API_KEY"])
        envVars["WOPAL_LLM_API_KEY"] = globalEnvVars["WOPAL_LLM_API_KEY"]!

      const embeddingEndpoint = readString(payload.embeddingEndpoint)
      if (embeddingEndpoint) envVars["WOPAL_EMBEDDING_BASE_URL"] = embeddingEndpoint
      const embeddingModel = readString(payload.embeddingModel)
      if (embeddingModel) envVars["WOPAL_EMBEDDING_MODEL"] = embeddingModel

      const embeddingKey = readString(payload.embeddingKey)
      if (embeddingKey) envVars["WOPAL_EMBEDDING_API_KEY"] = embeddingKey
      else if (payload.reuseEmbedding || !envVars["WOPAL_EMBEDDING_API_KEY"]) {
        const fallbackKey =
          envVars["WOPAL_LLM_API_KEY"] || globalEnvVars["WOPAL_EMBEDDING_API_KEY"] || globalEnvVars["WOPAL_LLM_API_KEY"]
        if (fallbackKey) envVars["WOPAL_EMBEDDING_API_KEY"] = fallbackKey
      }
    }

    writeFileSync(
      targetEnvPath,
      Object.entries(envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n",
      "utf-8",
    )
    return true
  } catch (err) {
    console.error(`[onboarding] Failed to write memory env file at ${targetEnvPath}:`, err)
    return false
  }
}

export function clearSpaceMemoryEnvFile(targetEnvPath: string): boolean {
  try {
    if (!existsSync(targetEnvPath)) return true
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
    const remaining: string[] = []
    for (const line of readFileSync(targetEnvPath, "utf-8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const idx = trimmed.indexOf("=")
      if (idx > 0 && !memoryKeys.has(trimmed.slice(0, idx).trim())) remaining.push(line)
    }
    writeFileSync(targetEnvPath, remaining.length > 0 ? remaining.join("\n") + "\n" : "", "utf-8")
    return true
  } catch (err) {
    console.error(`[onboarding] Failed to clear space memory env file at ${targetEnvPath}:`, err)
    return false
  }
}

export function resolveTargetEnvPath(homePath: string, scope?: string, spacePath?: string): string {
  if (scope === "space") {
    if (spacePath) return join(spacePath, ".wopal", ".env")
    const detected = detectMemoryConfig(homePath)
    if (detected?.effectiveSpace?.path) return join(detected.effectiveSpace.path, ".wopal", ".env")
    throw new Error("Space scope configuration requires a valid space path.")
  }
  return join(homePath, ".env")
}

export function buildMemoryOperationInput(input?: unknown, homePath?: string): Record<string, unknown> {
  const payload = asRecord(input) ?? {}
  const result: Record<string, unknown> = {}
  if (typeof payload.enabled === "boolean") result.enabled = payload.enabled
  if (payload.scope) result.scope = payload.scope
  if (payload.spaceMode) result.spaceMode = payload.spaceMode
  if (typeof payload.memoryInjectionEnabled === "boolean")
    result.memoryInjectionEnabled = payload.memoryInjectionEnabled

  if (typeof payload.spacePath === "string" && payload.spacePath) result.spacePath = payload.spacePath
  else if (payload.scope === "space" && homePath) {
    try {
      const detected = detectMemoryConfig(homePath)
      if (detected?.effectiveSpace?.path) result.spacePath = detected.effectiveSpace.path
    } catch {}
  }

  if (payload.enabled === false || payload.spaceMode === "disabled") {
    result.enabled = false
    return result
  }
  if (payload.spaceMode === "inherit") return result

  for (const field of ["llmEndpoint", "llmKey", "llmModel", "embeddingEndpoint", "embeddingKey", "embeddingModel"]) {
    if (typeof payload[field] === "string" && payload[field]) result[field] = payload[field]
  }
  return result
}

export function normalizeSetupResult(opRes: OnboardingStepResult): OnboardingStepResult {
  const raw = opRes.status
  if (raw === "completed" || raw === "reused" || raw === "skipped") {
    return { status: raw, result: opRes.result, error: opRes.error }
  }
  return { status: "failed", result: opRes.result, error: opRes.error }
}

export async function performSystemCheck(homePath: string): Promise<OnboardingStepResult> {
  let gitVersion: string | null = null
  try {
    const check = spawnSync("git", ["--version"])
    if (check.status === 0) gitVersion = check.stdout.toString().trim()
  } catch {}

  if (!gitVersion) {
    return {
      status: "failed",
      error: {
        code: "GIT_NOT_FOUND",
        message:
          "Git CLI binary was not found on system PATH. WopalSpace requires Git. Please install Git and try again.",
      },
    }
  }

  try {
    if (!existsSync(homePath)) mkdirSync(homePath, { recursive: true })
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
    } catch {}
  }
  if (!networkOk) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch("https://1.1.1.1", { method: "HEAD", signal: controller.signal })
      clearTimeout(timer)
      if (res.ok || res.status < 500) networkOk = true
    } catch {
      networkOk = false
    }
  }
  if (!networkOk) {
    return {
      status: "failed",
      error: {
        code: "NETWORK_OFFLINE",
        message:
          "Failed to connect to Wopal release CDN (download.coursedao.com). Please check your internet connection.",
      },
    }
  }

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
  } catch {}

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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface OnboardingServiceOptions {
  /** WOPAL_HOME override; defaults to the process env / `~/.wopal`. */
  home?: string
  /** Step executor injection seam (tests and hosts). Defaults to the real dispatcher. */
  executeStep?: OnboardingStepExecutor
  /** Invoked once `complete()` persists the finished state. */
  onComplete?: () => void | Promise<void>
  /** Wall-clock timeout for one execute operation. */
  timeoutMs?: number
}

const STEP_OPERATION_LABELS: Record<string, string> = {
  "system-check": "检查系统环境",
  "install-cli": "安装与配置基础组件",
  "github-auth": "配置 GitHub 认证",
  "ai-provider": "配置 AI Provider",
  "ontology-setup": "准备能力本体与运行时配置",
  "create-space": "创建或复用工作空间",
  "memory-config": "配置记忆系统",
  done: "完成空间设置",
}

export class OnboardingService {
  /** Progress/log/error/complete event stream (consumed by the SSE router). */
  readonly events = new EventEmitter()

  private home: string
  private readonly executeStepImpl: OnboardingStepExecutor | undefined
  private readonly onComplete: (() => void | Promise<void>) | undefined
  private readonly timeoutMs: number

  private currentOperation: Promise<OnboardingStepResult> | null = null
  private currentAbortController: AbortController | null = null
  private cancelRequested: (() => void) | null = null
  /** Set while a `cancel()` is in flight; forces the aborted result code. */
  private cancelled = false

  /** Last `wopal inspect` result, reused by probes within one process. */
  private inspectSnapshot: Record<string, unknown> | null = null

  constructor(options: OnboardingServiceOptions = {}) {
    this.home = getWopalHome(options.home)
    this.executeStepImpl = options.executeStep
    this.onComplete = options.onComplete
    this.timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
    this.events.setMaxListeners(64)
  }

  /** The active WOPAL_HOME. */
  getHome(): string {
    return this.home
  }

  /** Read-only view for `GET /api/onboarding/state`. */
  getState(): OnboardingStateView {
    const persisted = readOnboardingState(this.home)
    if (!persisted) {
      return { completed: false, currentStep: "system-check", completedSteps: [] }
    }
    return {
      completed: Boolean(persisted.completed),
      currentStep: persisted.currentStep,
      completedSteps: ONBOARDING_STEPS.filter((step) => persisted.steps?.[step] === "done"),
    }
  }

  /**
   * Execute one step. Serialized by the single-flight lock: a concurrent call
   * throws {@link OnboardingBusyError} rather than queueing.
   */
  async executeStep(step: OnboardingExecutableStep, input?: unknown): Promise<OnboardingStepResult> {
    if (!isExecutableStep(step)) {
      return {
        status: "failed",
        error: { code: "ONBOARDING_STEP_INVALID", message: `Invalid step name: ${String(step)}` },
      }
    }
    if (this.currentOperation !== null) throw new OnboardingBusyError()

    const operation = this.runStep(step, input)
    this.currentOperation = operation
    try {
      return await operation
    } finally {
      this.currentOperation = null
      this.currentAbortController = null
      this.cancelRequested = null
    }
  }

  /** Abort the running operation. Always safe to call; no-op when idle. */
  cancel(): { ok: true } {
    if (this.currentAbortController) {
      this.cancelled = true
      this.currentAbortController.abort()
      this.cancelRequested?.()
    }
    return { ok: true }
  }

  /** Persist `completed: true`, invoke `onComplete`, and emit `complete`. */
  async complete(): Promise<{ completed: true }> {
    let state = readOnboardingState(this.home) ?? createDefaultOnboardingState()
    state = markCompleted(state)
    writeOnboardingState(state, this.home)
    if (this.onComplete) await this.onComplete()
    this.events.emit("complete", { type: "complete", completed: true })
    return { completed: true }
  }

  /** A read-only probe. Rejected while an execute operation is running. */
  async probe(kind: string): Promise<OnboardingProbeResult> {
    if (this.currentOperation !== null) throw new OnboardingBusyError()
    return this.runProbe(kind)
  }

  // -- internals -----------------------------------------------------------

  private emit(type: "progress" | "log" | "error" | "complete", payload: Record<string, unknown>): void {
    // `error` is a reserved EventEmitter event: emitting it with no listener
    // throws. The stream is best-effort observability, so a missing listener
    // must never crash an operation — the SSE router attaches one per stream.
    if (type === "error" && this.events.listenerCount("error") === 0) return
    this.events.emit(type, { type, ...payload })
  }

  private logStep(step: string, message: string): void {
    this.emit("log", { step, message })
  }

  private async runStep(step: OnboardingExecutableStep, input?: unknown): Promise<OnboardingStepResult> {
    const isWizardStep = (ONBOARDING_STEPS as readonly string[]).includes(step)
    const label = STEP_OPERATION_LABELS[step] ?? step

    const startingMessage = `开始${label}…`
    this.logStep(step, startingMessage)
    this.emit("progress", { step, phase: "starting", message: startingMessage })

    let state = readOnboardingState(this.home) ?? createDefaultOnboardingState()
    state = markStarted(state)
    if (isWizardStep) {
      state = updateStep(state, step as OnboardingStepName, "in-progress")
      writeOnboardingState(state, this.home)
    }

    const abortController = new AbortController()
    this.currentAbortController = abortController
    this.cancelled = false

    let settleCancel!: () => void
    const cancelGate = new Promise<OnboardingStepResult>((resolve) => {
      settleCancel = () =>
        resolve({
          status: "failed",
          error: { code: "ONBOARDING_OPERATION_CANCELLED", message: `Operation '${step}' was cancelled.` },
        })
    })
    this.cancelRequested = settleCancel

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutGate = new Promise<OnboardingStepResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort()
        resolve({
          status: "failed",
          error: {
            code: "ONBOARDING_OPERATION_TIMEOUT",
            message: `Operation '${step}' timed out after ${this.timeoutMs}ms.`,
          },
        })
      }, this.timeoutMs)
    })

    const executor = this.executeStepImpl ?? this.defaultExecuteStep.bind(this)
    const running = executor(
      step,
      input,
      (progress) => {
        this.emit("progress", { step, ...progress })
      },
      abortController.signal,
    )
    // A late settlement after cancel/timeout must never crash the process.
    running.catch(() => {})

    let result: OnboardingStepResult
    try {
      result = await Promise.race([cancelGate, timeoutGate, running])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const details = err instanceof Error ? err.stack : undefined
      this.logStep(step, `${label}失败 [STEP_EXECUTION_ERROR]: ${msg}`)
      this.emit("progress", { step, phase: "failed", message: `${label}失败 [STEP_EXECUTION_ERROR]: ${msg}`, details })
      this.emit("error", { step, code: "STEP_EXECUTION_ERROR", message: msg, details })
      result = { status: "failed", error: { code: "STEP_EXECUTION_ERROR", message: msg, details } }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      this.cancelRequested = null
    }

    if (this.cancelled && result.status === "failed") {
      result = {
        status: "failed",
        error: { code: "ONBOARDING_OPERATION_CANCELLED", message: `Operation '${step}' was cancelled.` },
      }
    }

    // Persist the outcome for wizard steps; pseudo steps never touch the map.
    state = readOnboardingState(this.home) ?? state
    if (isWizardStep) {
      const wizardStep = step as OnboardingStepName
      if (result.status === "completed" || result.status === "reused") state = updateStep(state, wizardStep, "done")
      else if (result.status === "skipped") state = updateStep(state, wizardStep, "skipped")
      else state = updateStep(state, wizardStep, "failed", result.error?.message ?? "Execution failed")
      writeOnboardingState(state, this.home)
    }

    if (result.status === "failed") {
      const code = result.error?.code ?? "STEP_FAILED"
      const message = result.error?.message ?? "执行失败"
      const failureMessage = `${label}失败 [${code}]: ${message}`
      this.logStep(step, failureMessage)
      this.emit("error", { step, code, message, details: result.error?.details })
      this.emit("progress", {
        step,
        phase: "failed",
        message: failureMessage,
        suggestion: result.error?.suggestion,
        details: result.error?.details,
      })
    } else {
      const completionMessage = `${label}完成（${result.status}）`
      this.logStep(step, completionMessage)
      this.emit("progress", { step, phase: "completed", message: completionMessage })
    }

    return result
  }

  /** Reuse the last inspect result; run one when missing. */
  private async getInspection(): Promise<{
    result: Record<string, unknown> | null
    error: { code?: string; message: string } | null
  }> {
    if (this.inspectSnapshot) return { result: this.inspectSnapshot, error: null }

    const executor = this.executeStepImpl ?? this.defaultExecuteStep.bind(this)
    const res = await executor("inspect")
    if (res.status === "failed") {
      return { result: null, error: { code: res.error?.code, message: res.error?.message ?? "无法检查环境。" } }
    }
    this.inspectSnapshot = res.result ?? {}
    return { result: this.inspectSnapshot, error: null }
  }

  private async runProbe(kind: string): Promise<OnboardingProbeResult> {
    const homePath = this.home
    const binPath = wopalBinaryPath(homePath)

    switch (kind) {
      case "home":
        return { homePath, wopalHome: homePath }

      case "system-info": {
        let gitVersion: string | null = null
        try {
          const check = spawnSync("git", ["--version"])
          if (check.status === 0) gitVersion = check.stdout.toString().trim()
        } catch {}
        return { platform: process.platform, arch: process.arch, nodeVersion: process.version, gitVersion }
      }

      case "system-user":
        return { userName: resolveSystemUserName(), appVersion: process.env.OPENCODE_VERSION }

      case "wopal-cli":
        return probeLocalCli(binPath)

      case "ellamaka-cli":
        return probeLocalCli(ellamakaBinaryPath(homePath))

      case "ontology-setup":
      case "ontology": {
        const ontologyPath = join(homePath, "ontologies", "wopal-space-ontology")
        const pathExists = existsSync(ontologyPath)
        const { result: inspection, error } = await this.getInspection()
        if (!inspection) {
          return {
            status: "broken",
            ontologyInstalled: false,
            ontologyMode: null,
            ontologyPath,
            availableTypes: [],
            error: error?.message ?? "无法检查空间能力本体。",
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
          availableTypes: Array.isArray(inspection.availableTypes) ? inspection.availableTypes : [],
          error: status === "broken" ? "检测到本体目录，但它不是可复用的有效 Git 仓库。" : undefined,
        }
      }

      case "github-auth": {
        const tokenInfo = detectGithubToken(homePath)
        const ghCli = probeGithubCli()
        if (ghCli.authenticated) {
          return {
            detected: true,
            source: "gh-cli",
            account: ghCli.account,
            ghCliInstalled: ghCli.installed,
            ghCliAuthenticated: true,
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
            ghCliAuthenticated: false,
            tokenConfigured: false,
            tokenSource: null,
          }
        }
        const verification = await verifyGithubTokenViaApi(tokenInfo.token)
        return {
          detected: verification.valid,
          source: verification.valid ? tokenInfo.source : null,
          account: verification.account,
          ghCliInstalled: ghCli.installed,
          ghCliAuthenticated: ghCli.authenticated,
          tokenConfigured: true,
          tokenSource: tokenInfo.source,
        }
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
          const hasCapabilities =
            existsSync(join(homePath, "agents")) ||
            existsSync(join(homePath, "skills")) ||
            existsSync(join(homePath, "rules"))
          if (existsSync(ontologyDir) && hasCapabilities) {
            return {
              ready: true,
              homePath,
              config: { missingKeys: [] },
              scripts: { missing: [], stale: [] },
              capabilities: { missing: [], empty: [], stale: [] },
            }
          }
          const { result: inspection, error } = await this.getInspection()
          if (!inspection) return { ready: false, homePath, error: error?.message ?? "无法检查本体能力配置。" }
          const runtime = inspection.runtime
          if (!runtime || typeof runtime !== "object")
            return { ready: false, homePath, error: "检查结果缺少本体能力状态。" }
          return runtime as Record<string, unknown>
        } catch (err) {
          return { ready: false, homePath, error: err instanceof Error ? err.message : String(err) }
        }
      }

      case "environment": {
        const ontologyDir = join(homePath, "ontologies", "wopal-space-ontology")
        const installed = existsSync(join(ontologyDir, ".git")) || existsSync(ontologyDir)
        const { result: inspection, error } = await this.getInspection()
        if (!inspection) {
          return {
            availableTypes: [],
            spaces: [],
            ontologyInstalled: installed,
            ontologyMode: null,
            homePath,
            wopalHome: homePath,
            defaultSpacePath: join(homedir(), "WopalSpace"),
            error: error?.message ?? "无法检查工作空间环境。",
            errorCode: error?.code ?? "ENVIRONMENT_INSPECT_FAILED",
          }
        }
        const hasAvailableTypes = Array.isArray(inspection.availableTypes)
        return {
          availableTypes: hasAvailableTypes ? inspection.availableTypes : [{ type: "common", branch: "main" }],
          spaces: Array.isArray(inspection.spaces) ? inspection.spaces : [],
          ontologyInstalled: installed || Boolean(inspection.ontologyInstalled),
          ontologyMode: inspection.ontologyMode ?? null,
          homePath,
          wopalHome: homePath,
          defaultSpacePath: join(homedir(), "WopalSpace"),
          legacyContract: !hasAvailableTypes,
        }
      }

      case "memory": {
        try {
          const detected = detectMemoryConfig(homePath)
          if (detected) return detected as unknown as Record<string, unknown>
          const { result: inspection, error } = await this.getInspection()
          if (!inspection) {
            return {
              state: "unconfigured",
              enabled: false,
              envPath: join(homePath, ".env"),
              error: error?.message ?? "无法检查记忆配置。",
            }
          }
          const memory = asRecord(inspection.memory) ?? {}
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

      default:
        return { error: "Unknown probe kind" }
    }
  }

  /** The real step dispatcher: switch over wizard steps + pseudo steps. */
  async defaultExecuteStep(
    step: OnboardingExecutableStep,
    input?: unknown,
    onProgress?: OnboardingProgressCallback,
    abortSignal?: AbortSignal,
  ): Promise<OnboardingStepResult> {
    let homePath = this.home
    const binPath = wopalBinaryPath(homePath)

    switch (step) {
      case "inspect": {
        const res = normalizeSetupResult(
          await runSetupOperation({ binaryPath: binPath, operation: "inspect", input: {}, onProgress }),
        )
        if (res.status !== "failed") this.inspectSnapshot = res.result ?? {}
        return res
      }

      case "system-check": {
        const inputHome = readString(asRecord(input)?.customHomePath)
        const targetHome = inputHome?.trim() ? inputHome.trim() : homePath
        homePath = getWopalHome(targetHome)
        this.home = homePath
        process.env.WOPAL_HOME = homePath
        this.inspectSnapshot = null
        await this.getInspection()
        return performSystemCheck(homePath)
      }

      case "install-cli": {
        const subStep = asRecord(input)?.subStep
        if (!this.inspectSnapshot) await this.getInspection()

        if (subStep === "wopal") {
          const products = asRecord(this.inspectSnapshot?.products)
          const wopalCliInfo = asRecord(products?.wopalCli) ?? asRecord(products?.cli)
          if (wopalCliInfo?.installed) {
            return { status: "reused", result: { version: wopalCliInfo.version ?? undefined, upgraded: false } }
          }
          const res = await installWopalCli({
            homePath,
            forceUpgrade: readBoolean(asRecord(input)?.forceUpgrade),
            onProgress,
            abortSignal,
          })
          const cliProbe = probeLocalCli(binPath)
          if (res.status !== "failed" && cliProbe.version)
            return { ...res, result: { ...res.result, version: cliProbe.version } }
          return res
        }

        if (subStep === "ellamaka") {
          if (this.inspectSnapshot?.engineInstalled === true && existsSync(ellamakaBinaryPath(homePath))) {
            return {
              status: "reused",
              result: { version: this.inspectSnapshot.engineVersion ?? undefined, upgraded: false },
            }
          }
          return this.runInstallEngine(binPath, input, onProgress, abortSignal)
        }

        const wopalRes = await installWopalCli({
          homePath,
          forceUpgrade: readBoolean(asRecord(input)?.forceUpgrade),
          onProgress,
          abortSignal,
        })
        if (wopalRes.status === "failed") return wopalRes
        const ellamakaRes = await this.runInstallEngine(binPath, input, onProgress, abortSignal)
        if (ellamakaRes.status === "failed") return ellamakaRes
        return { status: "completed", result: { wopal: wopalRes.result, ellamaka: ellamakaRes.result } }
      }

      case "install-wopal-cli" as never:
        return installWopalCli({ homePath, onProgress, abortSignal })

      case "install-ellamaka-cli" as never:
        return this.runInstallEngine(binPath, input, onProgress, abortSignal)

      case "github-auth": {
        const payload = asRecord(input) ?? {}
        if (payload.skip) return { status: "skipped" }
        const token = readString(payload.token)?.trim() || detectGithubToken(homePath)?.token
        if (!token) return { status: "skipped" }

        const verification = await verifyGithubTokenViaApi(token)
        if (!verification.valid) {
          return {
            status: "failed",
            error: { code: "GITHUB_TOKEN_INVALID", message: "GitHub Token 无效，请检查后重试。" },
          }
        }

        const ghCli = probeGithubCli()
        const loginGh = ghCli.installed ? loginGhWithToken(token) : false

        const setupResult = normalizeSetupResult(
          await runSetupOperation({
            binaryPath: binPath,
            operation: "configure-github",
            input: { token },
            onProgress,
            abortSignal,
          }),
        )
        if (setupResult.status === "failed") return setupResult
        return {
          status: "completed",
          result: { ...setupResult.result, verified: true, account: verification.account, loginGh },
        }
      }

      case "ai-provider": {
        const payload = asRecord(input) ?? {}
        const providerId = readString(payload.provider) || readString(payload.providerId) || "opencode-go"
        const apiKey = readString(payload.apiKey)?.trim() || detectProviderAuth(homePath, providerId)
        if (payload.skip || !apiKey) return { status: "skipped" }
        return normalizeSetupResult(
          await runSetupOperation({
            binaryPath: binPath,
            operation: "configure-provider",
            input: { providerId, apiKey },
            onProgress,
            abortSignal,
          }),
        )
      }

      case "ontology-setup": {
        const payload = asRecord(input) ?? {}
        const mode = readString(payload.mode) === "fork" ? "fork" : "clone"
        const source = readString(payload.source)
        const opInput: Record<string, unknown> = { mode }
        if (source) opInput.source = source

        const ontRes = normalizeSetupResult(
          await runSetupOperation({
            binaryPath: binPath,
            operation: "prepare-ontology",
            input: opInput,
            onProgress,
            abortSignal,
          }),
        )
        if (ontRes.status !== "completed" && ontRes.status !== "reused") return ontRes

        try {
          const runtimeRes = normalizeSetupResult(
            await runSetupOperation({
              binaryPath: binPath,
              operation: "prepare-runtime",
              input: {},
              onProgress,
              abortSignal,
            }),
          )
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { status: "failed", error: { code: "PREPARE_RUNTIME_FAILED", message: `运行时准备失败：${msg}` } }
        }
        return ontRes
      }

      case "create-space": {
        const payload = asRecord(input) ?? {}
        if (payload.skip) {
          const inspectRes = await runSetupOperation({ binaryPath: binPath, operation: "inspect", input: {} })
          const spaces = asRecord(inspectRes.result)?.spaces
          if (!Array.isArray(spaces) || spaces.length === 0) {
            return {
              status: "failed",
              error: {
                code: "NO_EXISTING_SPACE",
                message: "Cannot skip space creation on a fresh environment. At least one Space must be registered.",
              },
            }
          }
          return { status: "skipped" }
        }
        const path = readString(payload.path)
        if (!path) return { status: "failed", error: { code: "INVALID_INPUT", message: "Space path is required." } }
        return normalizeSetupResult(
          await runSetupOperation({
            binaryPath: binPath,
            operation: "initialize-space",
            input: { path, type: readString(payload.type) || undefined },
            onProgress,
            abortSignal,
          }),
        )
      }

      case "memory-config": {
        if (asRecord(input)?.skip) {
          return {
            status: "skipped",
            result: { memoryEnabled: false, scope: "global", state: "unconfigured", outcome: "skipped" },
          }
        }

        const memInput = buildMemoryOperationInput(input, homePath)
        const isSpaceScope = memInput.scope === "space"
        const spaceMode = readString(memInput.spaceMode) || (isSpaceScope ? "custom" : undefined)
        const targetEnvPath = resolveTargetEnvPath(homePath, readString(memInput.scope), readString(memInput.spacePath))

        if (isSpaceScope && spaceMode === "inherit") clearSpaceMemoryEnvFile(targetEnvPath)
        else writeMemoryEnvFile(targetEnvPath, memInput, homePath)

        let cliResult: OnboardingStepResult | null = null
        if (!isSpaceScope) {
          try {
            cliResult = normalizeSetupResult(
              await runSetupOperation({
                binaryPath: binPath,
                operation: "configure-memory",
                input: memInput,
                onProgress,
                abortSignal,
              }),
            )
          } catch {}
        }

        const globalConfig = readEnvConfig(join(homePath, ".env"))
        const inherit = isSpaceScope && spaceMode === "inherit"
        const memoryEnabled = inherit ? Boolean(globalConfig?.enabled) : memInput.enabled !== false
        return {
          status: "completed",
          result: {
            memoryEnabled,
            memoryInjectionEnabled: inherit
              ? globalConfig?.memoryInjectionEnabled !== false
              : memInput.memoryInjectionEnabled !== false,
            scope: isSpaceScope ? "space" : "global",
            spaceMode: isSpaceScope ? spaceMode : undefined,
            envPath: inherit ? join(homePath, ".env") : targetEnvPath,
            llmEndpoint: inherit
              ? (globalConfig?.llmEndpoint ?? "")
              : (memInput.llmEndpoint ?? readString(cliResult?.result?.llmEndpoint) ?? ""),
            llmModel: inherit
              ? (globalConfig?.llmModel ?? "")
              : (memInput.llmModel ?? readString(cliResult?.result?.llmModel) ?? ""),
            embeddingEndpoint: inherit
              ? (globalConfig?.embeddingEndpoint ?? "")
              : (memInput.embeddingEndpoint ?? readString(cliResult?.result?.embeddingEndpoint) ?? ""),
            embeddingModel: inherit
              ? (globalConfig?.embeddingModel ?? "")
              : (memInput.embeddingModel ?? readString(cliResult?.result?.embeddingModel) ?? ""),
            llmKeyConfigured: inherit
              ? Boolean(globalConfig?.hasLlmKey)
              : Boolean(memInput.llmKey || cliResult?.result?.llmKeyConfigured),
            embeddingKeyConfigured: inherit
              ? Boolean(globalConfig?.hasEmbeddingKey)
              : Boolean(memInput.embeddingKey || cliResult?.result?.embeddingKeyConfigured),
            state: memoryEnabled ? "ready" : "disabled",
            outcome: inherit ? "cleared" : "saved",
          },
        }
      }

      case "done":
      case "star-guide" as never: {
        const payload = asRecord(input) ?? {}
        if (payload.skip) return { status: "skipped" }
        return normalizeSetupResult(
          await runSetupOperation({
            binaryPath: binPath,
            operation: "star",
            input: { repo: "wopal-cn/wopal-space-ontology", accepted: true, browserFallback: true },
            onProgress,
          }),
        )
      }

      default:
        return { status: "failed", error: { code: "ONBOARDING_STEP_INVALID", message: `Unknown step: ${step}` } }
    }
  }

  private async runInstallEngine(
    binPath: string,
    input: unknown,
    onProgress?: OnboardingProgressCallback,
    abortSignal?: AbortSignal,
  ): Promise<OnboardingStepResult> {
    const payload = { ...asRecord(input) }
    delete payload.homePath
    delete payload.forkUrl
    delete payload.subStep
    if (!payload.requirements || typeof payload.requirements !== "object") payload.requirements = {}
    return normalizeSetupResult(
      await runSetupOperation({
        binaryPath: binPath,
        operation: "install-engine",
        input: payload,
        onProgress,
        abortSignal,
      }),
    )
  }
}
