/**
 * DSH Web's fixed, independently managed Node worker executable.
 * Neither the Bun CLI nor the immutable DSH closure contains this asset.
 */
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { acquireMaterializeLock, releaseMaterializeLock } from "./lock.js"

export const MANAGED_NODE_VERSION = "24.21.0"
const NODE_DIST = `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}`
const NODE_RECORD_SCHEMA = "ellamaka.dsh-managed-node/v1"
const LOCK_WAIT_MS = 10 * 60 * 1000

export interface ManagedNodeAsset {
  readonly path: string
  readonly sha256: string
  readonly format: "tar.gz" | "exe"
}

/** SHA-256s from the official v24.21.0 SHASUMS256.txt, pinned at build time. */
const ASSETS: Readonly<Record<string, ManagedNodeAsset>> = {
  "darwin-arm64": {
    path: `node-v${MANAGED_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    format: "tar.gz",
  },
  "darwin-x64": {
    path: `node-v${MANAGED_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
    format: "tar.gz",
  },
  "linux-arm64": {
    path: `node-v${MANAGED_NODE_VERSION}-linux-arm64.tar.gz`,
    sha256: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
    format: "tar.gz",
  },
  "linux-x64": {
    path: `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`,
    sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    format: "tar.gz",
  },
  "win32-x64": {
    path: "win-x64/node.exe",
    sha256: "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32",
    format: "exe",
  },
}

export interface ManagedNodeOwner {
  readonly product: "ellamaka-cli"
  readonly version: string
  readonly channel: string
}

export interface ManagedNodeRecord {
  readonly schema: typeof NODE_RECORD_SCHEMA
  readonly version: typeof MANAGED_NODE_VERSION
  readonly platform: string
  readonly arch: string
  readonly source: string
  readonly archiveSha256: string
  readonly executableSha256: string
  readonly owners: readonly ManagedNodeOwner[]
}

export class ManagedNodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ManagedNodeError"
  }
}

export interface ManagedNodeOptions {
  readonly wopalHome: string
  readonly owner: ManagedNodeOwner
  readonly platform?: string
  readonly arch?: string
}

export interface ManagedNodePaths {
  readonly runtimeRoot: string
  readonly cacheRoot: string
  readonly installDir: string
  readonly executable: string
  readonly record: string
  readonly archive: string
  readonly lock: string
}

export interface ManagedNodeDeps {
  /** Test seam only; production uses the SHA-256 pinned official asset. */
  readonly asset?: ManagedNodeAsset
  readonly download?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly extract?: (
    archive: string,
    destination: string,
    asset: ManagedNodeAsset,
    signal: AbortSignal,
  ) => Promise<void>
  readonly probe?: (executable: string, signal: AbortSignal) => Promise<string>
}

export function managedNodeAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): ManagedNodeAsset | undefined {
  return ASSETS[`${platform}-${arch}`]
}

export function managedNodePaths(
  options: Pick<ManagedNodeOptions, "wopalHome" | "platform" | "arch">,
): ManagedNodePaths {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const runtimeRoot = join(options.wopalHome, "dsh", "runtime", "node")
  const cacheRoot = join(options.wopalHome, "dsh", "cache", "node")
  const installDir = join(runtimeRoot, MANAGED_NODE_VERSION, `${platform}-${arch}`)
  const asset = managedNodeAsset(platform, arch)
  return {
    runtimeRoot,
    cacheRoot,
    installDir,
    executable: join(installDir, "bin", platform === "win32" ? "node.exe" : "node"),
    record: join(installDir, "managed.json"),
    archive: join(cacheRoot, asset?.path.replaceAll("/", "-") ?? "unsupported"),
    lock: join(runtimeRoot, ".prepare.lock"),
  }
}

function sameOwner(a: ManagedNodeOwner, b: ManagedNodeOwner): boolean {
  return a.product === b.product && a.version === b.version && a.channel === b.channel
}

/** Future uninstallers must also verify that no Worker process is using it. */
export function mayDeleteManagedNode(
  record: ManagedNodeRecord,
  releasing: ManagedNodeOwner,
  workersStopped: boolean,
): boolean {
  return (
    workersStopped &&
    record.owners.some((owner) => sameOwner(owner, releasing)) &&
    record.owners.every((owner) => sameOwner(owner, releasing))
  )
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function recordShape(input: unknown): input is ManagedNodeRecord {
  if (typeof input !== "object" || !input || Array.isArray(input)) return false
  return (
    "schema" in input &&
    input.schema === NODE_RECORD_SCHEMA &&
    "version" in input &&
    input.version === MANAGED_NODE_VERSION &&
    "platform" in input &&
    typeof input.platform === "string" &&
    "arch" in input &&
    typeof input.arch === "string" &&
    "source" in input &&
    typeof input.source === "string" &&
    "archiveSha256" in input &&
    typeof input.archiveSha256 === "string" &&
    "executableSha256" in input &&
    typeof input.executableSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(input.executableSha256) &&
    "owners" in input &&
    Array.isArray(input.owners) &&
    input.owners.every(
      (owner: unknown) =>
        typeof owner === "object" &&
        owner !== null &&
        "product" in owner &&
        owner.product === "ellamaka-cli" &&
        "version" in owner &&
        typeof owner.version === "string" &&
        "channel" in owner &&
        typeof owner.channel === "string",
    )
  )
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function readRecord(path: string): Promise<ManagedNodeRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!recordShape(parsed)) throw new Error("invalid managed Node inventory")
    return parsed
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new ManagedNodeError("DSH_WEB_PTC_NODE_RECORD_INVALID", `Invalid managed Node record: ${path}`, {
      cause: error,
    })
  }
}

async function probeNode(path: string, signal: AbortSignal): Promise<string> {
  const result = await promisify(execFile)(path, ["--version"], { timeout: 15_000, signal, windowsHide: true })
  return result.stdout.trim()
}

async function validBinary(
  path: string,
  record: ManagedNodeRecord,
  signal: AbortSignal,
  deps: ManagedNodeDeps,
): Promise<boolean> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    if (sha256(await readFile(path)) !== record.executableSha256) return false
    return (await (deps.probe ?? probeNode)(path, signal)).trim() === `v${MANAGED_NODE_VERSION}`
  } catch {
    return false
  }
}

function assetFor(options: ManagedNodeOptions, deps: ManagedNodeDeps): ManagedNodeAsset {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const official = managedNodeAsset(platform, arch)
  if (!official)
    throw new ManagedNodeError(
      "DSH_WEB_PTC_NODE_PLATFORM_UNSUPPORTED",
      `Node ${MANAGED_NODE_VERSION} is unsupported on ${platform}-${arch}`,
    )
  return deps.asset ?? official
}

async function verifiedRecord(options: ManagedNodeOptions, deps: ManagedNodeDeps, signal: AbortSignal) {
  const asset = assetFor(options, deps)
  const paths = managedNodePaths(options)
  const record = await readRecord(paths.record)
  if (!record) {
    try {
      await lstat(paths.installDir)
    } catch (error) {
      if (isMissingFile(error)) return { paths, asset, record: undefined, valid: false }
      throw error
    }
    throw new ManagedNodeError("DSH_WEB_PTC_NODE_UNOWNED", "Existing managed Node directory has no verified inventory")
  }
  if (
    record.platform !== (options.platform ?? process.platform) ||
    record.arch !== (options.arch ?? process.arch) ||
    record.archiveSha256 !== asset.sha256 ||
    record.source !== `${NODE_DIST}/${asset.path}`
  ) {
    throw new ManagedNodeError(
      "DSH_WEB_PTC_NODE_RECORD_INVALID",
      "Managed Node inventory does not match the pinned runtime",
    )
  }
  return { paths, asset, record, valid: await validBinary(paths.executable, record, signal, deps) }
}

export async function inspectManagedNode(
  options: ManagedNodeOptions,
  deps: ManagedNodeDeps = {},
): Promise<"READY" | "NEEDS_PREPARATION" | { code: string }> {
  try {
    const { record, valid } = await verifiedRecord(options, deps, new AbortController().signal)
    return valid && record?.owners.some((owner) => sameOwner(owner, options.owner)) ? "READY" : "NEEDS_PREPARATION"
  } catch (error) {
    return { code: error instanceof ManagedNodeError ? error.code : "DSH_WEB_PTC_NODE_INSPECTION_FAILED" }
  }
}

async function downloadNode(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Node download HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function extractNode(
  archive: string,
  destination: string,
  asset: ManagedNodeAsset,
  signal: AbortSignal,
): Promise<void> {
  const executable = join(destination, "bin", "node")
  await mkdir(dirname(executable), { recursive: true })
  if (asset.format === "exe") {
    await copyFile(archive, join(destination, "bin", "node.exe"))
  } else {
    const root = asset.path.slice(0, -".tar.gz".length)
    await promisify(execFile)("tar", ["-xzf", archive, "-C", destination, "--strip-components=1", `${root}/bin/node`], {
      timeout: 120_000,
      signal,
      windowsHide: true,
    })
    await chmod(executable, 0o755)
  }
}

async function recordAtomically(path: string, record: ManagedNodeRecord): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

export async function prepareManagedNode(
  options: ManagedNodeOptions,
  signal: AbortSignal,
  report: (phase: string) => void = () => {},
  deps: ManagedNodeDeps = {},
): Promise<string> {
  const asset = assetFor(options, deps)
  const paths = managedNodePaths(options)
  signal.throwIfAborted()
  await mkdir(paths.runtimeRoot, { recursive: true })
  const token = await acquireMaterializeLock(paths.lock, LOCK_WAIT_MS)
  if (!token) throw new ManagedNodeError("DSH_WEB_PTC_NODE_BUSY", "Managed Node installation is locked")
  try {
    const inspection = await verifiedRecord(options, deps, signal)
    if (inspection.valid && inspection.record) {
      if (!inspection.record.owners.some((owner) => sameOwner(owner, options.owner))) {
        await recordAtomically(paths.record, {
          ...inspection.record,
          owners: [...inspection.record.owners, options.owner],
        })
      }
      return paths.executable
    }

    report("node.cache")
    let cacheValid = false
    try {
      cacheValid = sha256(await readFile(paths.archive)) === asset.sha256
    } catch {
      /* First install or removed cache. */
    }
    if (!cacheValid) {
      signal.throwIfAborted()
      report("node.download")
      const bytes = await (deps.download ?? downloadNode)(`${NODE_DIST}/${asset.path}`, signal)
      if (sha256(bytes) !== asset.sha256)
        throw new ManagedNodeError(
          "DSH_WEB_PTC_NODE_CHECKSUM_FAILED",
          "Node archive SHA-256 does not match the pinned official checksum",
        )
      await mkdir(paths.cacheRoot, { recursive: true })
      const tmp = join(paths.cacheRoot, `.download-${randomUUID()}`)
      try {
        await writeFile(tmp, bytes, { flag: "wx" })
        await rename(tmp, paths.archive)
      } finally {
        await rm(tmp, { force: true })
      }
    }

    signal.throwIfAborted()
    report("node.install")
    const stage = await mkdtemp(join(paths.runtimeRoot, ".stage-"))
    try {
      await (deps.extract ?? extractNode)(paths.archive, stage, asset, signal)
      const bin = join(stage, "bin", (options.platform ?? process.platform) === "win32" ? "node.exe" : "node")
      const stat = await lstat(bin)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Node executable is not a regular file")
      const executableSha256 = sha256(await readFile(bin))
      const version = await (deps.probe ?? probeNode)(bin, signal)
      if (version.trim() !== `v${MANAGED_NODE_VERSION}`)
        throw new ManagedNodeError("DSH_WEB_PTC_NODE_VERSION_MISMATCH", `Node binary reports ${version.trim()}`)
      const record: ManagedNodeRecord = {
        schema: NODE_RECORD_SCHEMA,
        version: MANAGED_NODE_VERSION,
        platform: options.platform ?? process.platform,
        arch: options.arch ?? process.arch,
        source: `${NODE_DIST}/${asset.path}`,
        archiveSha256: asset.sha256,
        executableSha256,
        owners: inspection.record?.owners.some((owner) => sameOwner(owner, options.owner))
          ? inspection.record.owners
          : [...(inspection.record?.owners ?? []), options.owner],
      }
      await recordAtomically(join(stage, "managed.json"), record)
      await mkdir(dirname(paths.installDir), { recursive: true })
      const old = `${paths.installDir}.previous-${randomUUID()}`
      let oldMoved = false
      if (inspection.record) {
        await rename(paths.installDir, old)
        oldMoved = true
      }
      try {
        await rename(stage, paths.installDir)
      } catch (error) {
        if (oldMoved) await rename(old, paths.installDir)
        throw error
      }
      if (oldMoved) await rm(old, { recursive: true, force: true })
      report("node.completed")
      return paths.executable
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  } catch (error) {
    if (error instanceof ManagedNodeError) throw error
    throw new ManagedNodeError("DSH_WEB_PTC_NODE_PREPARATION_FAILED", "Failed to prepare the official Node runtime", {
      cause: error,
    })
  } finally {
    await releaseMaterializeLock(paths.lock, token)
  }
}
