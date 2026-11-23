// packages/ellamaka-release/src/inventory.ts
//
// Read-only legacy inventory capture (docs/DISTRIBUTION.md §11). Before
// switching to the new standard SemVer publisher, the operator captures a
// one-time snapshot of the existing remote tags, R2 versioned paths,
// manifests, channel aliases and confirmable source commits. The output is
// reviewed manually before being frozen as release/legacy-inventory.json.
//
// This command is READ-ONLY. It never mutates remote state. In --dry-run
// mode it validates the script can execute and emits a schema-valid
// (empty or example) inventory, without requiring real R2/GitHub
// credentials. Real capture requires credentials and network access.
//
// Usage:
//   bun packages/ellamaka-release/src/cli/inventory.ts --dry-run
//   bun packages/ellamaka-release/src/cli/inventory.ts --output release/legacy-inventory.json
//
// Credentials (only required for real capture, not dry-run):
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2 endpoint
//   GH_TOKEN

import fs from "fs"
import path from "path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "url"
import { parseLegacyVersion } from "./identity"

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../")

const CDN_BASE = "https://download.coursedao.com"
const CLI_PREFIX = "ellamaka"
const DESKTOP_PREFIX = "ellamaka-desktop"
const GH_REPO = "wopal-cn/ellamaka"

export function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  const flags: { dryRun: boolean; output: string | null } = { dryRun: false, output: null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      flags.dryRun = true
    } else if (args[i] === "--output") {
      flags.output = args[++i]!
    }
  }
  return flags
}

type InventoryProduct = {
  tags: Array<{ name: string; sha: string | null; shape?: string }>
  versionedPaths: string[]
  manifests: Array<{
    version: string
    url: string
    sha256: string | null
    sourceCommit: unknown
    note?: string
  }>
  channelAliases: Record<string, string>
}

type Inventory = {
  schemaVersion: number
  capturedAt: string
  source: string
  note: string
  products: Record<"ellamaka-cli" | "ellamaka-desktop", InventoryProduct>
  unparsable: Array<{ name: string; reason: string }>
}

export function emptyInventory(source: string, note: string): Inventory {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    source,
    note,
    products: {
      "ellamaka-cli": { tags: [], versionedPaths: [], manifests: [], channelAliases: {} },
      "ellamaka-desktop": { tags: [], versionedPaths: [], manifests: [], channelAliases: {} },
    },
    unparsable: [],
  }
}

// --- Remote access helpers (read-only) ---

async function fetchJson(url: string, opts?: { headers?: { Authorization?: string } }) {
  // Use curl --noproxy: the sandbox HTTP proxy can hang on public hosts.
  const token = opts?.headers?.Authorization?.replace(/^Bearer /, "")
  const args = ["--noproxy", "*", "-sS", "--max-time", "10"]
  if (token) args.push("-H", `Authorization: Bearer ${token}`)
  args.push(url)
  const out = await new Promise<string | null>((resolve) => {
    execFile("curl", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
  if (out === null) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

async function listGhTags() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  let tags: Array<{ name: string; commit?: { sha?: string } }> = []
  let page = 1
  for (;;) {
    const url = `https://api.github.com/repos/${GH_REPO}/tags?per_page=100&page=${page}`
    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : {}
    const batch = await fetchJson(url, opts)
    if (!batch || !Array.isArray(batch) || batch.length === 0) break
    tags = tags.concat(batch)
    if (batch.length < 100) break
    page += 1
  }
  return tags.map((t) => ({ name: t.name, sha: t.commit?.sha ?? null }))
}

type ManifestProbe = {
  reachable: boolean
  status?: number
  version?: string | null
  sha256?: string | null
  sourceCommit?: unknown
}

async function probeManifest(url: string): Promise<ManifestProbe> {
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      "curl",
      ["--noproxy", "*", "-sS", "--max-time", "10", "-w", "\n%{http_code}", url],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        resolve(err ? null : stdout)
      },
    )
  })
  if (out === null) return { reachable: false }
  const nl = out.lastIndexOf("\n")
  const code = Number(out.slice(nl + 1).trim())
  const body = out.slice(0, nl)
  if (code !== 200) return { reachable: false, status: code }
  try {
    const m = JSON.parse(body)
    return {
      reachable: true,
      version: m.version ?? null,
      sha256: null,
      sourceCommit: m.build ?? null,
    }
  } catch {
    return { reachable: true, version: null, sha256: null, sourceCommit: null }
  }
}

// --- Classification ---

export function classifyTag(name: string) {
  // New-standard namespaced tags are not legacy entries.
  if (name.startsWith("ellamaka-cli-v") || name.startsWith("ellamaka-desktop-v")) {
    return { kind: "standard" }
  }
  // Strip the generic v prefix (old generic tags, e.g. v1.15.13-4).
  const plain = name.replace(/^v/, "")
  try {
    const legacy = parseLegacyVersion(plain)
    return { kind: "legacy", shape: legacy.legacyShape }
  } catch (err) {
    // ELEGACY means the shape is standard SemVer (e.g. v1.15.13-beta.4 or
    // v1.15.13) — record it for audit, it does not participate in the
    // migration floor. Other errors are truly unparsable.
    const reason = String((err as Error)?.message ?? err)
    if (reason.includes("ELEGACY") || reason.includes("not a legacy shape")) {
      return { kind: "standard-shape", plain }
    }
    return { kind: "unparsable" }
  }
}

export async function mainLive(flags: { dryRun: boolean; output: string | null }) {
  const inventory = emptyInventory("live", "Live capture — review and freeze before switching publisher")

  process.stdout.write(`[live] fetching tags from GitHub (${GH_REPO})...\n`)
  const tags = await listGhTags()
  process.stdout.write(`[live] found ${tags.length} tags\n`)

  const cliProducts: Array<"ellamaka-cli" | "ellamaka-desktop"> = ["ellamaka-cli"]
  const desktopProducts: Array<"ellamaka-cli" | "ellamaka-desktop"> = ["ellamaka-desktop"]
  const cliPaths = ["ellamaka"]
  const desktopPaths = ["ellamaka-desktop", "ellamaka-desktop/beta"]
  const cliAliases = {
    latest: `${CDN_BASE}/${CLI_PREFIX}/latest/manifest.json`,
  }
  const desktopAliases = {
    latest: `${CDN_BASE}/${DESKTOP_PREFIX}/latest/manifest.json`,
    beta: `${CDN_BASE}/${DESKTOP_PREFIX}/beta/latest/manifest.json`,
  }

  for (const tag of tags) {
    const cls = classifyTag(tag.name)
    if (cls.kind === "legacy") {
      // Legacy tags in the shared-version era (generic vX.Y.Z-N) were used
      // by BOTH CLI and Desktop. Desktop-prefixed tags (ellamaka-desktop-*)
      // belong only to Desktop. Record shared tags in both products so each
      // product's migration floor covers every version it ever shipped.
      const product: "ellamaka-cli" | "ellamaka-desktop" = tag.name.startsWith("ellamaka-desktop-")
        ? "ellamaka-desktop"
        : "ellamaka-cli"
      inventory.products[product].tags.push({ name: tag.name, sha: tag.sha, shape: cls.shape })
      if (product === "ellamaka-cli" && !tag.name.startsWith("ellamaka-")) {
        inventory.products["ellamaka-desktop"].tags.push({ name: tag.name, sha: tag.sha, shape: cls.shape })
      }
    } else if (cls.kind === "standard-shape") {
      // Standard SemVer shape under the old generic tag namespace (e.g.
      // v1.15.13-beta.4). Not a legacy iteration, but audited so the
      // operator can see which generic tags existed before the switch.
      inventory.unparsable.push({ name: tag.name, reason: "standard-shape-pre-namespace" })
    } else if (cls.kind === "unparsable") {
      inventory.unparsable.push({ name: tag.name, reason: "not-legacy-shape" })
    }
    // Standard namespaced tags are not recorded; they belong to the new publisher.
  }

  // Versioned paths + manifests: probe CDN for each legacy version.
  const legacyByProduct = {
    "ellamaka-cli": inventory.products["ellamaka-cli"].tags.map((t: { name: string }) => t.name),
    "ellamaka-desktop": inventory.products["ellamaka-desktop"].tags.map((t: { name: string }) => t.name),
  }

  for (const product of cliProducts) {
    for (const t of legacyByProduct[product]) {
      const plain = t.replace(/^v/, "")
      const url = `${CDN_BASE}/${CLI_PREFIX}/v${plain}/manifest.json`
      const probe = await probeManifest(url)
      if (probe.reachable) {
        inventory.products[product].versionedPaths.push(`${CLI_PREFIX}/v${plain}`)
        inventory.products[product].manifests.push({
          version: probe.version ?? plain,
          url,
          sha256: probe.sha256 ?? null,
          sourceCommit: probe.sourceCommit,
        })
      } else {
        inventory.products[product].versionedPaths.push(`${CLI_PREFIX}/v${plain}`)
        inventory.products[product].manifests.push({
          version: plain,
          url,
          sha256: null,
          sourceCommit: null,
          note: "manifest not reachable",
        })
      }
    }
  }

  for (const product of desktopProducts) {
    for (const t of legacyByProduct[product]) {
      const plain = t.replace(/^ellamaka-desktop-/, "")
      // Desktop legacy tags are beta.4 style; versioned path is v<plain>.
      const url = `${CDN_BASE}/${DESKTOP_PREFIX}/v${plain}/manifest.json`
      const probe = await probeManifest(url)
      if (probe.reachable) {
        inventory.products[product].versionedPaths.push(`${DESKTOP_PREFIX}/v${plain}`)
        inventory.products[product].manifests.push({
          version: probe.version ?? plain,
          url,
          sha256: probe.sha256 ?? null,
          sourceCommit: probe.sourceCommit,
        })
      } else {
        inventory.products[product].versionedPaths.push(`${DESKTOP_PREFIX}/v${plain}`)
        inventory.products[product].manifests.push({
          version: plain,
          url,
          sha256: null,
          sourceCommit: null,
          note: "manifest not reachable",
        })
      }
    }
  }

  // Channel aliases: read current latest manifests.
  for (const [alias, url] of Object.entries(cliAliases)) {
    const probe = await probeManifest(url)
    inventory.products["ellamaka-cli"].channelAliases[alias] = probe.reachable
      ? (probe.version ?? "unknown")
      : "unreachable"
  }
  for (const [alias, url] of Object.entries(desktopAliases)) {
    const probe = await probeManifest(url)
    inventory.products["ellamaka-desktop"].channelAliases[alias] = probe.reachable
      ? (probe.version ?? "unknown")
      : "unreachable"
  }

  // Desktop legacy versions historically used generic vX.Y.Z-N tags (which
  // are attributed to the CLI product), so their CDN versioned paths are
  // not covered by the tag loop. Probe the versions referenced by the
  // Desktop aliases so the Desktop inventory records the real CDN objects.
  const desktopAliasVersions = new Set(
    Object.values(inventory.products["ellamaka-desktop"].channelAliases).filter(
      (v) => typeof v === "string" && v !== "unknown" && v !== "unreachable",
    ),
  )
  for (const plain of desktopAliasVersions) {
    const url = `${CDN_BASE}/${DESKTOP_PREFIX}/v${plain}/manifest.json`
    const probe = await probeManifest(url)
    inventory.products["ellamaka-desktop"].versionedPaths.push(`${DESKTOP_PREFIX}/v${plain}`)
    inventory.products["ellamaka-desktop"].manifests.push({
      version: probe.version ?? plain,
      url,
      sha256: probe.sha256 ?? null,
      sourceCommit: probe.sourceCommit,
      ...(probe.reachable ? {} : { note: "manifest not reachable" }),
    })
  }

  const outPath = flags.output || path.join(projectRoot, "release", "legacy-inventory.live.json")
  fs.writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n")
  process.stdout.write(`[ok] wrote ${path.relative(projectRoot, outPath)}\n`)
  process.stdout.write(`[ok] review and freeze as release/legacy-inventory.json before publishing\n`)
}

export function main(opts?: { dryRun?: boolean; output?: string | null }) {
  const flags = parseArgs(process.argv)
  const dryRun = opts?.dryRun ?? flags.dryRun
  const output = opts?.output ?? flags.output
  if (dryRun) {
    const inventory = emptyInventory("dry-run", "DRY-RUN — schema validation only; replace with real capture output")
    const outPath = output || path.join(projectRoot, "release", "legacy-inventory.dry-run.json")
    fs.writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n")
    process.stdout.write(`[ok] wrote ${path.relative(projectRoot, outPath)}\n`)
    return
  }

  // Live capture: GitHub tags + CDN versioned manifests + channel aliases.
  // Read-only; requires GH_TOKEN (or gh CLI) for the tag list. CDN objects
  // are public and need no R2 credentials.
  // Fire-and-forget by design: `main` is the synchronous CLI seam and the
  // capture reports its own failures by rejecting, which stays observable.
  void mainLive(flags)
}
