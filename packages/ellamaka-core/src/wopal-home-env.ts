import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, join } from "node:path"

const BLOCK_START = "# >>> wopal home >>>"
const BLOCK_END = "# <<< wopal home <<<"

export interface PersistWopalHomeEnvDeps {
  homeDir?: () => string
  platform?: NodeJS.Platform
}

export function isWopalHomeLockedAtStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WOPAL_DEV !== "1" && Boolean(env.WOPAL_HOME?.trim())
}

function getUserShell() {
  try {
    const login = userInfo().shell
    return process.env.SHELL || (login && login !== "unknown" ? login : undefined) || "/bin/sh"
  } catch {
    return process.env.SHELL || "/bin/sh"
  }
}

function wopalHomeForProfile(wopalHome: string): string {
  const defaultHome = join(homedir(), ".wopal")
  return wopalHome === defaultHome ? "${HOME}/.wopal" : wopalHome
}

function renderWopalBlock(shellName: string, wopalHome: string): string {
  const profileHome = wopalHomeForProfile(wopalHome)
  const varRef = "${WOPAL_HOME}"
  const lines = [BLOCK_START]
  if (shellName === "fish") {
    lines.push(`set -gx WOPAL_HOME "${profileHome}"`)
    lines.push(`fish_add_path "${varRef}/bin"`)
  } else {
    lines.push(`export WOPAL_HOME="${profileHome}"`)
    lines.push(`export PATH="${varRef}/bin:$PATH"`)
  }
  lines.push(BLOCK_END)
  return lines.join("\n")
}

function ensureShellBlock(profilePath: string, shellName: string, wopalHome: string): void {
  const block = renderWopalBlock(shellName, wopalHome)
  const escapedStart = BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const escapedEnd = BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const blockRegex = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`)
  let content = existsSync(profilePath) ? readFileSync(profilePath, "utf-8") : ""

  content = content.replace(/\n?# WopalSpace Environment\nexport WOPAL_HOME=.*\n?/g, "")
  content = content.replace(/\n?# WopalSpace Environment\nset -gx WOPAL_HOME .*\n?/g, "")
  content = blockRegex.test(content)
    ? content.replace(blockRegex, block)
    : content.replace(/\n+$/, "").length === 0
      ? block
      : `${content.replace(/\n+$/, "")}\n\n${block}`

  writeFileSync(profilePath, content.endsWith("\n") ? content : `${content}\n`, "utf-8")
}

/**
 * Persist the product-level WOPAL_HOME contract for the current user.
 * `WOPAL_DEV=1` is deliberately process-only and never edits user profiles.
 */
export function persistWopalHomeEnv(
  wopalHome: string,
  deps: PersistWopalHomeEnvDeps = {},
): { success: boolean; message?: string } {
  if (process.env.WOPAL_DEV === "1") {
    process.env.WOPAL_HOME = wopalHome
    return { success: true, message: "Skipped shell profile update (dev mode)." }
  }

  if ((deps.platform ?? process.platform) === "win32") {
    const psScript = `[Environment]::SetEnvironmentVariable('WOPAL_HOME', '${wopalHome.replace(/'/g, "''")}', 'User')`
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      windowsHide: true,
    })
    if (result.error || result.status !== 0) {
      const message =
        result.error?.message || result.stderr?.toString() || `PowerShell exited with code ${result.status}`
      return { success: false, message: `Failed to set Windows environment variable: ${message}` }
    }
    process.env.WOPAL_HOME = wopalHome
    return { success: true, message: "Windows WOPAL_HOME user environment variable set." }
  }

  const shellName = basename(getUserShell()).toLowerCase()
  const home = (deps.homeDir ?? homedir)()
  const profiles =
    shellName === "zsh"
      ? [join(home, ".zshrc")]
      : shellName === "bash"
        ? [join(home, ".bashrc"), ...(existsSync(join(home, ".bash_profile")) ? [join(home, ".bash_profile")] : [])]
        : shellName === "fish"
          ? [join(home, ".config", "fish", "config.fish")]
          : [join(home, ".profile")]

  try {
    for (const profilePath of profiles) {
      mkdirSync(join(profilePath, ".."), { recursive: true })
      ensureShellBlock(profilePath, shellName, wopalHome)
    }
    process.env.WOPAL_HOME = wopalHome
    return { success: true, message: `Updated shell profile(s) for ${shellName}.` }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) }
  }
}
