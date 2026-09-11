import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function getOnboardingLogger(homePath?: string) {
  const actualHome = homePath ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
  const logDir = join(actualHome, "logs")
  const logFile = join(logDir, "onboarding.log")
  let logAvailable = true

  try {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }
  } catch {
    logAvailable = false
  }

  return {
    log: (message: string) => {
      if (!logAvailable) return
      try {
        if (existsSync(logFile)) {
          const stats = statSync(logFile)
          if (stats.size > 1024 * 1024) {
            renameSync(logFile, `${logFile}.1`)
          }
        }

        // Desensitize token/keys
        const safeMessage = message.replace(/(?:gh[pousr]_[a-zA-Z0-9]{36,}|sk-[a-zA-Z0-9]{32,})/g, "***")
        const timestamp = new Date().toISOString()
        appendFileSync(logFile, `[${timestamp}] ${safeMessage}\n`)
      } catch {}
    },
    clear: () => {
      // Remove the onboarding log (and any rotated backup) once onboarding
      // completes, so a finished wizard leaves no debug trail behind.
      if (!logAvailable) return
      try {
        if (existsSync(logFile)) unlinkSync(logFile)
        if (existsSync(`${logFile}.1`)) unlinkSync(`${logFile}.1`)
      } catch {}
    },
  }
}
