import { existsSync, statSync } from "fs"
import path from "path"
import os from "os"

export function detectWopalSpace(cwd: string): { root: string; wopalDir: string } | undefined {
  const home = os.homedir()
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const wopalDir = path.join(dir, ".wopal")
    const gitMarker = path.join(wopalDir, ".git")

    if (existsSync(gitMarker)) {
      try {
        if (statSync(gitMarker).isFile()) {
          return { root: dir, wopalDir }
        }
      } catch (_) {
        // stat failed — skip this directory
      }
    }

    // Stop at home directory (don't go past)
    if (dir === home) return undefined

    // Stop at filesystem root (fallback, should not reach here normally)
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
  }
}
