import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, join } from "node:path"
import { getLogger } from "./logging"

const TIMEOUT = 5_000

type Probe = { type: "Loaded"; value: Record<string, string> } | { type: "Timeout" } | { type: "Unavailable" }

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

function probe(shell: string, mode: "-il" | "-l"): Probe {
  const out = spawnSync(shell, [mode, "-c", "env -0"], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: TIMEOUT,
    windowsHide: true,
  })

  const err = out.error as NodeJS.ErrnoException | undefined
  if (err) {
    if (err.code === "ETIMEDOUT") return { type: "Timeout" }
    console.log(`[server] Shell env probe failed for ${shell} ${mode}: ${err.message}`)
    return { type: "Unavailable" }
  }

  if (out.status !== 0) {
    console.log(`[server] Shell env probe exited with non-zero status for ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  const env = parseShellEnv(out.stdout)
  if (Object.keys(env).length === 0) {
    console.log(`[server] Shell env probe returned empty env for ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  return { type: "Loaded", value: env }
}

export function isNushell(shell: string) {
  const name = basename(shell).toLowerCase()
  const raw = shell.toLowerCase()
  return name === "nu" || name === "nu.exe" || raw.endsWith("\\nu.exe")
}

export function loadShellEnv(shell: string) {
  const logger = getLogger()
  if (isNushell(shell)) {
    logger.log(`[server] Skipping shell env probe for nushell: ${shell}`)
    return null
  }

  const interactive = probe(shell, "-il")
  if (interactive.type === "Loaded") {
    logger.log(`[server] Loaded shell environment with -il (${Object.keys(interactive.value).length} vars)`)
    return interactive.value
  }
  if (interactive.type === "Timeout") {
    logger.log(`[server] Interactive shell env probe timed out: ${shell}`)
    return null
  }

  const login = probe(shell, "-l")
  if (login.type === "Loaded") {
    logger.log(`[server] Loaded shell environment with -l (${Object.keys(login.value).length} vars)`)
    return login.value
  }

  logger.log(`[server] Falling back to app environment: ${shell}`)
  return null
}

export function mergeShellEnv(shell: Record<string, string> | null, env: Record<string, string>) {
  return {
    ...shell,
    ...env,
  }
}

// GUI processes launched from Finder/Dock inherit a minimal system PATH that
// omits user-level directories (e.g. /opt/homebrew/bin). The user's login shell
// PATH is the authoritative source for tool discovery (gh, go, bun, ...), so
// it must win over the GUI default PATH rather than be silently overridden.
export function resolveShellPath(
  shellEnv: Record<string, string> | null,
  appPath: string | undefined,
): string | undefined {
  if (shellEnv?.PATH) return shellEnv.PATH
  return appPath
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
