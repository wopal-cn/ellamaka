import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DshRuntimeApi } from "./loader.js"
import { resolveDshLayout } from "./status.js"

/** Host-owned DSH profile resources and narrowly-scoped migrations. */

export const WEB_PROFILE_NAME = "web"
export const TOOLS_PROFILE_NAME = "ellamaka-tools"

/**
 * Default patch layer for the `ellamaka-tools` profile. Written on first
 * mount (never afterwards — user edits win), so the disable list lives in the
 * user-owned profile file, not in code.
 *
 * The tool container is a pure tool backend: the dsh-adapter drives its tools
 * with a lightweight per-call context (no live dsh sessions, no agent loops).
 * The rows below are agent-loop infrastructure — they need live sessions or
 * serve the dsh chat surface — and are disabled so the container stays
 * session-free and its tool surface stays clean. Re-enable a row only when
 * adopting the corresponding capability together with its full runtime
 * context.
 *
 * `approval` is intentionally NOT disabled: dsh's sandbox escalation
 * (`sandbox_permissions`) resolves its one-shot approval through the native
 * ApprovalService. The adapter's per-call facade satisfies the plugin's
 * runtime preconditions (open turn via turn/start..turn/end, appendable
 * events for the approval/asked + approval/decided audit pair), and the
 * adapter registers the `approval/request` answerer that bridges the ask to
 * ellamaka Permission. An absent answerer still fails closed
 * (`unavailable`), and a `never` escalation policy rejects in-service.
 */
export const TOOLS_PROFILE_PATCH = `# Patch layer for the ellamaka tool-container profile.
#
# The tool container is a pure tool backend: the dsh-adapter drives its tools
# with a lightweight per-call context (no live dsh sessions, no agent loops).
# The rows below are agent-loop infrastructure — they need live sessions or
# serve the dsh chat surface — and are disabled so the container stays
# session-free and its tool surface stays clean. Re-enable a row only when
# adopting the corresponding capability together with its full runtime
# context.
#
# \`approval\` is intentionally NOT disabled: dsh's sandbox escalation
# (\`sandbox_permissions\`) resolves its one-shot approval through the native
# ApprovalService. The adapter's per-call facade satisfies the plugin's
# runtime preconditions (open turn via turn/start..turn/end, appendable
# events for the approval/asked + approval/decided audit pair), and the
# adapter registers the \`approval/request\` answerer that bridges the ask to
# ellamaka Permission. An absent answerer still fails closed
# (\`unavailable\`), and a \`never\` escalation policy rejects in-service.

# --- session & agent-loop core ---
# Session lifecycle belongs to ellamaka; the container must stay session-free.
- { id: session, disabled: true }
# Flushes the calling agent's live session before every tool call; the
# adapter's per-call context has no live session, so this would throw.
- { id: session-checkpoint-policy, disabled: true }
- { id: agent, disabled: true }
# rc.1 base row: the DeepSeek plugin inventory publishes against the agents
# surface; the tool container carries none.
- { id: plugin-package-inventory-deepseek, disabled: true }
- { id: agent-loop, disabled: true }
- { id: agent-default-model, disabled: true }
- { id: agent-instructions, disabled: true }

# --- session persistence / query / projection / telemetry ---
- { id: session-title, disabled: true }
- { id: session-title-llm, disabled: true }
- { id: session-persistence-jsonl, disabled: true }
# rc.1 base row: the DeepSeek-native session log stream needs live sessions.
- { id: session-log-deepseek, disabled: true }
- { id: session-query-sqlite, disabled: true }
# \`session-projection\` stays ENABLED (it is the provider of the
# \`sessionProjections\` service, not a session consumer): rc.1 made the
# sandbox policy session-aware (\`sandboxMode\` is a projection), so the
# whole sandbox chain hangs off that service. The registry stays empty
# without session event streams, and \`stateOf\` falls back to the
# deployment default mode — exactly the tool container's semantics.
- { id: session-projection-cache, disabled: true }
- { id: session-telemetry-otel, disabled: true }

# --- llm runtime & credentials (no model calls in the tool container) ---
- { id: llm, disabled: true }
- { id: llm-retry, disabled: true }
- { id: llm-deepseek, disabled: true }
# rc.1 base row: DeepSeek LLM API extensions belong to the llm face.
- { id: deepseek-llm-api-extensions, disabled: true }
- { id: llm-pi-ai, disabled: true }
- { id: settings, disabled: true }
- { id: credentials, disabled: true }

# --- api gateway (typert) ---
- { id: typert, disabled: true }
- { id: typert-loader, disabled: true }
- { id: typert-gateway, disabled: true }

# --- interactive surface (questions, permission presets) ---
# 'approval' is ENABLED (not listed below): dsh's native escalation
# choreography (approveEscalation) resolves 'sandbox_permissions' asks
# through it. The per-call facade carries the open turn
# (turn/start..turn/end from the adapter) and the audit-pair sink
# (session.append), and the host bridges 'approval/request' to ellamaka
# Permission — a rejected/missing answerer fails closed.
- { id: user-questions, disabled: true }
- { id: permission, disabled: true }

# --- subagent delegation (agent-loop stack; ellamaka has native subagents) ---
- { id: subagent, disabled: true }
- { id: subagent-spawn-in-process, disabled: true }
- { id: subagent-fork-in-process, disabled: true }
- { id: tool-subagent, disabled: true }
- { id: tool-subagent-fork, disabled: true }
- { id: tool-subagent-control, disabled: true }
- { id: tool-subagent-list-agents, disabled: true }
- { id: workflow-worker-thread, disabled: true }
- { id: tool-workflow, disabled: true }
- { id: tool-ralph, disabled: true }

# --- background jobs ---
- { id: jobs, disabled: true }
- { id: tool-jobs, disabled: true }

# --- goals / plan mode / commands / skills ---
- { id: goal, disabled: true }
- { id: goal-round-driver, disabled: true }
- { id: tool-goal, disabled: true }
- { id: command-goal, disabled: true }
- { id: plan-mode, disabled: true }
- { id: commands, disabled: true }
- { id: command-feedback, disabled: true }
- { id: command-compact, disabled: true }
- { id: skill, disabled: true }
- { id: skill-filesystem, disabled: true }
- { id: tool-skill, disabled: true }

# --- compaction / token accounting ---
- { id: compaction-basic, disabled: true }
- { id: token-meter, disabled: true }
- { id: tool-result-pruner, disabled: true }

# --- web search (needs llm + credentials) ---
- { id: web, disabled: true }
- { id: web-search-deepseek, disabled: true }
# rc.1 base row: the http fetcher is the 'web' service provider; disabled
# with the rest of the web face.
- { id: web-fetch-http, disabled: true }
- { id: tool-web, disabled: true }

# --- attachments / todo / reminders (agent-loop UX) ---
- { id: attachment-local, disabled: true }
- { id: tool-todo, disabled: true }
- { id: repeat-tool-reminder, disabled: true }
`

/** The official empty home-level patch layer (dsh PROFILE_PATCH_TEMPLATE). */
export const OFFICIAL_HOME_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

// Revision 1 migration: older host-seeded tool profiles disabled approval.
// The profile patch is otherwise user-owned and must never be overwritten, so
// migrate only this exact obsolete host row and preserve every other byte.
const LEGACY_APPROVAL_DISABLED_ROW = "- { id: approval, disabled: true }"

export function migrateToolsProfileApprovalPatch(content: string): string {
  const lines = content.split("\n")
  const next = lines.filter((line) => line.trim() !== LEGACY_APPROVAL_DISABLED_ROW)
  return next.length === lines.length ? content : next.join("\n")
}

// Revision 2 migration (rc.1): the sandbox chain became session-aware —
// `dsh-sandbox-policy` now injects the `sessionProjections` service, so the
// tool container must enable the `session-projection` provider (the registry
// stays empty with no session stream and `stateOf` falls back to the
// deployment default mode). User profiles seeded by the rc.2-era host row
// disabled it, and rc.1 added session/agent-face base rows that must stay
// disabled here. Like revision 1: migrate only these exact host-owned rows,
// preserve every other byte, and never overwrite a user-owned patch.
const LEGACY_SESSION_PROJECTION_DISABLED_ROW = "- { id: session-projection, disabled: true }"
const RC1_TOOLS_DISABLED_ROWS = [
  "- { id: session-log-deepseek, disabled: true }",
  "- { id: plugin-package-inventory-deepseek, disabled: true }",
  "- { id: session-projection-cache, disabled: true }",
  "- { id: web-fetch-http, disabled: true }",
  "- { id: deepseek-llm-api-extensions, disabled: true }",
]

export function migrateToolsProfileRc1Patch(content: string): string {
  let lines = content.split("\n")
  let changed = false
  const withoutLegacy = lines.filter((line) => line.trim() !== LEGACY_SESSION_PROJECTION_DISABLED_ROW)
  if (withoutLegacy.length !== lines.length) {
    lines = withoutLegacy
    changed = true
  }
  for (const row of RC1_TOOLS_DISABLED_ROWS) {
    if (!lines.some((line) => line.trim() === row)) {
      lines.push(row)
      changed = true
    }
  }
  return changed ? lines.join("\n") : content
}

export interface DshProfileResourceInspection {
  readonly ready: boolean
  readonly missing: readonly string[]
  readonly needsToolsMigration: boolean
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
  let needsToolsMigration = false
  if (existsSync(paths.toolsPatch)) {
    try {
      const current = readFileSync(paths.toolsPatch, "utf8")
      needsToolsMigration = migrateToolsProfileRc1Patch(migrateToolsProfileApprovalPatch(current)) !== current
    } catch {
      // A present but unreadable user patch is an activation error, not a
      // preparation invitation to replace user-owned content.
      needsToolsMigration = false
    }
  }
  return { ready: missing.length === 0 && !needsToolsMigration, missing, needsToolsMigration }
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
  const toolsPatchWasMissing = !existsSync(paths.toolsPatch)

  runtime.appBoot.initProfile(paths.web, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])
  runtime.appBoot.initProfile(paths.tools, runtime.appBoot.DEFAULT_PROFILE_BUNDLES)

  if (!existsSync(paths.webRoot)) writeFileSync(paths.webRoot, "[]\n")
  if (!existsSync(paths.toolsRoot)) writeFileSync(paths.toolsRoot, "[]\n")

  if (toolsPatchWasMissing) {
    writeFileSync(paths.toolsPatch, TOOLS_PROFILE_PATCH)
  } else {
    const current = readFileSync(paths.toolsPatch, "utf8")
    const migrated = migrateToolsProfileRc1Patch(migrateToolsProfileApprovalPatch(current))
    if (migrated !== current) writeFileSync(paths.toolsPatch, migrated)
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
