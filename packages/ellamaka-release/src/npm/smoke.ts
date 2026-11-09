import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { verifyPackedContract, verifyPackedManifest } from "./contract"
import { createBunRuntime, packLocalTarball, type PublishRuntime } from "./execute"
import { buildPublishPlan, loadPublishTargets, selectPublishTargets, type PublishPlanEntry } from "./plan"

export interface NpmCleanInstallOptions {
  repoRoot: string
  packages: string[]
  version?: string
  runtime?: PublishRuntime
  log?: (line: string) => void
}

const SDK = "@wopal/ellamaka-sdk"
const PLUGIN = "@wopal/ellamaka-plugin"

/** Published SDK entrypoints a consumer resolves before anything else runs. */
const SDK_PROBE = [
  'await import("@wopal/ellamaka-sdk")',
  'import.meta.resolve("@wopal/ellamaka-sdk/client")',
  'import.meta.resolve("@wopal/ellamaka-sdk/v2")',
  'import.meta.resolve("@wopal/ellamaka-sdk/local")',
  'import.meta.resolve("@wopal/ellamaka-sdk/openapi.json")',
]

/** Published Plugin entrypoints; importing the adapter also loads its SDK dependency. */
const PLUGIN_PROBE = [
  'await import("@wopal/ellamaka-plugin")',
  'await import("@wopal/ellamaka-plugin/client-compat")',
  'import.meta.resolve("@wopal/ellamaka-plugin/tool")',
  'import.meta.resolve("@wopal/ellamaka-plugin/tui")',
]

/**
 * The Server complete mounted API document, exactly what GET /doc serves.
 *
 * Read by running the owning generator instead of importing Server modules
 * here: the release package must not depend on the Runtime, and the generator
 * also proves the document can be produced without a running instance.
 */
function readServerDocument(repoRoot: string): unknown {
  const generator = join(repoRoot, "packages/opencode/script/generate-server-openapi.ts")
  const proc = Bun.spawnSync([process.execPath, generator], {
    cwd: join(repoRoot, "packages/opencode"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  })
  if (proc.exitCode !== 0) throw new Error("cannot generate the Server API document (exit " + proc.exitCode + ")")
  return JSON.parse(new TextDecoder().decode(proc.stdout)) as unknown
}

/** The install-time dependency edge the packed Plugin publishes for the SDK. */
function publishedSdkDependency(manifest: Record<string, unknown>): string {
  const dependencies = manifest.dependencies
  if (typeof dependencies !== "object" || dependencies === null)
    throw new Error("packed " + PLUGIN + " publishes no dependencies")
  const specifier = Reflect.get(dependencies, SDK)
  if (typeof specifier !== "string") throw new Error("packed " + PLUGIN + " does not depend on " + SDK)
  return specifier
}

/**
 * The Plugin resolves the SDK at install time, so its published dependency must
 * name a concrete version rather than an unpublished workspace path. When the
 * SDK ships in the same release the two versions must agree; a Plugin-only
 * release keeps whichever published SDK version it was packed against.
 */
function assertPluginPinsReleasedSdk(
  plugin: PublishPlanEntry,
  manifest: Record<string, unknown>,
  sdk: PublishPlanEntry | undefined,
): void {
  const specifier = publishedSdkDependency(manifest)
  if (sdk && specifier !== sdk.version)
    throw new Error(
      "packed " +
        plugin.name +
        "@" +
        plugin.version +
        " depends on " +
        SDK +
        "@" +
        specifier +
        ", but this release ships " +
        SDK +
        "@" +
        sdk.version +
        ": publish the owning SDK first",
    )
}

/** The published SDK must carry the self-contained Worker asset it launches. */
function assertWorkerAsset(installDir: string): void {
  const worker = join(installDir, "node_modules", SDK, "dist", "local", "worker.js")
  if (!existsSync(worker)) throw new Error("published SDK is missing the local Worker asset at " + worker)
}

/**
 * Build the publish tarballs and install them together outside the source tree.
 * This proves the packed manifests, dependency versions, contract and top-level
 * exports are consumable without workspace resolution before anything reaches
 * npm.
 */
export function verifyNpmCleanInstall(options: NpmCleanInstallOptions): void {
  const runtime = options.runtime ?? createBunRuntime()
  const log = options.log ?? console.log
  const targets = selectPublishTargets(loadPublishTargets(options.repoRoot), options.packages)
  if (options.version && targets.length !== 1) throw new Error("--version requires exactly one package")
  const entries = targets.flatMap(
    (target) =>
      buildPublishPlan({
        targets: [target],
        releaseVersion: options.version ?? target.manifest.version,
        isPublished: () => false,
      }).entries,
  )
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
    const manifests = new Map<string, Record<string, unknown>>()
    const probes: string[] = []
    for (const entry of entries) {
      const packed = packLocalTarball(entry, { repoRoot: options.repoRoot, stagingDir, runtime, log })
      manifests.set(entry.name, verifyPackedManifest(packed, entry.name + "@" + entry.version))
      if (entry.name === SDK) {
        const contract = verifyPackedContract({
          entry,
          tarball: packed,
          serverDocument: readServerDocument(options.repoRoot),
        })
        log("  packed SDK contract matches the public Server subset (" + contract.operations + " operations)")
        probes.push(...SDK_PROBE)
      } else {
        probes.push(...PLUGIN_PROBE)
      }
      tarballs.push(join(stagingDir, entry.tarball))
    }

    const plugin = entries.find((entry) => entry.name === PLUGIN)
    const sdk = entries.find((entry) => entry.name === SDK)
    if (plugin) assertPluginPinsReleasedSdk(plugin, manifests.get(PLUGIN)!, sdk)

    runtime.run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: installDir })
    runtime.run(["node", "--input-type=module", "-e", probes.join(";")], { cwd: installDir })
    if (sdk) assertWorkerAsset(installDir)
    log("npm clean-install smoke passed for " + entries.map((entry) => entry.name + "@" + entry.version).join(", "))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}
