import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, isAbsolute, join, normalize } from "node:path"
import type { Readable } from "node:stream"
import { parse } from "jsonc-parser"
import { getLogger } from "./logging"

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024
const FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"] as const
const MARKER_START = "__WOPAL_ENV_START__"
const MARKER_END = "__WOPAL_ENV_END__"
const DUMP = `printf '\\0%s\\0' '${MARKER_START}'; command env -0 || exit; printf '\\0%s\\0' '${MARKER_END}'; exit`
const PROBE_ENVIRONMENT = {
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTARTED: "true",
  ZSH_TMUX_AUTOSTART: "false",
} as const
const PROBE_ONLY_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_", ...Object.keys(PROBE_ENVIRONMENT)])

type ProbeFailureReason = "timeout" | "aborted" | "spawn-error" | "exit" | "unparsed"
type Probe =
  | { type: "Loaded"; value: Record<string, string> }
  | { type: "Failed"; reason: ProbeFailureReason; status?: number }

export interface ShellEnvironmentLog {
  warn(message: string, fields?: Record<string, unknown>): void
  info?(message: string, fields?: Record<string, unknown>): void
}

export interface LoadShellEnvOptions {
  platform?: NodeJS.Platform
  candidates?: readonly string[]
  timeoutMs?: number
  signal?: AbortSignal
  inherited?: Record<string, string>
  homeDir?: string
  log?: ShellEnvironmentLog
  onSpawn?: () => void
}

export function resolveUserShell(envShell: string | undefined, loginShell: string | null | undefined) {
  const resolvedLoginShell = loginShell && loginShell !== "unknown" ? loginShell : undefined
  return envShell || resolvedLoginShell || "/bin/sh"
}

export function getUserShell() {
  try {
    return resolveUserShell(process.env.SHELL, userInfo().shell)
  } catch {
    return resolveUserShell(process.env.SHELL, undefined)
  }
}

export function parseShellEnv(out: Buffer) {
  const env: Record<string, string> = {}
  for (const line of out.toString("utf8").split("\0")) {
    if (!line) continue
    const ix = line.indexOf("=")
    if (ix <= 0) continue
    env[line.slice(0, ix)] = line.slice(ix + 1)
  }
  return env
}

export function parseFramedShellEnv(out: string): Record<string, string> | undefined {
  const open = `\0${MARKER_START}\0`
  const close = `\0${MARKER_END}\0`
  const start = out.indexOf(open)
  const end = out.lastIndexOf(close)
  if (start === -1 || end === -1 || end <= start) return undefined
  const body = out.slice(start + open.length, end)
  const env = parseShellEnv(Buffer.from(body))
  return Object.keys(env).length > 0 ? env : undefined
}

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

export async function loadShellEnv(_shell: string, options: LoadShellEnvOptions = {}) {
  const platform = options.platform ?? process.platform
  if (platform === "win32") return options.inherited ?? null

  const configured = options.candidates
  const candidates =
    configured ??
    (() => {
      let account: string | null = null
      try {
        account = userInfo().shell
      } catch {}
      return [...new Set([...(account && account !== "unknown" ? [account] : []), ...FALLBACK_SHELLS])]
    })()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const homeDir = options.homeDir ?? homedir()
  const log = options.log ?? defaultShellLog()
  const inherited = options.inherited ?? inheritedEnv()

  for (const [index, shell] of candidates.entries()) {
    if (options.signal?.aborted) {
      logFailure(log, { candidate: candidateName(shell), attempt: index + 1, reason: "aborted" })
      throw abortError()
    }
    const started = Date.now()
    const result = await probe(shell, inherited, homeDir, timeoutMs, options.signal, options.onSpawn)
    if (result.type === "Loaded") {
      for (const key of PROBE_ONLY_KEYS) delete result.value[key]
      return result.value
    }
    logFailure(log, {
      candidate: candidateName(shell),
      attempt: index + 1,
      reason: result.reason,
      ...(result.reason === "timeout" || result.reason === "aborted" ? { durationMs: Date.now() - started } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
    })
    if (result.reason === "aborted") throw abortError()
  }

  log.warn("desktop.shell_env.degraded", {
    platform: "posix",
    candidates: candidates.length,
    source: "inherited",
    degraded: true,
  })
  return null
}

export async function resolveDesktopHostEnvironment(
  options: LoadShellEnvOptions & { shell?: Record<string, string> | null } = {},
): Promise<{ home: string; env: Record<string, string> }> {
  const inherited = { ...(options.inherited ?? inheritedEnv()) }
  const homeDir = options.homeDir ?? homedir()
  const shell =
    "shell" in options
      ? (options.shell ?? null)
      : (options.platform ?? process.platform) === "win32"
        ? null
        : await loadShellEnv("", { ...options, inherited })
  const root = (value?: string) => {
    if (!value?.trim()) return undefined
    const expanded = value.startsWith("~/") ? join(homeDir, value.slice(2)) : value
    return isAbsolute(expanded) ? normalize(expanded) : undefined
  }
  const home = root(inherited.WOPAL_HOME) ?? root(shell?.WOPAL_HOME) ?? join(homeDir, ".wopal")
  const file = join(home, "config", "settings.jsonc")
  let text: string | undefined
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error
  }
  let mode = "inherit"
  let list: string[] = []
  if (text !== undefined) {
    const errors: { error: number; offset: number; length: number }[] = []
    const settings: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length) throw new Error("Invalid global settings JSONC")
    const object = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {}
    const policy = object(object(object(object(settings).wopal).execution).shellEnv)
    if (policy.mode === "allowlist" || policy.mode === "denylist") mode = policy.mode
    if (Array.isArray(policy.list)) list = policy.list.filter((value): value is string => typeof value === "string")
  }
  const env = { ...inherited }
  for (const [key, value] of Object.entries(shell ?? {})) {
    if (key === "WOPAL_HOME" || PROBE_ONLY_KEYS.has(key)) continue
    const matches = list.some((pattern) =>
      pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern,
    )
    if (mode === "allowlist" && !matches) continue
    if (mode === "denylist" && matches) continue
    env[key] = value
  }
  env.WOPAL_HOME = home
  return { home, env }
}

function probe(
  shell: string,
  inherited: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onSpawn?: () => void,
): Promise<Probe> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ type: "Failed", reason: "aborted" })
      return
    }
    let child: ChildProcessByStdio<null, Readable, null>
    try {
      child = spawn(shell, ["-ilc", DUMP], {
        cwd,
        env: { ...inherited, ...PROBE_ENVIRONMENT },
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
      })
    } catch {
      resolve({ type: "Failed", reason: "spawn-error" })
      return
    }

    const chunks: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let exitStatus: number | null | undefined

    const killGroup = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {}
      }
    }
    const finish = (result: Probe) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      child.stdout.off("data", onData)
      child.stdout.destroy()
      // An early marker can complete the read while rc-started descendants keep
      // this process group alive. The probe owns that group, so its completion
      // always terminates the group before another candidate starts.
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
        killGroup()
        resolve(result)
        return
      }
      child.once("exit", () => resolve(result))
      killGroup()
    }
    const stop = (reason: "timeout" | "aborted") => {
      finish({ type: "Failed", reason })
    }
    const onAbort = () => stop("aborted")
    const onData = (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        finish({ type: "Failed", reason: "unparsed" })
        return
      }
      chunks.push(chunk)
      const parsed = parseFramedShellEnv(Buffer.concat(chunks).toString("utf8"))
      if (parsed) {
        finish({ type: "Loaded", value: parsed })
      }
    }
    timer = setTimeout(() => stop("timeout"), timeoutMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", onData)
    child.on("spawn", () => onSpawn?.())
    child.on("error", () => finish({ type: "Failed", reason: "spawn-error" }))
    child.on("close", (code, closeSignal) => {
      exitStatus = closeSignal ? 1 : code
      if (exitStatus !== 0) finish({ type: "Failed", reason: "exit", status: exitStatus ?? undefined })
      else finish({ type: "Failed", reason: "unparsed" })
    })
  })
}

function candidateName(shell: string): string {
  const name = basename(shell).replace(/\.exe$/i, "")
  const fallback = new Set(["zsh", "bash", "sh"])
  if (fallback.has(name)) return name
  try {
    if (shell === userInfo().shell) return "account-shell"
  } catch {}
  return "custom"
}

function logFailure(
  log: ShellEnvironmentLog,
  failure: { candidate: string; attempt: number; reason: ProbeFailureReason; status?: number; durationMs?: number },
) {
  log.warn("desktop.shell_env.probe_failed", {
    platform: "posix",
    candidate: failure.candidate,
    attempt: failure.attempt,
    reason: failure.reason,
    ...(failure.durationMs !== undefined ? { durationMs: failure.durationMs } : {}),
    ...(failure.status !== undefined ? { status: failure.status } : {}),
  })
}

function defaultShellLog(): ShellEnvironmentLog {
  return {
    warn(message, fields) {
      getLogger()?.warn(message, fields)
    },
  }
}

function abortError() {
  return new DOMException("Host Environment resolution aborted", "AbortError")
}

const BLOCK_START = "# >>> wopal home >>>"
const BLOCK_END = "# <<< wopal home <<<"

/**
 * Value to write into the shell profile. Uses $HOME-relative form for the
 * default path so dotfiles stay portable across machines/user accounts;
 * keeps the original value for user-overridden paths.
 */
function wopalHomeForProfile(wopalHome: string): string {
  const defaultHome = join(homedir(), ".wopal")
  return wopalHome === defaultHome ? "${HOME}/.wopal" : wopalHome
}

/** Build the managed block content for the current shell. */
function renderWopalBlock(shellName: string, wopalHome: string): string {
  const profileHome = wopalHomeForProfile(wopalHome)
  const isFish = shellName === "fish"
  const varRef = "${WOPAL_HOME}"
  const lines = [BLOCK_START]
  if (isFish) {
    lines.push(`set -gx WOPAL_HOME "${profileHome}"`)
    lines.push(`fish_add_path "${varRef}/bin"`)
  } else {
    lines.push(`export WOPAL_HOME="${profileHome}"`)
    lines.push(`export PATH="${varRef}/bin:$PATH"`)
  }
  lines.push(BLOCK_END)
  return lines.join("\n")
}

/**
 * Idempotently write or replace the managed block in a shell profile.
 * Strips trailing blank lines before appending to avoid accumulating
 * empty lines on repeated runs.
 */
function ensureShellBlock(profilePath: string, shellName: string, wopalHome: string): void {
  const block = renderWopalBlock(shellName, wopalHome)
  const escapedStart = BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedEnd = BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const blockRegex = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`)

  let content = existsSync(profilePath) ? readFileSync(profilePath, "utf-8") : ""

  // Migrate: remove legacy "# WopalSpace Environment" block (single export line).
  content = content.replace(/\n?# WopalSpace Environment\nexport WOPAL_HOME=.*\n?/g, "")
  content = content.replace(/\n?# WopalSpace Environment\nset -gx WOPAL_HOME .*\n?/g, "")

  if (blockRegex.test(content)) {
    // Replace existing block.
    content = content.replace(blockRegex, block)
  } else {
    // Strip trailing blank lines, then ensure exactly one blank line separator.
    content = content.replace(/\n+$/, "")
    content = content.length === 0 ? block : `${content}\n\n${block}`
  }

  writeFileSync(profilePath, content.endsWith("\n") ? content : `${content}\n`, "utf-8")
}

export interface PersistWopalHomeEnvDeps {
  homeDir?: () => string
  platform?: NodeJS.Platform
}

export function persistWopalHomeEnv(
  wopalHome: string,
  deps: PersistWopalHomeEnvDeps = {},
): { success: boolean; message?: string } {
  try {
    process.env.WOPAL_HOME = wopalHome
    const log = getLogger()

    // Dev mode (dev.sh desktop) must never mutate the user's real shell
    // profile. We still set WOPAL_HOME for the current process above.
    if (process.env.WOPAL_DEV === "1") {
      log?.info("[shell-env] Dev mode: skipping shell profile update")
      return { success: true, message: "Skipped shell profile update (dev mode)." }
    }

    const isWin = (deps.platform ?? process.platform) === "win32"

    if (isWin) {
      // Windows: use .NET API via PowerShell to avoid setx's 1024-char PATH truncation.
      const psScript = `[Environment]::SetEnvironmentVariable('WOPAL_HOME', '${wopalHome.replace(/'/g, "''")}', 'User')`
      const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        windowsHide: true,
      })
      if (res.error || res.status !== 0) {
        const errMsg = res.error?.message || res.stderr?.toString() || `PowerShell exited with code ${res.status}`
        log?.error("[shell-env] Failed to set WOPAL_HOME via PowerShell:", errMsg)
        return { success: false, message: `Failed to set Windows environment variable: ${errMsg}` }
      }
      return { success: true, message: "Windows WOPAL_HOME user environment variable set." }
    } else {
      // POSIX (macOS & Linux): idempotent managed block in shell profile(s).
      const userShell = getUserShell()
      const shellName = basename(userShell).toLowerCase()
      const home = (deps.homeDir ?? homedir)()

      const targetProfiles: string[] = []
      if (shellName === "zsh") {
        targetProfiles.push(join(home, ".zshrc"))
      } else if (shellName === "bash") {
        targetProfiles.push(join(home, ".bashrc"))
        if (existsSync(join(home, ".bash_profile"))) {
          targetProfiles.push(join(home, ".bash_profile"))
        }
      } else if (shellName === "fish") {
        targetProfiles.push(join(home, ".config", "fish", "config.fish"))
      } else {
        targetProfiles.push(join(home, ".profile"))
      }

      for (const profilePath of targetProfiles) {
        try {
          const dir = join(profilePath, "..")
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          ensureShellBlock(profilePath, shellName, wopalHome)
        } catch (err) {
          log?.error(`[shell-env] Error updating profile ${profilePath}:`, err)
        }
      }

      return { success: true, message: `Updated shell profile(s) for ${shellName}.` }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, message }
  }
}
