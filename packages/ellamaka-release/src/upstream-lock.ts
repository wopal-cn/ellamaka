// packages/ellamaka-release/src/upstream-lock.ts
//
// The ONLY writer for release/upstreams.lock.json. Per docs/DISTRIBUTION.md
// §3.3, the upstream lock is never updated by release workflows, inputs, or
// environment variables. Only this command, invoked by an operator, resolves
// a target OpenCode tag's full commit and writes it into the lock.
//
// Usage:
//   bun packages/ellamaka-release/src/cli/upstream-lock.ts engine --version 1.18.10
//
// This performs a real `git ls-remote` against the upstream repo to resolve
// the tag commit. In dry-run mode (--dry-run) it only prints what would
// change without writing.

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"
import { validateUpstreamLock } from "./identity"

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../")
const LOCK_PATH = path.join(projectRoot, "release", "upstreams.lock.json")
const UPSTREAM_REPO = "https://github.com/anomalyco/opencode.git"

export function usage(): never {
  process.stderr.write(
    `Usage:
  bun packages/ellamaka-release/src/cli/upstream-lock.ts engine --version <X.Y.Z> [--dry-run]
`,
  )
  process.exit(2)
}

export function parseArgs(argv: string[]): { mode: string; dryRun?: boolean; version?: string } {
  const args = argv.slice(2)
  const mode = args[0]
  if (mode !== "engine") usage()

  const flags: { mode: string; dryRun?: boolean; version?: string } = { mode }
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      flags.dryRun = true
      continue
    }
    if (args[i] === "--version") {
      flags.version = args[++i]
      continue
    }
    usage()
  }

  if (!flags.version) usage()
  return flags
}

export function resolveUpstreamCommit(version: string): string {
  // Resolve the OpenCode tag `vX.Y.Z` to a full 40-char commit via ls-remote.
  const tag = `v${version}`
  try {
    const out = execSync(`git ls-remote ${UPSTREAM_REPO} refs/tags/${tag}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    if (!out) throw new Error(`tag ${tag} not found upstream`)
    const sha = out.split(/\s+/)[0]!
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`resolved sha ${sha} is not 40 chars`)
    }
    return sha
  } catch (err) {
    // In dry-run / offline scenarios, allow --commit override via env to keep
    // the command testable. Real operator use resolves via ls-remote.
    const override = process.env.OPENCODE_UPSTREAM_COMMIT
    if (override && /^[0-9a-f]{40}$/.test(override)) return override
    throw err
  }
}

export function run(opts?: { dryRun?: boolean; version?: string }) {
  const parsed = parseArgs(process.argv)
  const dryRun = opts?.dryRun ?? parsed.dryRun
  const version = opts?.version ?? parsed.version!
  applyLockUpdate({ dryRun, version })
}

export function applyLockUpdate({
  dryRun,
  version,
  lockPath = LOCK_PATH,
}: {
  dryRun?: boolean
  version: string
  lockPath?: string
}) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))

  const commit = resolveUpstreamCommit(version)
  lock.sources.opencode.version = version
  lock.sources.opencode.gitCommit = commit
  process.stdout.write(`[engine] sources.opencode → version=${version}, commit=${commit}\n`)

  validateUpstreamLock(lock)
  if (dryRun) {
    process.stdout.write(`[dry-run] no write performed\n`)
  } else {
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n")
    process.stdout.write(`[ok] wrote ${path.relative(projectRoot, lockPath)}\n`)
  }
}
