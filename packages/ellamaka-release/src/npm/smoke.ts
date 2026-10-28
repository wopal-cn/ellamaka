import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { createBunRuntime, packLocalTarball, type PublishRuntime } from "./execute"
import { buildPublishPlan, loadPublishTargets } from "./plan"

export interface NpmCleanInstallOptions {
  repoRoot: string
  version: string
  runtime?: PublishRuntime
  log?: (line: string) => void
}

/**
 * Build the publish tarballs and install them together outside the source tree.
 * This proves the packed manifests, dependency versions and top-level exports
 * are consumable without workspace resolution before anything reaches npm.
 */
export function verifyNpmCleanInstall(options: NpmCleanInstallOptions): void {
  const runtime = options.runtime ?? createBunRuntime()
  const log = options.log ?? console.log
  const plan = buildPublishPlan({
    targets: loadPublishTargets(options.repoRoot),
    releaseVersion: options.version,
    isPublished: () => false,
  })
  const tempRoot = mkdtempSync(join(tmpdir(), "ellamaka-npm-smoke-"))
  const stagingDir = join(tempRoot, "tarballs")
  const installDir = join(tempRoot, "consumer")

  try {
    mkdirSync(installDir, { recursive: true })
    writeFileSync(
      join(installDir, "package.json"),
      JSON.stringify({ name: "ellamaka-npm-smoke", private: true, type: "module" }, null, 2) + "\n",
    )

    const tarballs: string[] = []
    for (const entry of plan.entries) {
      packLocalTarball(entry, { repoRoot: options.repoRoot, stagingDir, runtime, log })
      tarballs.push(join(stagingDir, entry.tarball))
    }

    runtime.run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: installDir })
    runtime.run(
      [
        "node",
        "--input-type=module",
        "-e",
        [
          'await import("@wopal/ellamaka-sdk")',
          'await import("@wopal/ellamaka-plugin")',
          'import.meta.resolve("@wopal/ellamaka-sdk/client")',
          'import.meta.resolve("@wopal/ellamaka-sdk/v2")',
          'import.meta.resolve("@wopal/ellamaka-plugin/tool")',
          'import.meta.resolve("@wopal/ellamaka-plugin/tui")',
        ].join(";"),
      ],
      { cwd: installDir },
    )
    log(`npm clean-install smoke passed for ${options.version}`)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}
