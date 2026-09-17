/**
 * `wopal setup --machine` subprocess management.
 *
 * Extracted from the Desktop main-process implementation: the machine
 * capability contract is unchanged (`wopal setup --machine --json
 * --api-version 1`), only the Electron coupling is gone. The runner owns two
 * concerns:
 *
 * - `runSetupOperation`: spawn one machine operation, validate its JSON
 *   envelope, map CLI statuses onto the onboarding result contract, forward
 *   non-envelope output lines as progress, and enforce timeout/abort by
 *   terminating the whole child process tree.
 * - `installWopalCli`: the Wopal CLI bootstrap (site installer script), which
 *   is not a machine operation and therefore has its own lifecycle.
 *
 * @module @wopal/ellamaka-onboarding/machine-runner
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import type { OnboardingProgressCallback, OnboardingStepResult } from "./types"

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** Resolve `$WOPAL_HOME` with `~` expansion, defaulting to `~/.wopal`. */
export function getWopalHome(customHome?: string): string {
  const raw = customHome ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
  if (raw.startsWith("~")) return join(homedir(), raw.slice(1))
  return raw
}

/** `$WOPAL_HOME/bin/wopal` (`.exe` on Windows). */
export function wopalBinaryPath(homePath: string): string {
  return join(homePath, "bin", process.platform === "win32" ? "wopal.exe" : "wopal")
}

/** `$WOPAL_HOME/bin/ellamaka` (`.exe` on Windows). */
export function ellamakaBinaryPath(homePath: string): string {
  return join(homePath, "bin", process.platform === "win32" ? "ellamaka.exe" : "ellamaka")
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Signal a child process tree (process group on POSIX, `taskkill /t` on Windows). */
function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.unref()
      return
    } catch {}
  }

  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {}
  }

  try {
    child.kill(signal)
  } catch {}
}

/** Terminate a child process tree: SIGTERM, then SIGKILL after a grace period. */
export async function terminateChildProcessTree(child: ChildProcess, graceMs = 1500): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return

  let exited = false
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true
      resolve()
    })
  })

  signalProcessTree(child, "SIGTERM")
  if (child.exitCode != null || child.signalCode != null) return
  await Promise.race([exitPromise, wait(graceMs)])

  if (!exited && child.exitCode == null && child.signalCode == null) {
    signalProcessTree(child, "SIGKILL")
    await Promise.race([exitPromise, wait(500)])
  }
}

// ---------------------------------------------------------------------------
// JSON envelope parsing
// ---------------------------------------------------------------------------

/**
 * Extract the machine capability JSON envelope from combined output. The
 * envelope is a single multi-line object printed at the end of the run; ANSI
 * escape codes are stripped and the LAST valid envelope wins (progress output
 * may itself contain JSON-ish lines).
 */
export function extractJsonEnvelope(stdout: string, stderr: string): any | null {
  const combined = stdout + "\n" + stderr
  const clean = combined.replace(/\u001b\[[0-9;]*[mGK]/g, "")
  const jsonMatches = clean.match(/\{[\s\S]*"ok"\s*:\s*(true|false)[\s\S]*\}/g)
  if (jsonMatches) {
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonMatches[i]!)
        if (parsed && typeof parsed.ok === "boolean") return parsed
      } catch {}
    }
  }
  return null
}

function sanitizeDiagnosticText(value: string, maxLength = 2000): string {
  return value
    .replace(/\u001b\[[0-9;]*[mGK]/g, "")
    .replace(/(?:gh[pousr]_[a-zA-Z0-9]{20,}|sk-[a-zA-Z0-9_-]{16,})/g, "***")
    .trim()
    .slice(-maxLength)
}

function buildOperationDetails(input: {
  operation: string
  command: string
  args: string[]
  exitCode: number | null
  stderr?: string
  stdout?: string
  upstreamDetails?: string
}): string {
  const lines = [
    `Operation: ${input.operation}`,
    `Command: ${input.command} ${input.args.join(" ")}`,
    `Exit code: ${input.exitCode ?? "unknown"}`,
  ]
  const upstreamDetails = sanitizeDiagnosticText(input.upstreamDetails ?? "")
  const stderr = sanitizeDiagnosticText(input.stderr ?? "")
  const stdout = sanitizeDiagnosticText(input.stdout ?? "")
  if (upstreamDetails) lines.push(`Details: ${upstreamDetails}`)
  if (stderr) lines.push(`Stderr: ${stderr}`)
  if (stdout) lines.push(`Stdout: ${stdout}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Version comparison (self-contained; no semver dependency)
// ---------------------------------------------------------------------------

/** Parse a version string into `[major, minor, patch]`, tolerating `v` prefixes. */
export function parseSemver(version: string): number[] {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return [0, 0, 0]
  return [parseInt(match[1]!, 10), parseInt(match[2]!, 10), parseInt(match[3]!, 10)]
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// Machine operation runner
// ---------------------------------------------------------------------------

export interface RunSetupOperationOptions {
  binaryPath: string
  operation: string
  input?: Record<string, unknown>
  onProgress?: OnboardingProgressCallback
  timeoutMs?: number
  inactivityTimeoutMs?: number
  abortSignal?: AbortSignal
  spawnFn?: (command: string, args: string[], options: any) => ChildProcess
}

/**
 * Resolve the CLI entry to spawn. Development runs may point at a TypeScript
 * source entry (`WOPAL_DEV_CLI_PATH`), which must be executed through `bun`.
 */
export function resolveWopalCliEntry(binaryPath: string): { command: string; spawnArgs: string[] } | null {
  if (process.env.WOPAL_DEV_CLI_PATH && existsSync(process.env.WOPAL_DEV_CLI_PATH)) {
    if (process.env.WOPAL_DEV_CLI_PATH.endsWith(".ts")) {
      return {
        command: "bun",
        spawnArgs: [process.env.WOPAL_DEV_CLI_PATH, "setup", "--machine", "--json", "--api-version", "1"],
      }
    }
  }

  if (existsSync(binaryPath)) {
    return { command: binaryPath, spawnArgs: ["setup", "--machine", "--json", "--api-version", "1"] }
  }

  return null
}

/**
 * Run one `wopal setup --machine` operation and normalize the response.
 *
 * Timeout semantics: a hard wall-clock timeout per operation (10 min for
 * engine install, 5 min for ontology preparation, 2 min otherwise) plus an
 * inactivity timeout for engine downloads (45 s without output = stalled).
 */
export async function runSetupOperation(options: RunSetupOperationOptions): Promise<OnboardingStepResult> {
  const { binaryPath, operation, input = {}, onProgress, spawnFn, abortSignal } = options
  const timeoutMs =
    options.timeoutMs ?? (operation === "install-engine" ? 600000 : operation === "prepare-ontology" ? 300000 : 120000)
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? (operation === "install-engine" ? 45000 : 0)

  const resolved = resolveWopalCliEntry(binaryPath)
  if (!resolved && !spawnFn) {
    return {
      status: "failed",
      error: {
        code: "WOPAL_BINARY_NOT_FOUND",
        message: `Wopal CLI entry/binary not found at ${binaryPath}. Please verify installation.`,
      },
    }
  }

  const command = resolved?.command ?? binaryPath
  const spawnArgs = resolved?.spawnArgs ?? ["setup", "--machine", "--json", "--api-version", "1"]

  // Version floor gate: only enforced when the floor is configured (build-time
  // injection or process env). Never touches the network.
  if (!spawnFn) {
    const minVersion = process.env.MIN_WOPAL_CLI_VERSION
    if (minVersion) {
      try {
        const versionResult = spawnSync(command, ["--version"])
        if (versionResult.stdout) {
          const actual = versionResult.stdout.toString().trim().replace(/^v/, "")
          if (actual && compareSemver(actual, minVersion) < 0) {
            return {
              status: "failed",
              error: {
                code: "WOPAL_CLI_INCOMPATIBLE",
                message: `Wopal CLI version too low (${actual}). Minimum required is ${minVersion}.`,
              },
            }
          }
        }
      } catch {
        // Version probe failure is not fatal; the operation itself still runs.
      }
    }
  }

  const payload = JSON.stringify({ operation, ...input })
  const spawnImpl = spawnFn ?? spawn

  // Always carry an explicit WOPAL_HOME to the wopal CLI subprocess so every
  // operation targets the same user-chosen home.
  const effectiveHome = readString(input.homePath)?.trim() || process.env.WOPAL_HOME?.trim()
  const env = {
    ...process.env,
    ...(effectiveHome ? { WOPAL_HOME: effectiveHome } : {}),
  }

  return new Promise((resolve) => {
    let stdoutData = ""
    let stderrData = ""
    let isSettled = false
    let envelopeStarted = false
    let stderrEnvelopeStarted = false
    let child: ChildProcess
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      clearTimeout(timer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      abortSignal?.removeEventListener("abort", abortHandler)
    }

    const stop = async (result: OnboardingStepResult) => {
      if (isSettled) return
      isSettled = true
      cleanup()
      await terminateChildProcessTree(child)
      resolve(result)
    }

    const resetInactivityTimer = () => {
      if (inactivityTimeoutMs <= 0) return
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => {
        void stop({
          status: "failed",
          error: {
            code: "ENGINE_DOWNLOAD_STALLED",
            message: "Ellamaka AI 引擎下载长时间无响应，已停止本次安装。",
            suggestion: "请检查网络连接或代理设置，确认网络恢复后点击下方“重试安装”。",
            details: `Operation '${operation}' produced no output for ${inactivityTimeoutMs}ms.`,
          },
        })
      }, inactivityTimeoutMs)
    }

    const abortHandler = () => {
      void stop({
        status: "failed",
        error: { code: "SETUP_OPERATION_ABORTED", message: `Operation '${operation}' was aborted.` },
      })
    }

    const timer = setTimeout(() => {
      void stop({
        status: "failed",
        error:
          operation === "install-engine"
            ? {
                code: "ENGINE_INSTALL_TIMEOUT",
                message: "Ellamaka AI 引擎安装超时，已停止本次安装。",
                suggestion: "请检查网络连接或代理设置，确认网络恢复后点击下方“重试安装”。",
                details: `Operation '${operation}' timed out after ${timeoutMs}ms.`,
              }
            : {
                code: "SETUP_OPERATION_TIMEOUT",
                message: `Operation '${operation}' timed out after ${timeoutMs}ms.`,
              },
      })
    }, timeoutMs)

    try {
      child = spawnImpl(command, spawnArgs, {
        env,
        stdio: "pipe",
        detached: process.platform !== "win32",
      })
    } catch (err) {
      clearTimeout(timer)
      return resolve({
        status: "failed",
        error: {
          code: "SETUP_SPAWN_ERROR",
          message: `Failed to spawn setup process: ${err instanceof Error ? err.message : String(err)}`,
        },
      })
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        abortHandler()
        return
      }
      abortSignal.addEventListener("abort", abortHandler)
    }

    resetInactivityTimer()

    child.stdout?.on("data", (chunk: any) => {
      if (isSettled) return
      resetInactivityTimer()
      const str = chunk.toString()
      stdoutData += str
      // Forward progress lines until the JSON envelope starts (its root line
      // begins with "{"); everything after that belongs to the envelope.
      if (envelopeStarted) return
      for (const line of str.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith("{")) {
          envelopeStarted = true
          return
        }
        onProgress?.({ phase: operation, message: trimmed })
      }
    })

    child.stderr?.on("data", (chunk: any) => {
      if (isSettled) return
      resetInactivityTimer()
      const str = chunk.toString()
      stderrData += str
      if (stderrEnvelopeStarted) return
      for (const line of str.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith("{")) {
          stderrEnvelopeStarted = true
          return
        }
        onProgress?.({ phase: operation, message: trimmed })
      }
    })

    child.stdin?.write(payload)
    child.stdin?.end()

    child.on("exit", (code) => {
      if (isSettled) return
      isSettled = true
      cleanup()

      const envelope = extractJsonEnvelope(stdoutData, stderrData)
      if (envelope && typeof envelope === "object") {
        if (envelope.capability !== "setup.operation") {
          return resolve({
            status: "failed",
            error: {
              code: "SETUP_RESPONSE_INVALID",
              message: `Unexpected capability '${envelope.capability}' in response. Expected 'setup.operation'.`,
            },
          })
        }

        if (envelope.ok === true && envelope.data) {
          if (envelope.data.operation !== operation) {
            return resolve({
              status: "failed",
              error: {
                code: "SETUP_RESPONSE_INVALID",
                message: `Response operation '${envelope.data.operation}' does not match requested '${operation}'.`,
              },
            })
          }
          if (!envelope.data.result || typeof envelope.data.result !== "object") {
            return resolve({
              status: "failed",
              error: {
                code: "SETUP_RESPONSE_INVALID",
                message: "Response data.result is missing or not an object.",
              },
            })
          }

          // CLI status → onboarding status: created → completed, reused,
          // skipped pass through.
          const cliStatus = envelope.data.status as string
          const mapped =
            cliStatus === "created"
              ? "completed"
              : cliStatus === "reused"
                ? "reused"
                : cliStatus === "skipped"
                  ? "skipped"
                  : "__invalid__"

          if (mapped === "__invalid__") {
            return resolve({
              status: "failed",
              error: { code: "SETUP_RESPONSE_INVALID", message: `Unknown CLI status '${cliStatus}' in response.` },
            })
          }

          return resolve({
            status: mapped as OnboardingStepResult["status"],
            result: (envelope.data.result ?? {}) as Record<string, unknown>,
          })
        }

        if (envelope.ok === false && envelope.error) {
          const upstreamDetails = typeof envelope.error.details === "string" ? envelope.error.details : undefined
          return resolve({
            status: "failed",
            error: {
              code: envelope.error.code ?? "SETUP_OPERATION_FAILED",
              message: envelope.error.message ?? "Operation failed",
              suggestion: typeof envelope.error.suggestion === "string" ? envelope.error.suggestion : undefined,
              details: buildOperationDetails({
                operation,
                command,
                args: spawnArgs,
                exitCode: code,
                stderr: stderrData,
                upstreamDetails,
              }),
            },
          })
        }
      }

      resolve({
        status: "failed",
        error: {
          code: "SETUP_RESPONSE_INVALID",
          message: `Setup machine operation '${operation}' returned invalid output or exit code ${code}.`,
          details: buildOperationDetails({
            operation,
            command,
            args: spawnArgs,
            exitCode: code,
            stderr: stderrData,
            stdout: stdoutData,
          }),
        },
      })
    })

    child.on("error", (err: Error) => {
      if (isSettled) return
      isSettled = true
      cleanup()
      resolve({
        status: "failed",
        error: { code: "SETUP_PROCESS_ERROR", message: `Setup process encountered error: ${err.message}` },
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Wopal CLI bootstrap
// ---------------------------------------------------------------------------

export interface InstallWopalCliOptions {
  homePath?: string
  forceUpgrade?: boolean
  onProgress?: OnboardingProgressCallback
  spawnFn?: (command: string, args: string[], options: any) => ChildProcess
  fetchInstallerScript?: (platform: string, signal?: AbortSignal) => Promise<string>
  fetchLatestVersion?: () => Promise<string | null>
  abortSignal?: AbortSignal
  timeoutMs?: number
  fetchTimeoutMs?: number
}

export async function fetchDefaultLatestWopalVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch("https://download.coursedao.com/wopal-cli/latest/manifest.json", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (res.ok) {
      const data = (await res.json()) as { version?: string }
      if (data.version) return data.version
    }
  } catch {
    // Network probe failure means "no newer version known", not an error.
  }
  return null
}

function isNewerVersion(localVer: string, latestVer: string): boolean {
  return compareSemver(latestVer, localVer) > 0
}

/**
 * Install or reuse the Wopal CLI through the official site installer.
 *
 * The installer script's final `exec wopal setup` line is neutralized so the
 * bootstrap never replaces this process; the CLI is verified afterwards by
 * executing the installed binary's `--version`.
 */
export async function installWopalCli(options: InstallWopalCliOptions = {}): Promise<OnboardingStepResult> {
  const homePath = getWopalHome(options.homePath)
  const isWin = process.platform === "win32"
  const binName = isWin ? "wopal.exe" : "wopal"
  const binPath = join(homePath, "bin", binName)

  if (options.abortSignal?.aborted) {
    return { status: "failed", error: { code: "INSTALLATION_ABORTED", message: "Wopal CLI 安装已取消。" } }
  }

  let localVersion: string | null = null
  if (existsSync(binPath)) {
    try {
      const check = spawnSync(binPath, ["--version"])
      if (check.status === 0) localVersion = check.stdout.toString().trim()
    } catch {
      // Unreadable existing binary falls through to reinstall.
    }
  }

  const fetcher = options.fetchLatestVersion ?? fetchDefaultLatestWopalVersion

  if (localVersion && !options.forceUpgrade) {
    try {
      const latestVer = await fetcher()
      if (latestVer && isNewerVersion(localVersion, latestVer)) {
        options.onProgress?.({
          phase: "upgrading",
          message: `Detected newer wopal CLI version ${latestVer} (current: ${localVersion}). Upgrading...`,
        })
      } else {
        return {
          status: "reused",
          result: { binaryPath: binPath, version: localVersion, latestVersion: latestVer ?? localVersion },
        }
      }
    } catch {
      return { status: "reused", result: { binaryPath: binPath, version: localVersion } }
    }
  }

  options.onProgress?.({ phase: "downloading-installer", message: "Fetching latest wopal installer script..." })

  let scriptContent = ""
  const installerUrl = isWin ? "https://wopal.cn/install.ps1" : "https://wopal.cn/install.sh"
  const fetchController = new AbortController()
  const abortFetch = () => fetchController.abort()
  const fetchTimer = setTimeout(abortFetch, options.fetchTimeoutMs ?? 30000)
  options.abortSignal?.addEventListener("abort", abortFetch, { once: true })
  try {
    if (options.fetchInstallerScript) {
      scriptContent = await options.fetchInstallerScript(process.platform, fetchController.signal)
    } else {
      const resp = await fetch(installerUrl, { signal: fetchController.signal })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      scriptContent = await resp.text()
    }
  } catch (err) {
    if (options.abortSignal?.aborted) {
      return { status: "failed", error: { code: "INSTALLATION_ABORTED", message: "Wopal CLI 安装已取消。" } }
    }
    if (fetchController.signal.aborted) {
      return {
        status: "failed",
        error: { code: "INSTALLER_DOWNLOAD_TIMEOUT", message: "下载安装程序超时，请检查网络连接后重试。" },
      }
    }
    return {
      status: "failed",
      error: {
        code: "INSTALLER_DOWNLOAD_FAILED",
        message: `Failed to download installer from ${installerUrl}: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  } finally {
    clearTimeout(fetchTimer)
    options.abortSignal?.removeEventListener("abort", abortFetch)
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "wopal-install-"))
  const scriptPath = join(tmpDir, isWin ? "install.ps1" : "install.sh")

  let modifiedScript = scriptContent
  if (!isWin) {
    modifiedScript = scriptContent.replace(
      /exec\s+"\$\{WOPAL_BIN\}\/wopal"\s+setup\s*<\s*\/dev\/tty/,
      'echo "Installation complete. Run wopal setup manually."',
    )
  }
  writeFileSync(scriptPath, modifiedScript, "utf-8")

  options.onProgress?.({ phase: "installing", message: "Executing wopal CLI installer..." })

  const spawnImpl = options.spawnFn ?? spawn
  const cmd = isWin ? "powershell" : "bash"
  const isDev = !!process.env.ELLAMAKA_DESKTOP_DEV
  const args = isWin
    ? ["-ExecutionPolicy", "Bypass", "-File", scriptPath, "-NoModifyPath", "-UpdateOnly"]
    : [scriptPath, ...(isDev ? ["--no-modify-path"] : [])]
  if (options.forceUpgrade) args.push(isWin ? "-Force" : "--force")

  const env = {
    ...process.env,
    WOPAL_HOME: homePath,
    CI: "1",
    NONINTERACTIVE: "1",
    DEBIAN_FRONTEND: "noninteractive",
    WOPAL_INSTALLER_NO_SETUP: "1",
  }

  return new Promise((resolve) => {
    let child: ChildProcess
    let isSettled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      options.abortSignal?.removeEventListener("abort", abortHandler)
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // Best-effort temp cleanup.
      }
    }

    const stop = async (result: OnboardingStepResult) => {
      if (isSettled) return
      isSettled = true
      cleanup()
      await terminateChildProcessTree(child)
      resolve(result)
    }

    const abortHandler = () => {
      void stop({ status: "failed", error: { code: "INSTALLATION_ABORTED", message: "Wopal CLI 安装已取消。" } })
    }

    try {
      child = spawnImpl(cmd, args, { env, stdio: "pipe", detached: process.platform !== "win32" })
    } catch (err) {
      cleanup()
      return resolve({
        status: "failed",
        error: { code: "SPAWN_EXCEPTION", message: err instanceof Error ? err.message : String(err) },
      })
    }

    options.abortSignal?.addEventListener("abort", abortHandler, { once: true })
    timer = setTimeout(() => {
      void stop({
        status: "failed",
        error: {
          code: "INSTALLATION_TIMEOUT",
          message: "Wopal CLI 安装超过 5 分钟，已终止当前下载。请检查网络后重试。",
        },
      })
    }, options.timeoutMs ?? 300000)

    let stdoutLog = ""
    let stderrLog = ""

    const forward = (chunk: any, sink: "stdout" | "stderr") => {
      if (isSettled) return
      const clean = chunk.toString().replace(/\x1b\[[0-9;]*m/g, "")
      if (sink === "stdout") stdoutLog += clean
      else stderrLog += clean
      if (clean.trim()) options.onProgress?.({ phase: "installing", message: clean.trim() })
    }

    child.stdout?.on("data", (chunk: any) => forward(chunk, "stdout"))
    child.stderr?.on("data", (chunk: any) => forward(chunk, "stderr"))

    child.on("exit", (code: number | null) => {
      if (isSettled) return
      isSettled = true
      cleanup()

      const fullLog = (stdoutLog + stderrLog).trim()
      const expectedPath = join(homePath, "bin", binName)
      options.onProgress?.({
        phase: "verifying",
        message: `检查安装路径: ${expectedPath}, 二进制存在: ${existsSync(expectedPath)}, exit code: ${code}`,
      })

      if (existsSync(expectedPath)) {
        try {
          const verCheck = spawnSync(expectedPath, ["--version"])
          if (verCheck.status === 0) {
            return resolve({
              status: "completed",
              result: { binaryPath: expectedPath, version: verCheck.stdout.toString().trim() || localVersion },
            })
          }
        } catch {
          // Falls through to the failure result below.
        }
      }

      resolve({
        status: "failed",
        error: {
          code: "INSTALLATION_FAILED",
          message: `安装程序执行失败 (exit ${code}): ${fullLog || `binary not found at ${expectedPath}`}`,
        },
      })
    })

    child.on("error", (err: Error) => {
      if (isSettled) return
      isSettled = true
      cleanup()
      resolve({ status: "failed", error: { code: "SPAWN_ERROR", message: err.message } })
    })
  })
}
