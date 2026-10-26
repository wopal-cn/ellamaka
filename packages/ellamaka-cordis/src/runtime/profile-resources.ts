import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMap, isSeq, parseDocument } from "yaml"
import type { DshRuntimeApi } from "./loader.js"
import { resolveDshLayout } from "./status.js"
import { TOOLS_PROFILE_BLOCK, TOOLS_PROFILE_BLOCK_BEGIN, TOOLS_PROFILE_BLOCK_END } from "./tools-profile.js"

/** Host-owned DSH profile resources and the one-time legacy patch cleanup. */

export const WEB_PROFILE_NAME = "web"
export const TOOLS_PROFILE_NAME = "ellamaka-tools"
export type DshProfileName = typeof WEB_PROFILE_NAME | typeof TOOLS_PROFILE_NAME

const ALL_PROFILE_NAMES: readonly DshProfileName[] = [WEB_PROFILE_NAME, TOOLS_PROFILE_NAME]

/**
 * Ids the retired host-owned `ellamaka-tools` template disabled. The template
 * is gone, but homes prepared by older hosts may still carry it on disk.
 * This set only recognises host-owned rows for the one-time cleanup below;
 * it never determines the active composition.
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
  /** Whole-file replacement for a file that is entirely retired host text. */
  readonly replacement?: string
  /** A matched host row that cannot be dropped without touching user text. */
  readonly blocked: boolean
}

/** A retired host disable row: exactly `{ id: <retired id>, disabled: true }`. */
function isLegacyHostRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 2) return false
  const row = value as { id?: unknown; disabled?: unknown }
  return typeof row.id === "string" && LEGACY_TOOLS_PATCH_IDS.has(row.id) && row.disabled === true
}

/**
 * The retired template's extra-root override: `sandbox-roots-policy` with only
 * the two keys the host owned. That row targeted a base entry the standalone
 * composition does not declare, so it is dead configuration, not user intent.
 */
function isLegacyRootsRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const row = value as { id?: unknown; config?: unknown }
  if (row.id !== "sandbox-roots-policy" || Object.keys(row).length !== 2) return false
  const config = row.config
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false
  const keys = Object.keys(config)
  return keys.length === 2 && keys.every((key) => key === "mode" || key === "workspaceRoot")
}

function isRetiredHostRow(value: unknown): boolean {
  return isLegacyHostRow(value) || isLegacyRootsRow(value)
}

/** The product-owned composition span, when both markers are intact. */
function productBlockSpan(content: string): { start: number; end: number } | null {
  const start = content.indexOf(TOOLS_PROFILE_BLOCK_BEGIN)
  const end = content.indexOf(TOOLS_PROFILE_BLOCK_END)
  if (start === -1 || end === -1 || end < start) return null
  return { start, end: end + TOOLS_PROFILE_BLOCK_END.length }
}

/**
 * Plan the one-time cleanup of a retired host-owned tools patch.
 *
 * Only text the old template owned is removable: its disable rows (same id AND
 * exactly `disabled: true`), its extra-root override, and — when the file holds
 * no user row at all — its own comment scaffold. Every user row and every file
 * that cannot be parsed, is not a top-level array, or does not identify itself
 * as the old template is left untouched.
 *
 * Returns `null` when there is nothing to clean or ownership cannot be
 * established.
 */
function planLegacyToolsPatchCleanup(content: string): LegacyCleanupPlan | null {
  const document = parseDocument(content)
  if (document.errors.length > 0) return null
  const sequence = document.contents
  if (!isSeq(sequence)) return null
  const block = productBlockSpan(content)
  // Product composition rows belong to the block above them, never to the
  // retired template's ownership accounting.
  const rows = sequence.items.filter(
    (item) =>
      !(
        block !== null &&
        isMap(item) &&
        item.range !== undefined &&
        item.range[0] >= block.start &&
        item.range[0] < block.end
      ),
  )
  const legacyRows = rows.filter((row) => isMap(row) && isRetiredHostRow((row as { toJSON(): unknown }).toJSON()))
  const userRows = rows.filter((row) => !legacyRows.includes(row))
  // Ownership: either the retired template's own header survives, or every
  // row in the file is one the retired template owned.
  const selfIdentified = content.includes(LEGACY_TOOLS_PATCH_MARKER)
  if (!selfIdentified && (legacyRows.length === 0 || userRows.length > 0)) return null

  // A self-identified file with no user row is the retired template end to
  // end (its header, sections, comments and rows). Nothing in it is worth
  // preserving except the product block, so the stale scaffold is replaced
  // wholesale instead of being line-patched into a comment graveyard.
  if (selfIdentified && userRows.length === 0) {
    const removable = legacyRows.every((row) => isMap(row) && row.range !== undefined)
    if (!removable) return { ranges: [], blocked: true }
    return {
      ranges: [],
      blocked: false,
      replacement: block === null ? "[]\n" : content.slice(block.start, block.end),
    }
  }
  if (legacyRows.length === 0) return null

  const ranges: { start: number; end: number }[] = []
  let blocked = false
  for (const row of legacyRows) {
    if (!isMap(row) || row.range === undefined) {
      blocked = true
      continue
    }
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
  // Deleting every line leaves an empty document, which parses as `null`.
  if (next.trim() === "") return "[]\n"
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
  if (plan.replacement !== undefined) return plan.replacement
  return applyCleanupRanges(content, plan.ranges)
}

/** Whether the profile carries the current product composition block. */
function toolsCompositionCurrent(toolsPatch: string): boolean {
  if (!existsSync(toolsPatch)) return false
  try {
    const content = readFileSync(toolsPatch, "utf8")
    const block = productBlockSpan(content)
    return block !== null && content.slice(block.start, block.end) === TOOLS_PROFILE_BLOCK
  } catch {
    return false
  }
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

/** Recognise only the known base-backed product profile being replaced. */
function baseBackedToolsManifest(file: string) {
  if (!existsSync(file)) return undefined
  const manifest = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(manifest.dsh?.profile?.bundles) || !manifest.dsh.profile.bundles.includes("@deepseek-ai/dsh-base"))
    return undefined
  return manifest
}

/** Replace only the product-owned block; user bytes outside it stay verbatim. */
function standaloneToolsPatch(content: string): string {
  const begin = content.indexOf(TOOLS_PROFILE_BLOCK_BEGIN)
  const end = content.indexOf(TOOLS_PROFILE_BLOCK_END)
  if (begin !== -1 || end !== -1) {
    if (begin === -1 || end === -1 || end < begin) {
      throw new Error(
        "DSH tools profile composition markers are incomplete; restore both marker lines before preparation",
      )
    }
    const current = content.slice(begin, end + TOOLS_PROFILE_BLOCK_END.length)
    if (current === TOOLS_PROFILE_BLOCK) return content
    const next = content.slice(0, begin) + TOOLS_PROFILE_BLOCK + content.slice(end + TOOLS_PROFILE_BLOCK_END.length)
    const composed = parseDocument(next)
    if (composed.errors.length || !isSeq(composed.contents)) {
      throw new Error(
        "DSH tools profile patch is invalid after refreshing the product composition; preserve it and resolve the YAML conflict",
      )
    }
    return next
  }
  const document = parseDocument(content)
  if (document.errors.length || !isSeq(document.contents)) {
    throw new Error("DSH tools profile patch must be a valid top-level YAML array before standalone preparation")
  }
  const sequence = document.contents
  const tail =
    sequence.items.length === 0 && sequence.range
      ? content.slice(0, sequence.range[0]) + content.slice(sequence.range[1])
      : content
  const next = TOOLS_PROFILE_BLOCK + "\n" + tail
  const composed = parseDocument(next)
  if (composed.errors.length || !isSeq(composed.contents)) {
    throw new Error(
      "DSH tools profile patch cannot be combined with the standalone composition; preserve it and resolve the YAML conflict",
    )
  }
  return next
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
export function inspectDshProfileResources(
  wopalHome: string,
  profiles: readonly DshProfileName[] = ALL_PROFILE_NAMES,
): DshProfileResourceInspection {
  const paths = resourcePathsAtRoot(resolveDshLayout(wopalHome).dshHome)
  const web = profiles.includes(WEB_PROFILE_NAME)
  const tools = profiles.includes(TOOLS_PROFILE_NAME)
  const files = [
    ...(web ? [paths.webManifest, paths.webPatch, paths.webRoot, paths.webWorkspace] : []),
    ...(tools ? [paths.toolsManifest, paths.toolsPatch, paths.toolsRoot, paths.toolsWorkspace] : []),
  ]
  const missing = files.filter((file) => !existsSync(file))
  // A retired host-owned patch still needs its one-time cleanup before the
  // profile is ready; that state stays internal (no version-specific field).
  const needsToolsPatchCleanup = tools && needsLegacyToolsPatchCleanup(paths.toolsPatch)
  // The process only rewrites the block when it is actually stale, so a
  // matching composition is never re-assembled on an ordinary boot.
  const toolsCompositionDrifted = tools && !toolsCompositionCurrent(paths.toolsPatch)
  return {
    ready:
      missing.length === 0 &&
      !needsToolsPatchCleanup &&
      !toolsCompositionDrifted &&
      (!tools || !baseBackedToolsManifest(paths.toolsManifest)),
    missing,
  }
}

/**
 * Create only missing host-owned profile resources. The caller must hold the
 * exclusive Home qualification; existing manifests and patches are preserved.
 */
export function prepareDshProfileResources(
  wopalHome: string,
  runtime: DshRuntimeApi,
  profiles: readonly DshProfileName[] = ALL_PROFILE_NAMES,
): void {
  prepareDshProfileResourcesAtRoot(resolveDshLayout(wopalHome).dshHome, runtime, profiles)
}

/** Prepare an already-resolved DSH territory root (used by isolated activation tests). */
export function prepareDshProfileResourcesAtRoot(
  dshRoot: string,
  runtime: DshRuntimeApi,
  profiles: readonly DshProfileName[] = ALL_PROFILE_NAMES,
): void {
  const paths = resourcePathsAtRoot(dshRoot)
  const web = profiles.includes(WEB_PROFILE_NAME)
  const tools = profiles.includes(TOOLS_PROFILE_NAME)
  const baseManifest = tools ? baseBackedToolsManifest(paths.toolsManifest) : undefined

  // The official initializer creates missing declarations only; existing user
  // files (manifest, patch layer, pnpm settings) are never touched here.
  if (web) runtime.appBoot.initProfile(paths.web, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
  if (tools) runtime.appBoot.initProfile(paths.tools, [])

  // `cordis.yml` is the runtime's synthetic root anchor, not user config: the
  // loader writes the composed tree back after every mount, so preparation
  // always resets it or the next boot re-applies a stale composition.
  if (web) writeFileSync(paths.webRoot, "[]\n")
  if (tools) writeFileSync(paths.toolsRoot, "[]\n")

  // Remove only provably host-owned retired disables. User rows stay intact.
  if (tools && existsSync(paths.toolsPatch)) {
    const current = readFileSync(paths.toolsPatch, "utf8")
    const cleaned = cleanLegacyToolsPatch(current)
    if (cleaned !== null && cleaned !== current) writeFileSync(paths.toolsPatch, cleaned)
  }

  if (tools) {
    const current = readFileSync(paths.toolsPatch, "utf8")
    const next = standaloneToolsPatch(current)
    if (next !== current) writeFileSync(paths.toolsPatch, next)
    // Publish the manifest last. If interrupted, the unchanged base selection
    // causes preparation to retry without inserting the composition twice.
    if (baseManifest) {
      baseManifest.dsh.profile.bundles = baseManifest.dsh.profile.bundles.filter(
        (name: string) => name !== "@deepseek-ai/dsh-base",
      )
      writeFileSync(paths.toolsManifest, JSON.stringify(baseManifest, null, 2) + "\n")
    }
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
  if (profiles.length > 0) mkdirSync(join(paths.profileDir, "node_modules"), { recursive: true })
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
