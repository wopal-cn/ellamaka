import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OnboardingStepResult } from "../preload/types"
import { getWopalHome } from "./onboarding-state"
import { terminateChildProcessTree } from "./child-process-lifecycle"

export function parseSemver(vStr: string): number[] {
  const match = vStr.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return [0, 0, 0]
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

export function isNewerVersion(localVer: string, latestVer: string): boolean {
  const [lMaj, lMin, lPat] = parseSemver(localVer)
  const [rMaj, rMin, rPat] = parseSemver(latestVer)

  if (rMaj > lMaj) return true
  if (rMaj === lMaj && rMin > lMin) return true
  if (rMaj === lMaj && rMin === lMin && rPat > lPat) return true
  return false
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
    // ignore
  }

  return null
}

export interface InstallWopalCliOptions {
  homePath?: string
  forceUpgrade?: boolean
  onProgress?: (progress: { phase: string; message?: string }) => void
  spawnFn?: (command: string, args: string[], options: any) => ChildProcess
  fetchInstallerScript?: (platform: string, signal?: AbortSignal) => Promise<string>
  fetchLatestVersion?: () => Promise<string | null>
  abortSignal?: AbortSignal
  timeoutMs?: number
  fetchTimeoutMs?: number
}

export async function installWopalCli(options: InstallWopalCliOptions = {}): Promise<OnboardingStepResult> {
  const homePath = getWopalHome(options.homePath)
  const isWin = process.platform === "win32"
  const binName = isWin ? "wopal.exe" : "wopal"
  const binPath = join(homePath, "bin", binName)

  if (options.abortSignal?.aborted) {
    return {
      status: "failed",
      error: { code: "INSTALLATION_ABORTED", message: "Wopal CLI 安装已取消。" },
    }
  }

  let localVersion: string | null = null

  // 1. Check if binary already exists and get its version
  if (existsSync(binPath)) {
    try {
      const check = spawnSync(binPath, ["--version"])
      if (check.status === 0) {
        localVersion = check.stdout.toString().trim()
      }
    } catch {
      // Reinstall if execution fails
    }
  }

  // 2. Check for latest version if local binary exists
  const fetcher = options.fetchLatestVersion ?? fetchDefaultLatestWopalVersion

  if (localVersion && !options.forceUpgrade) {
    try {
      const latestVer = await fetcher()
      if (latestVer && isNewerVersion(localVersion, latestVer)) {
        options.onProgress?.({
          phase: "upgrading",
          message: `Detected newer wopal CLI version ${latestVer} (current: ${localVersion}). Upgrading...`,
        })
        // Fallthrough to step 3 download & install upgrade!
      } else {
        return {
          status: "reused",
          result: { binaryPath: binPath, version: localVersion, latestVersion: latestVer ?? localVersion },
        }
      }
    } catch {
      return {
        status: "reused",
        result: { binaryPath: binPath, version: localVersion },
      }
    }
  }

  // 3. Fetch installer script
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
      return {
        status: "failed",
        error: { code: "INSTALLATION_ABORTED", message: "Wopal CLI 安装已取消。" },
      }
    }
    if (fetchController.signal.aborted) {
      return {
        status: "failed",
        error: {
          code: "INSTALLER_DOWNLOAD_TIMEOUT",
          message: "下载安装程序超时，请检查网络连接后重试。",
        },
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

  // Write script to system temp directory (not WOPAL_HOME/tmp).
  const tmpDir = mkdtempSync(join(tmpdir(), "wopal-install-"))
  const scriptPath = join(tmpDir, isWin ? "install.ps1" : "install.sh")

  // Remove the final exec command that would replace our process
  let modifiedScript = scriptContent
  if (!isWin) {
    // Remove the final "exec wopal setup" line to prevent process replacement
    modifiedScript = scriptContent.replace(
      /exec\s+"\$\{WOPAL_BIN\}\/wopal"\s+setup\s*<\s*\/dev\/tty/,
      'echo "Installation complete. Run wopal setup manually."',
    )
  }

  writeFileSync(scriptPath, modifiedScript, "utf-8")

  // 4. Spawn installer
  options.onProgress?.({ phase: "installing", message: "Executing wopal CLI installer..." })

  const spawnImpl = options.spawnFn ?? spawn
  const cmd = isWin ? "powershell" : "bash"
  // install.sh writes WOPAL_HOME + PATH to the user's shell rc (Step 9) so the
  // terminal `wopal` command works and WOPAL_HOME is available to shell-launched
  // processes. Dev mode must never pollute the real user shell env (dev.sh
  // injects a throwaway WOPAL_HOME), so Unix dev passes --no-modify-path. Prod
  // does not, matching the wopal-site install.sh contract exactly. Windows
  // currently always passes -NoModifyPath (install.ps1 PATH behavior TBD).
  const isDev = !!process.env.ELLAMAKA_DESKTOP_DEV
  const args = isWin
    ? ["-ExecutionPolicy", "Bypass", "-File", scriptPath, "-NoModifyPath", "-UpdateOnly"]
    : [scriptPath, ...(isDev ? ["--no-modify-path"] : [])]
  if (options.forceUpgrade) {
    args.push(isWin ? "-Force" : "--force")
  }

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
        /* best-effort */
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
      void stop({
        status: "failed",
        error: {
          code: "INSTALLATION_ABORTED",
          message: "Wopal CLI 安装已取消。",
        },
      })
    }

    try {
      child = spawnImpl(cmd, args, {
        env,
        stdio: "pipe",
        detached: process.platform !== "win32",
      })
    } catch (err) {
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

    child.stdout?.on("data", (chunk: any) => {
      if (isSettled) return
      const str = chunk.toString()
      const clean = str.replace(/\x1b\[[0-9;]*m/g, "")
      stdoutLog += clean
      if (clean.trim()) {
        options.onProgress?.({ phase: "installing", message: clean.trim() })
      }
    })

    child.stderr?.on("data", (chunk: any) => {
      if (isSettled) return
      const str = chunk.toString()
      const clean = str.replace(/\x1b\[[0-9;]*m/g, "")
      stderrLog += clean
      if (clean.trim()) {
        options.onProgress?.({ phase: "installing", message: clean.trim() })
      }
    })

    child.on("exit", (code: number | null) => {
      if (isSettled) return
      isSettled = true
      cleanup()

      const fullLog = (stdoutLog + stderrLog).trim()
      const expectedPath = join(homePath, "bin", binName)
      const binDirExists = existsSync(join(homePath, "bin"))
      const binExists = existsSync(expectedPath)

      options.onProgress?.({
        phase: "verifying",
        message: `检查安装路径: ${expectedPath}, 目录存在: ${binDirExists}, 二进制存在: ${binExists}, exit code: ${code}`,
      })

      let foundPath: string | null = null
      if (binExists) {
        try {
          const check = spawnSync(expectedPath, ["--version"])
          if (check.status === 0) {
            foundPath = expectedPath
          } else {
            options.onProgress?.({
              phase: "verifying",
              message: `wopal --version 执行失败 (exit ${check.status}): ${check.stderr?.toString().trim()}`,
            })
          }
        } catch (err) {
          options.onProgress?.({
            phase: "verifying",
            message: `执行 wopal --version 异常: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }

      if (foundPath) {
        let installedVersion = localVersion
        try {
          const verCheck = spawnSync(foundPath, ["--version"])
          if (verCheck.status === 0) {
            installedVersion = verCheck.stdout.toString().trim()
          }
        } catch {
          // keep previous version
        }
        resolve({
          status: "completed",
          result: { binaryPath: foundPath, version: installedVersion },
        })
      } else {
        const errorDetail = fullLog || `exit code ${code}, binary not found at ${expectedPath}`
        resolve({
          status: "failed",
          error: {
            code: "INSTALLATION_FAILED",
            message: `安装程序执行失败 (exit ${code}): ${errorDetail}`,
          },
        })
      }
    })

    child.on("error", (err: Error) => {
      if (isSettled) return
      isSettled = true
      cleanup()
      resolve({
        status: "failed",
        error: { code: "SPAWN_ERROR", message: err.message },
      })
    })
  })
}
