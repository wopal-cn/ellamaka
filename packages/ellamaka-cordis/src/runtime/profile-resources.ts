import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMap, isSeq, parseDocument } from "yaml"
import type { DshRuntimeApi } from "./loader.js"
import { resolveDshLayout } from "./status.js"

/** Host-owned DSH profile resources and the one-time legacy patch cleanup. */

export const WEB_PROFILE_NAME = "web"
export const TOOLS_PROFILE_NAME = "ellamaka-tools"

/**
 * Ids the retired host-owned `ellamaka-tools` template disabled. The template
 * is gone — the container's pruning now lives only in the in-memory
 * `profileCapabilityPatches` — but homes prepared by older hosts may still
 * carry it on disk. This set exists solely to recognise those host-owned rows
 * for the one-time cleanup below.
 */
const LEGACY_TOOLS_PATCH_IDS: ReadonlySet<string> = new Set([
  "session",
  "session-checkpoint-policy",
  "agent",
  "plugin-package-inventory-deepseek",
  "agent-loop",
  "agent-default-model",
  "agent-instructions",
  "session-title",
  "session-title-llm",
  "session-persistence-jsonl",
  "session-log-deepseek",
  "session-query-sqlite",
  "session-projection-cache",
  "session-telemetry-otel",
  "llm",
  "llm-retry",
  "llm-deepseek",
  "deepseek-llm-api-extensions",
  "llm-pi-ai",
  "settings",
  "credentials",
  "typert",
  "typert-loader",
  "typert-gateway",
  "user-questions",
  "permission",
  "subagent",
  "subagent-spawn-in-process",
  "subagent-fork-in-process",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "workflow-worker-thread",
  "tool-workflow",
  "tool-ralph",
  "jobs",
  "tool-jobs",
  "goal",
  "goal-round-driver",
  "tool-goal",
  "command-goal",
  "plan-mode",
  "commands",
  "command-feedback",
  "command-compact",
  "skill",
  "skill-filesystem",
  "tool-skill",
  "compaction-basic",
  "token-meter",
  "tool-result-pruner",
  "web",
  "web-search-deepseek",
  "web-fetch-http",
  "tool-web",
  "attachment-local",
  "tool-todo",
  "repeat-tool-reminder",
])

/** The first comment line of the retired host template, used only to recognise it. */
const LEGACY_TOOLS_PATCH_MARKER = "# Patch layer for the ellamaka tool-container profile."

interface LegacyCleanupPlan {
  /** Source ranges (whole lines, including the trailing newline) to delete. */
  readonly ranges: readonly { readonly start: number; readonly end: number }[]
  /** A matched host row that cannot be dropped without touching user text. */
  readonly blocked: boolean
}

/** A legacy host row: exactly `{ id: <retired id>, disabled: true }`. */
function isLegacyHostRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 2) return false
  const row = value as { id?: unknown; disabled?: unknown }
  return typeof row.id === "string" && LEGACY_TOOLS_PATCH_IDS.has(row.id) && row.disabled === true
}

/**
 * Plan the one-time cleanup of a retired host-owned tools patch.
 *
 * Only rows the old template owned — same id AND exactly `disabled: true`, with
 * no extra keys — are removable. Comments and every unknown/user row stay
 * byte-for-byte, and a file that cannot be parsed, is not a top-level array, or
 * does not identify itself as the old template is never touched.
 *
 * Returns `null` when there is nothing to clean or ownership cannot be
 * established.
 */
function planLegacyToolsPatchCleanup(content: string): LegacyCleanupPlan | null {
  const document = parseDocument(content)
  if (document.errors.length > 0) return null
  const sequence = document.contents
  if (!isSeq(sequence)) return null
  // Only rows with a source range can be removed by line, and only those
  // count as "rows" here — anything else means the file is not a shape whose
  // ownership we can judge.
  const rows = sequence.items.filter((item) => isMap(item) && item.range !== undefined)
  const legacyRows = rows.filter((row) => isLegacyHostRow((row as { toJSON(): unknown }).toJSON()))
  if (legacyRows.length === 0) return null
  // Ownership: either the retired template's own header survives, or every
  // row in the file is one the retired template owned.
  const selfIdentified = content.includes(LEGACY_TOOLS_PATCH_MARKER)
  const entirelyHostOwned = legacyRows.length === sequence.items.length
  if (!selfIdentified && !entirelyHostOwned) return null

  const ranges: { start: number; end: number }[] = []
  let blocked = false
  for (const row of legacyRows) {
    const [start, end] = row.range
    const lineStart = content.lastIndexOf("\n", start - 1) + 1
    // A flow-style row (`- { ... }`) ends mid-line, so its trailing text is
    // right after `end`. A block-style row ends on a line break, so `end` is
    // already the next line's first character and nothing trails it.
    const endsOnLineBreak = end > 0 && content[end - 1] === "\n"
    const trailEnd = endsOnLineBreak ? end : content.indexOf("\n", end)
    const endOfLine = trailEnd === -1 ? content.length : trailEnd
    // A row the user annotated (or padded with other text on its line) is no
    // longer provably host-owned: leave the whole file alone. The only text
    // allowed before the row node is the sequence dash.
    const prefix = content.slice(lineStart, start).trim()
    const trail = endsOnLineBreak ? "" : content.slice(end, endOfLine)
    if ((prefix !== "" && prefix !== "-") || trail.trim() !== "") {
      blocked = true
      continue
    }
    ranges.push({ start: lineStart, end: Math.min(endsOnLineBreak ? end : endOfLine + 1, content.length) })
  }
  if (ranges.length === 0) return null
  return { ranges, blocked }
}

function applyCleanupRanges(content: string, ranges: readonly { start: number; end: number }[]): string {
  let next = content
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, range.start) + next.slice(range.end)
  }
  // Dropping every row can leave a comments-only file, which parses as `null`
  // and fails the loader's top-level-array contract. Keep the comments and
  // append the empty array they now describe.
  if (!isSeq(parseDocument(next).contents)) {
    if (next.length > 0 && !next.endsWith("\n")) next += "\n"
    next += "[]\n"
  }
  return next
}

/**
 * Clean a retired host-owned tools patch once, preserving every user byte.
 * Returns the new content, or `null` when the file must be left untouched
 * (nothing to clean, ambiguous ownership, or an unsafe match).
 */
function cleanLegacyToolsPatch(content: string): string | null {
  const plan = planLegacyToolsPatchCleanup(content)
  if (plan === null || plan.blocked) return null
  return applyCleanupRanges(content, plan.ranges)
}

/** The official empty home-level patch layer (dsh PROFILE_PATCH_TEMPLATE). */
export const OFFICIAL_HOME_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

export interface DshProfileResourceInspection {
  readonly ready: boolean
  readonly missing: readonly string[]
}

function resourcePathsAtRoot(dshRoot: string) {
  const profileDir = join(dshRoot, "home", "profiles")
  const web = join(profileDir, WEB_PROFILE_NAME)
  const tools = join(profileDir, TOOLS_PROFILE_NAME)
  return {
    profileDir,
    web,
    tools,
    webManifest: join(web, "package.json"),
    webPatch: join(web, "cordis.patch.yml"),
    webRoot: join(web, "cordis.yml"),
    webWorkspace: join(web, "pnpm-workspace.yaml"),
    toolsManifest: join(tools, "package.json"),
    toolsPatch: join(tools, "cordis.patch.yml"),
    toolsRoot: join(tools, "cordis.yml"),
    toolsWorkspace: join(tools, "pnpm-workspace.yaml"),
  }
}

/** Whether a tools patch still carries rows owned by the retired host template. */
function needsLegacyToolsPatchCleanup(toolsPatch: string): boolean {
  if (!existsSync(toolsPatch)) return false
  try {
    const content = readFileSync(toolsPatch, "utf8")
    const plan = planLegacyToolsPatchCleanup(content)
    return plan !== null && !plan.blocked
  } catch {
    // A present but unreadable user patch is an activation error, not a
    // preparation invitation to replace user-owned content.
    return false
  }
}

/** Purely inspect Ellamaka-owned profile resources. */
export function inspectDshProfileResources(wopalHome: string): DshProfileResourceInspection {
  const paths = resourcePathsAtRoot(resolveDshLayout(wopalHome).dshHome)
  const files = [
    paths.webManifest,
    paths.webPatch,
    paths.webRoot,
    paths.webWorkspace,
    paths.toolsManifest,
    paths.toolsPatch,
    paths.toolsRoot,
    paths.toolsWorkspace,
  ]
  const missing = files.filter((file) => !existsSync(file))
  // A retired host-owned patch still needs its one-time cleanup before the
  // profile is ready; that state stays internal (no version-specific field).
  const needsToolsPatchCleanup = needsLegacyToolsPatchCleanup(paths.toolsPatch)
  return { ready: missing.length === 0 && !needsToolsPatchCleanup, missing }
}

/**
 * Create only missing host-owned profile resources. The caller must hold the
 * exclusive Home qualification; existing manifests and patches are preserved.
 */
export function prepareDshProfileResources(wopalHome: string, runtime: DshRuntimeApi): void {
  prepareDshProfileResourcesAtRoot(resolveDshLayout(wopalHome).dshHome, runtime)
}

/** Prepare an already-resolved DSH territory root (used by isolated activation tests). */
export function prepareDshProfileResourcesAtRoot(dshRoot: string, runtime: DshRuntimeApi): void {
  const paths = resourcePathsAtRoot(dshRoot)

  // The official initializer creates missing declarations only; existing user
  // files (manifest, patch layer, pnpm settings) are never touched here.
  runtime.appBoot.initProfile(paths.web, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
  runtime.appBoot.initProfile(paths.tools, runtime.appBoot.DEFAULT_PROFILE_BUNDLES)

  // `cordis.yml` is the runtime's synthetic root anchor, not user config: the
  // loader writes the composed tree back after every mount, so preparation
  // always resets it or the next boot re-applies a stale composition.
  writeFileSync(paths.webRoot, "[]\n")
  writeFileSync(paths.toolsRoot, "[]\n")

  // One-time cleanup of a retired host-owned tools patch. The host no longer
  // owns rows in this file — pruning lives in `profileCapabilityPatches` — but
  // homes seeded by older hosts still carry the old disable list, which would
  // re-disable capabilities the container now needs. Only provably host-owned
  // rows are dropped; a user patch that cannot be attributed stays untouched.
  if (existsSync(paths.toolsPatch)) {
    const current = readFileSync(paths.toolsPatch, "utf8")
    const cleaned = cleanLegacyToolsPatch(current)
    if (cleaned !== null && cleaned !== current) writeFileSync(paths.toolsPatch, cleaned)
  }

  // Self-heal a BLANK home-level patch layer: an empty (or whitespace-only)
  // file parses as a null YAML document, not an array, and the official
  // reader fail-louds on it — one bad write bricks every subsequent web
  // profile boot ("must be a top-level YAML array"). At PREPARATION time the
  // file carries no user intent (a real layer always has content), so
  // restoring the official empty template here is initialization semantics,
  // not silent repair of a load-time misconfiguration. (Field incident
  // 2026-10-18: the file was observed blanked at runtime; the web container
  // then 401-reconnect-looped until the file was restored by hand.)
  const homePatchPath = join(dshRoot, "home", "cordis.patch.yml")
  if (existsSync(homePatchPath) && readFileSync(homePatchPath, "utf8").trim() === "") {
    writeFileSync(homePatchPath, OFFICIAL_HOME_PATCH_TEMPLATE)
  }

  // The official resolver uses this parent-walk fallback for shared packages.
  mkdirSync(join(paths.profileDir, "node_modules"), { recursive: true })
}

/** Activation is verification-only: never backfill from the running profile. */
export function assertDshProfileResourcesReady(dshRoot: string, profile: string): void {
  const paths = resourcePathsAtRoot(dshRoot)
  const required =
    profile === WEB_PROFILE_NAME
      ? [paths.webManifest, paths.webPatch, paths.webRoot, paths.webWorkspace]
      : profile === TOOLS_PROFILE_NAME
        ? [paths.toolsManifest, paths.toolsPatch, paths.toolsRoot, paths.toolsWorkspace]
        : []
  const missing = required.filter((file) => !existsSync(file))
  if (missing.length) {
    throw new Error(
      `DSH profile ${JSON.stringify(profile)} requires preparation before activation: ${missing.join(", ")}`,
    )
  }
}
