import { createHash } from "node:crypto"

/**
 * Product-owned DSH Home generation contract (DESIGN-dsh-base.md
 * §release-boundary / §runtime-ownership).
 *
 * Two facts decide whether the persisted DSH home must move to the next
 * generation:
 *
 * 1. the exact pinned engine version, and
 * 2. the content of every product source file that can change what we write
 *    into `$WOPAL_HOME/dsh/home` — directly (fs writer) or indirectly (a
 *    payload rendered into a Home file).
 *
 * The published "generation frontier" is the highest generation that already
 * reached users through a committed CLI/Desktop release. A checkout whose
 * guarded fingerprint differs from the frontier must carry a strictly larger
 * generation; otherwise an old build could open newer Home data and corrupt
 * it silently.
 *
 * This module is pure data + pure functions. Git/R2/network access lives in
 * `script/check-dsh-home-generation.ts` so the contract stays unit-testable.
 */

/** Schema tag mixed into the guarded fingerprint. */
export const DSH_HOME_GENERATION_SCHEMA = "ellamaka.dsh-home-generation/v1"

/**
 * Fingerprint marker for an input path that did not exist in a historical
 * release. A missing historical path is normal (the input was added later);
 * a missing path in the current checkout is a broken contract.
 */
export const ABSENT_INPUT = "absent"

/**
 * Product sources whose content can change `$WOPAL_HOME/dsh/home`.
 *
 * `closure-version.ts` is deliberately absent: the generation itself must not
 * be part of the fingerprint, or bumping the generation would change the
 * fingerprint and demand yet another bump.
 *
 * Paths are repository-relative so the same list can be projected onto any
 * historical tag.
 */
export const DSH_HOME_GENERATION_INPUTS: readonly string[] = [
  // Home layout + state metadata (state/current.json, managed marker, backups).
  "packages/ellamaka-cordis/src/runtime/home-guard.ts",
  // Profile scaffolding written into home/profiles/<profile>.
  "packages/ellamaka-cordis/src/runtime/profile-resources.ts",
  // Indirect payload: the tools profile rows rendered into the profile patch layer.
  "packages/ellamaka-cordis/src/runtime/tools-profile.ts",
  // Root include reset before every mount (home/profiles/<profile>/cordis.yml).
  "packages/ellamaka-cordis/src/dsh-web.ts",
  // Same root include reset on the diagnostics path.
  "packages/ellamaka-cordis/src/diagnostics/dump-config.ts",
  // Profile manifest written into the profile directory.
  "packages/ellamaka-cordis/src/plugins/profile-manifest.ts",
  // Composed node_modules links inside the profile directory.
  "packages/ellamaka-cordis/src/plugins/compose.ts",
  // Package resolution links inside the profile directory.
  "packages/ellamaka-cordis/src/plugins/profile-resolution.ts",
  // User-facing patch layer edits persisted inside the profile directory.
  "packages/ellamaka-cordis/src/plugins/patch-layer.ts",
  // Legacy plugin store migration inside the DSH territory.
  "packages/ellamaka-cordis/src/plugins/migrate-store.ts",
]

/**
 * Production files that call a mutating `fs` API but cannot change persisted
 * Home content. Every entry needs a reason; the AST drift gate rejects
 * unregistered mutation call sites.
 */
export const DSH_FS_MUTATION_EXEMPTIONS: Readonly<Record<string, string>> = {
  "packages/ellamaka-cordis/src/runtime/lock.ts":
    "generic materialisation mutex; the caller owns the path and the lock directory is transient",
  "packages/ellamaka-cordis/src/runtime/home-lock.ts":
    "transient shared/exclusive lock directories inside the DSH territory; created and removed around one operation, never part of persisted Home data",
  "packages/ellamaka-cordis/src/runtime/materializer.ts":
    "writes immutable closure directories under dsh/closures and staging, not the DSH home",
  "packages/ellamaka-cordis/src/runtime/log.ts": "writes rotated runtime log files, not DSH home content",
  "packages/ellamaka-cordis/src/runtime/web-child.ts": "writes a best-effort /tmp trace log for the web child process",
}

/** `fs` APIs that never mutate the filesystem. */
export const FS_READ_ONLY_APIS: ReadonlySet<string> = new Set([
  "access",
  "accessSync",
  "createReadStream",
  "existsSync",
  "fstatSync",
  "lstat",
  "lstatSync",
  "opendir",
  "opendirSync",
  "readFile",
  "readFileSync",
  "readSync",
  "readdir",
  "readdirSync",
  "readlink",
  "readlinkSync",
  "realpath",
  "realpathSync",
  "stat",
  "statSync",
  "watch",
  "watchFile",
])

/** `fs` APIs that mutate the filesystem and therefore need classification. */
export const FS_MUTATION_APIS: ReadonlySet<string> = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "closeSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "ftruncate",
  "ftruncateSync",
  "fsync",
  "fsyncSync",
  "futimes",
  "futimesSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "link",
  "linkSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
  "writev",
  "writevSync",
])

/** Stable, order-independent JSON used for hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
}

export interface GuardedFingerprintInput {
  /** Exact pinned `@deepseek-ai/dsh` version. */
  dshVersion: string
  /** Repository-relative generation input path → file content (or `absent`). */
  inputs: Readonly<Record<string, string>>
}

/** `sha256:<hex>` over the pinned engine version and every generation input. */
export function computeGuardedFingerprint(input: GuardedFingerprintInput): string {
  const payload = {
    schema: DSH_HOME_GENERATION_SCHEMA,
    dshVersion: input.dshVersion,
    inputs: input.inputs,
  }
  return `sha256:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`
}

export class HomeGenerationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HomeGenerationError"
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new HomeGenerationError(code, message)
}

export type DshProduct = "ellamaka-cli" | "ellamaka-desktop"

/** One release that provably reached users. */
export interface CommittedRelease {
  product: DshProduct
  /** Namespaced release tag, e.g. `ellamaka-cli-v2.0.9-rc.1`. */
  tag: string
  /** Full source commit the tag points at. */
  commit: string
  /** Generation declared by that release's source; 0 when it predates the constant. */
  generation: number
  fingerprint: string
  /** Exact `@deepseek-ai/dsh` version that release pinned; empty when it predates the DSH package. */
  engineVersion: string
}

export interface PublishedFrontier {
  generation: number
  /** Distinct fingerprints published at `generation`; empty at generation 0. */
  fingerprints: readonly string[]
  releases: readonly CommittedRelease[]
}

const CLOSURE_DECLARATION_RE = /(?:export\s+)?(?:const|let|var)\s+DSH_CLOSURE_VERSION(?!\w)/g
const CLOSURE_SOURCE_RE = new RegExp(
  `^\\s*(?:(?:\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\r\\n]*(?:\\r?\\n|$))\\s*)*` +
    `(?:export\\s+)?const\\s+DSH_CLOSURE_VERSION\\s*(?::\\s*number\\s*)?=\\s*(\\d+)\\s*;?` +
    `\\s*(?:(?:\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\r\\n]*(?:\\r?\\n|$))\\s*)*$`,
)

/**
 * Read the generation constant out of a `closure-version.ts` source text.
 * Returns `null` when the release predates the constant (generation 0), and
 * throws when the constant exists but is not a positive integer.
 */
export function parseClosureGeneration(source: string): number | null {
  const declarations = [...source.matchAll(CLOSURE_DECLARATION_RE)]
  if (declarations.length === 0) return null
  if (declarations.length !== 1) {
    fail("DSH_HOME_GENERATION_INVALID", "DSH_CLOSURE_VERSION 只能声明一次")
  }
  const match = source.match(CLOSURE_SOURCE_RE)
  if (!match) {
    fail("DSH_HOME_GENERATION_INVALID", "DSH_CLOSURE_VERSION 必须是单个十进制正整数常量")
  }
  const value = Number(match[1])
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("DSH_HOME_GENERATION_INVALID", `DSH_CLOSURE_VERSION 必须是正整数，实际为 ${match[1]}`)
  }
  return value
}

/**
 * Highest generation already published to users, plus the fingerprint(s)
 * published at that generation. Fails closed when nothing is confirmed and
 * when one positive generation was published with two different fingerprints.
 */
export function computePublishedFrontier(releases: readonly CommittedRelease[]): PublishedFrontier {
  if (releases.length === 0) {
    fail(
      "DSH_HOME_GENERATION_NO_BASELINE",
      "无法确认任何已提交的 CLI/Desktop release（缺少有效 immutable manifest 或 ReleaseIdentity 与 tag 不符），拒绝把「什么都不知道」当成代数 0",
    )
  }
  for (const item of releases) {
    if (!Number.isInteger(item.generation) || item.generation < 0) {
      fail("DSH_HOME_GENERATION_INVALID", `${item.tag} 的代数 ${String(item.generation)} 不是非负整数`)
    }
  }
  const generation = Math.max(...releases.map((item) => item.generation))
  const atFrontier = releases.filter((item) => item.generation === generation)
  const fingerprints = [...new Set(atFrontier.map((item) => item.fingerprint))]
  if (generation > 0 && fingerprints.length > 1) {
    fail(
      "DSH_HOME_GENERATION_CONFLICT",
      `代数 ${generation} 已发布出 ${fingerprints.length} 个不同的 guarded fingerprint：${atFrontier
        .map((item) => item.tag)
        .join(", ")}。同一代的 Home 内容必须一致，请先查明是哪次发布写错了`,
    )
  }
  return { generation, fingerprints, releases: atFrontier }
}

export type GenerationVerdict =
  | { status: "aligned"; frontier: number }
  | { status: "bumped"; frontier: number; generation: number }
  | { status: "bootstrap"; generation: number }

export interface CurrentGenerationInput {
  frontier: PublishedFrontier
  generation: number
  fingerprint: string
}

/**
 * Decide whether the checkout's generation is acceptable against the
 * published frontier.
 *
 * - frontier 0: nothing has been published yet, any positive generation boots.
 * - same fingerprint: the generation must not go backwards.
 * - different fingerprint: the generation must be strictly larger.
 */
export function evaluateCurrentGeneration(input: CurrentGenerationInput): GenerationVerdict {
  const { frontier, generation, fingerprint } = input
  if (!Number.isInteger(generation) || generation <= 0) {
    fail("DSH_HOME_GENERATION_INVALID", `当前 DSH_CLOSURE_VERSION 必须是正整数，实际为 ${String(generation)}`)
  }

  if (frontier.generation === 0) return { status: "bootstrap", generation }

  const published = frontier.fingerprints[0]
  if (published === undefined) {
    fail("DSH_HOME_GENERATION_CONFLICT", `代数 ${frontier.generation} 没有记录到 guarded fingerprint`)
  }

  if (fingerprint === published) {
    if (generation < frontier.generation) {
      fail(
        "DSH_HOME_GENERATION_STALE",
        `当前代数 ${generation} 低于已发布基准 ${frontier.generation}，回退代数会让老数据被当成新代使用`,
      )
    }
    return { status: "aligned", frontier: frontier.generation }
  }

  if (generation <= frontier.generation) {
    fail(
      "DSH_HOME_GENERATION_STALE",
      `引擎版本或 Home 产出源码已经变化，但代数仍是 ${generation}（已发布基准 ${frontier.generation}）。请运行 bun run dsh:upgrade <版本>`,
    )
  }
  return { status: "bumped", frontier: frontier.generation, generation }
}
