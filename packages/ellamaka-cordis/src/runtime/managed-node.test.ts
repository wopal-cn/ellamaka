import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MANAGED_NODE_VERSION,
  inspectManagedNode,
  managedNodePaths,
  mayDeleteManagedNode,
  prepareManagedNode,
  type ManagedNodeDeps,
  type ManagedNodeOptions,
  type ManagedNodeRecord,
} from "./managed-node"

const homes: string[] = []
const assetBytes = new TextEncoder().encode("fixed-test-Node-executable")
const assetSha = createHash("sha256").update(assetBytes).digest("hex")

function fixture(): { options: ManagedNodeOptions; deps: ManagedNodeDeps; downloaded: { count: number } } {
  const wopalHome = mkdtempSync(join(tmpdir(), "dsh-managed-node-"))
  homes.push(wopalHome)
  const downloaded = { count: 0 }
  return {
    options: {
      wopalHome,
      platform: "win32",
      arch: "x64",
      owner: { product: "ellamaka-cli", version: "2.0.10", channel: "stable" },
    },
    deps: {
      asset: { path: "win-x64/node.exe", sha256: assetSha, format: "exe" },
      download: async () => {
        downloaded.count++
        return assetBytes
      },
      probe: async () => `v${MANAGED_NODE_VERSION}`,
    },
    downloaded,
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe("managed Node for DSH Web only", () => {
  test("pins the official platform asset identities and reports unsupported platforms", async () => {
    const { options } = fixture()
    expect(managedNodePaths(options).executable).toContain("24.21.0/win32-x64/bin/node.exe")
    expect(await inspectManagedNode({ ...options, platform: "freebsd" })).toEqual({
      code: "DSH_WEB_PTC_NODE_PLATFORM_UNSUPPORTED",
    })
    expect(existsSync(join(options.wopalHome, "dsh"))).toBe(false)
  })

  test("first install pins checksum, records ownership, exposes the fixed absolute binary and never touches Home", async () => {
    const { options, deps, downloaded } = fixture()
    const paths = managedNodePaths(options)
    expect(await inspectManagedNode(options, deps)).toBe("NEEDS_PREPARATION")
    const phases: string[] = []
    const executable = await prepareManagedNode(
      options,
      new AbortController().signal,
      (phase) => phases.push(phase),
      deps,
    )
    expect(executable).toBe(paths.executable)
    expect(await readFile(executable)).toEqual(Buffer.from(assetBytes))
    expect(await readFile(paths.archive)).toEqual(Buffer.from(assetBytes))
    expect(phases).toEqual(["node.cache", "node.download", "node.install", "node.completed"])
    expect(downloaded.count).toBe(1)
    expect(await inspectManagedNode(options, deps)).toBe("READY")
    const record: ManagedNodeRecord = JSON.parse(await readFile(paths.record, "utf8"))
    expect(record).toMatchObject({
      version: MANAGED_NODE_VERSION,
      platform: "win32",
      arch: "x64",
      archiveSha256: assetSha,
      owners: [options.owner],
    })
    expect(record.source).toBe("https://nodejs.org/dist/v24.21.0/win-x64/node.exe")
    expect(record.executableSha256).toBe(assetSha)
    expect(existsSync(join(options.wopalHome, "dsh", "home"))).toBe(false)
    expect(existsSync(join(options.wopalHome, "dsh", "closures"))).toBe(false)
  })

  test("offline reuse and corrupted binary recovery use verified cache; second owner never clears shared Node", async () => {
    const { options, deps, downloaded } = fixture()
    const abort = new AbortController().signal
    await prepareManagedNode(options, abort, undefined, deps)
    const offlineDeps: ManagedNodeDeps = {
      ...deps,
      download: async () => {
        throw new Error("must remain offline")
      },
    }
    await prepareManagedNode(options, abort, undefined, offlineDeps)
    const another: ManagedNodeOptions = {
      ...options,
      owner: { product: "ellamaka-cli", version: "2.0.11", channel: "beta" },
    }
    expect(await inspectManagedNode(another, offlineDeps)).toBe("NEEDS_PREPARATION")
    await prepareManagedNode(another, abort, undefined, offlineDeps)
    let record: ManagedNodeRecord = JSON.parse(await readFile(managedNodePaths(options).record, "utf8"))
    expect(record.owners).toEqual([options.owner, another.owner])
    expect(mayDeleteManagedNode(record, options.owner, true)).toBe(false)
    expect(mayDeleteManagedNode(record, another.owner, false)).toBe(false)
    expect(mayDeleteManagedNode({ ...record, owners: [another.owner] }, another.owner, true)).toBe(true)

    const paths = managedNodePaths(options)
    await writeFile(paths.executable, "tampered")
    expect(await inspectManagedNode(options, offlineDeps)).toBe("NEEDS_PREPARATION")
    await prepareManagedNode(options, abort, undefined, offlineDeps)
    record = JSON.parse(await readFile(paths.record, "utf8"))
    expect(record.owners).toEqual([options.owner, another.owner])
    expect(await inspectManagedNode(another, offlineDeps)).toBe("READY")
    expect(downloaded.count).toBe(1)

    // A user may remove only the managed executable. Recover from our
    // verified cache offline without touching Home, closure, or other owners.
    rmSync(paths.executable)
    expect(await inspectManagedNode(options, offlineDeps)).toBe("NEEDS_PREPARATION")
    await prepareManagedNode(options, abort, undefined, offlineDeps)
    expect(await readFile(paths.executable)).toEqual(Buffer.from(assetBytes))
    expect(await inspectManagedNode(another, offlineDeps)).toBe("READY")
    record = JSON.parse(await readFile(paths.record, "utf8"))
    expect(record.owners).toEqual([options.owner, another.owner])
    expect(downloaded.count).toBe(1)
    expect(existsSync(join(options.wopalHome, "dsh", "home"))).toBe(false)
    expect(existsSync(join(options.wopalHome, "dsh", "closures"))).toBe(false)
  })

  test("checksum mismatch, missing ownership and cancellation fail closed without publishing a Node executable", async () => {
    const { options, deps } = fixture()
    const paths = managedNodePaths(options)
    await expect(
      prepareManagedNode(options, new AbortController().signal, undefined, {
        ...deps,
        download: async () => new TextEncoder().encode("incorrect archive"),
      }),
    ).rejects.toMatchObject({ code: "DSH_WEB_PTC_NODE_CHECKSUM_FAILED" })
    expect(existsSync(paths.executable)).toBe(false)
    expect(existsSync(paths.record)).toBe(false)
    const aborted = new AbortController()
    aborted.abort(new Error("cancelled"))
    await expect(prepareManagedNode(options, aborted.signal, undefined, deps)).rejects.toThrow("cancelled")
    await prepareManagedNode(options, new AbortController().signal, undefined, deps)
    await writeFile(paths.record, "{}")
    expect(await inspectManagedNode(options, deps)).toEqual({ code: "DSH_WEB_PTC_NODE_RECORD_INVALID" })
    await expect(prepareManagedNode(options, new AbortController().signal, undefined, deps)).rejects.toMatchObject({
      code: "DSH_WEB_PTC_NODE_RECORD_INVALID",
    })
    expect(existsSync(paths.executable)).toBe(true)
  })

  test("installation content is sourced from the verified archive, not an untrusted download path", async () => {
    const { options, deps } = fixture()
    const paths = managedNodePaths(options)
    let extracted = false
    await prepareManagedNode(options, new AbortController().signal, undefined, {
      ...deps,
      extract: async (archive, destination) => {
        extracted = true
        await mkdir(join(destination, "bin"), { recursive: true })
        await copyFile(archive, join(destination, "bin", "node.exe"))
      },
    })
    expect(extracted).toBe(true)
    expect(await readFile(paths.executable)).toEqual(Buffer.from(assetBytes))
    expect(existsSync(paths.record)).toBe(true)
  })
})
