import path from "node:path"
import { writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { InstallationLocal, InstallationVersionBase } from "@wopal/ellamaka-core/installation/version"
import { Npm } from "@wopal/ellamaka-core/npm"
import { prepareInstancePluginDependencies } from "./instance-preparation"

const compatibilityPreparation = new Map<string, Promise<void>>()

function prepareCompatibilityDirectory(dir: string): Promise<void> {
  const key = path.resolve(dir)
  const active = compatibilityPreparation.get(key)
  if (active) return active
  const run = (async () => {
    await ensureInstallGitignore(dir)
    await Npm.install(dir, {
      add: [
        {
          name: "@wopal/ellamaka-plugin",
          version: InstallationLocal ? undefined : InstallationVersionBase,
        },
      ],
    })
  })().finally(() => compatibilityPreparation.delete(key))
  compatibilityPreparation.set(key, run)
  return run
}

async function ensureInstallGitignore(dir: string) {
  const file = path.join(dir, ".gitignore")
  if (existsSync(file)) return
  await writeFile(
    file,
    ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") return
    throw error
  })
}

export async function preparePluginDependencies(options: {
  wopalHome: string
  directories: string[]
  spaceRoot?: string
  reason: string
}) {
  if (options.spaceRoot) {
    return prepareInstancePluginDependencies({
      wopalHome: options.wopalHome,
      directory: options.spaceRoot,
      reason: options.reason,
    })
  }

  await Promise.all(options.directories.map(prepareCompatibilityDirectory))
  return { state: "READY" as const }
}
