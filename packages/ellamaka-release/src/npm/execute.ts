// packages/ellamaka-release/src/npm/execute.ts
//
// Side-effectful primitives for the npm publish flow: the package build +
// pack step, the publish step, the registry probe that drives idempotency, the
// registry tarball reader that drives skip verification, and the credential
// check.
//
// The source `package.json` is rewritten (dev `exports` -> dist `exports`) for
// the duration of the pack only, and is always restored — a failed publish
// must never leave the workspace with a package.json whose exports no longer
// resolve for `typecheck`/`test`.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { errorMessage } from "./error"
import { rewriteExports } from "./exports"
import { readJsonObject } from "./json"
import { tarballFileName, type PublishPlanEntry } from "./plan"

export { errorMessage }

export interface PublishRuntime {
  /** Run a command in `cwd`. Must throw when the command exits non-zero. */
  run(command: string[], options: { cwd: string }): void
}

export interface PublishPackageOptions {
  repoRoot: string
  /** Directory the packed tarball is written to (kept out of the package dir). */
  stagingDir: string
  registry: string
  runtime: PublishRuntime
  log: (line: string) => void
  /**
   * Manifest write seam (defaults to `writeFileSync`). Injected by tests to
   * fail the publish-time write; production always uses the real writer.
   */
  writeManifest?: (path: string, text: string) => void
}

/** Options shared by the local build + pack step and the full publish. */
export interface PackLocalOptions {
  repoRoot: string
  stagingDir: string
  runtime: PublishRuntime
  log: (line: string) => void
  /** Manifest write seam, as in `PublishPackageOptions`. */
  writeManifest?: (path: string, text: string) => void
}

/**
 * Run `action` against the package's publish-time manifest.
 *
 * The dev `exports` map (`./src/*.ts`) is rewritten to the shipped dist form
 * for the duration of `action`, then restored byte-for-byte. The rewrite runs
 * *inside* the restore guard: a failure while writing it (partial write,
 * ENOSPC) must not leave the workspace with a package.json whose subpaths no
 * longer resolve for `typecheck`/`test`.
 */
function withRewrittenExports<T>(
  entry: PublishPlanEntry,
  options: PackLocalOptions,
  /** Names the operation in failure messages: "pack" or "publish". */
  operation: string,
  action: () => T,
): T {
  const manifestPath = join(options.repoRoot, entry.dir, "package.json")
  const writeManifest: (path: string, text: string) => void = options.writeManifest ?? writeFileSync
  const source = readFileSync(manifestPath, "utf8")

  // A sentinel rather than a boolean flag: it narrows `result` for TypeScript
  // without asserting the action's return type, and an action that returns
  // `undefined` (the publish step) still counts as having run.
  const NOT_RUN = Symbol("not-run")
  let result: T | typeof NOT_RUN = NOT_RUN
  let failure: unknown
  try {
    const manifest = readJsonObject(manifestPath)
    manifest.exports = rewriteExports(manifest.exports)
    writeManifest(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    result = action()
  } catch (err) {
    failure = err
  }

  // Always restore, whether the action succeeded, failed, or never ran.
  let restoreFailure: unknown
  try {
    writeManifest(manifestPath, source)
  } catch (err) {
    restoreFailure = err
  }

  if (restoreFailure) {
    // Never mask this: the workspace is left with the publish-time `exports`
    // and must be repaired by hand.
    throw new Error(
      `could not restore ${manifestPath} after the ${operation} attempt (${errorMessage(restoreFailure)})` +
        (failure ? `; the ${operation} failure was: ${errorMessage(failure)}` : "") +
        ` — restore the file from git before continuing`,
      { cause: failure ?? restoreFailure },
    )
  }
  if (result !== NOT_RUN) return result
  if (failure !== undefined) throw failure
  throw new Error(`internal: the guarded ${operation} action never ran`)
}

/** `bun run build` in the package dir — must see the development `exports`. */
function buildPackage(entry: PublishPlanEntry, options: PackLocalOptions): void {
  options.log(`building ${entry.name}@${entry.version} (${entry.dir})`)
  options.runtime.run(["bun", "run", "build"], { cwd: join(options.repoRoot, entry.dir) })
}

/** `bun pm pack` into staging — must see the publish-time `exports`. */
function packTarball(entry: PublishPlanEntry, options: PackLocalOptions, dir: string): string {
  mkdirSync(options.stagingDir, { recursive: true })
  const tarballPath = join(options.stagingDir, entry.tarball)
  options.runtime.run(["bun", "pm", "pack", "--destination", options.stagingDir], { cwd: dir })
  return tarballPath
}

/**
 * Build and pack the local checkout, returning the tarball bytes.
 *
 * This is the local half of the skip comparison (`verify.ts`) and the first
 * half of `publishPackage`; both share it rather than reimplementing the
 * rewrite/restore protocol.
 */
export function packLocalTarball(entry: PublishPlanEntry, options: PackLocalOptions): Uint8Array {
  buildPackage(entry, options)
  return withRewrittenExports(entry, options, "pack", () =>
    readFileSync(packTarball(entry, options, join(options.repoRoot, entry.dir))),
  )
}

/**
 * Build, pack and publish one package. The tarball is staged outside the
 * package directory so a failure never leaves a `.tgz` in the workspace.
 *
 * The publish-time `exports` stay in place through `npm publish` as well: the
 * publish reads the staged tarball, but keeping one guard around the whole
 * sequence means a single restore path covers every failure.
 */
export function publishPackage(entry: PublishPlanEntry, options: PublishPackageOptions): void {
  buildPackage(entry, options)
  withRewrittenExports(entry, options, "publish", () => {
    const tarballPath = packTarball(entry, options, join(options.repoRoot, entry.dir))
    options.runtime.run(["npm", "publish", tarballPath, "--access", "public", "--registry", options.registry], {
      cwd: join(options.repoRoot, entry.dir),
    })
  })
}

export function createBunRuntime(): PublishRuntime {
  return {
    run(command, options) {
      // stdin must be inherited: `npm publish` on a 2FA-protected account
      // hands the 2FA ceremony to the browser and refuses to even try when the
      // child has no TTY on stdin (`npm/lib/utils/auth.js` bails on
      // `!process.stdin.isTTY`), falling back to a bare "provide --otp" error.
      // Bun.spawnSync defaults stdin to /dev/null, which silently breaks
      // interactive publishes; inheriting keeps the terminal attached.
      const proc = Bun.spawnSync(command, {
        cwd: options.cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      if (proc.exitCode !== 0) {
        throw new Error(`${command.join(" ")} failed with exit code ${proc.exitCode}`)
      }
    },
  }
}

/** Read-only registry probe: exit code 0 means `<name>@<version>` exists. */
export function createRegistryProbe(registry: string): (name: string, version: string) => boolean {
  return (name, version) => {
    const proc = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version", "--registry", registry], {
      stdout: "pipe",
      stderr: "pipe",
    })
    return proc.exitCode === 0
  }
}

/**
 * Read a published tarball back off a registry.
 *
 * `npm pack <name>@<version>` downloads the published tarball and writes it to
 * the staging dir byte-for-byte (verified against the registry's `dist.tarball`
 * for an unrelated package), which is what makes it a faithful input to the
 * content digest. The file is removed afterwards: staging is scratch space for
 * the digest, not a cache.
 */
export function createRegistryTarballFetcher(options: {
  stagingDir: string
  runtime: PublishRuntime
}): (name: string, version: string, registry: string) => Uint8Array {
  return (name, version, registry) => {
    mkdirSync(options.stagingDir, { recursive: true })
    const tarballPath = join(options.stagingDir, tarballFileName(name, version))
    options.runtime.run(
      ["npm", "pack", `${name}@${version}`, "--registry", registry, "--pack-destination", options.stagingDir],
      { cwd: options.stagingDir },
    )
    try {
      return readFileSync(tarballPath)
    } catch (err) {
      throw new Error(`npm pack did not write ${tarballPath} (${errorMessage(err)})`, { cause: err })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  }
}

/**
 * Fail-closed credential check. OIDC trusted publishing has no token to
 * introspect with `npm whoami`, so the check is skipped when GitHub Actions
 * exposes an OIDC request URL — the publish itself performs the exchange.
 */
export function createAuthCheck(
  options: {
    env?: Record<string, string | undefined>
    whoami?: (registry: string) => boolean
  } = {},
): (registry: string) => void {
  const env = options.env ?? process.env
  const whoami =
    options.whoami ??
    ((registry: string) => {
      const proc = Bun.spawnSync(["npm", "whoami", "--registry", registry], { stdout: "pipe", stderr: "pipe" })
      return proc.exitCode === 0
    })

  return (registry) => {
    if (whoami(registry)) return
    if (env.ACTIONS_ID_TOKEN_REQUEST_URL) return
    throw new Error(
      `not authenticated against ${registry} (npm whoami failed): run \`npm login\` locally, ` +
        `or give the release job npm publish rights (NPM_TOKEN, or OIDC trusted publishing)`,
    )
  }
}
