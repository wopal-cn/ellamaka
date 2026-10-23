/**
 * One-command DSH upgrade (DESIGN-dsh-base.md §release-guidance).
 *
 *   bun run dsh:upgrade <version> [--dry-run]
 *
 * The command deliberately has no "do not bump" escape hatch: we cannot know
 * whether a new engine keeps the Home data format, so the safe side wins.
 *
 * Target generation is derived from the published generation frontier, never
 * from "current + 1". Re-running after a partial failure therefore converges
 * on the same number instead of inflating it.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compareSemVer } from "@wopal/ellamaka-release/identity"
import { DSH_CLOSURE_VERSION } from "../src/runtime/closure-version.ts"
import {
  HomeGenerationError,
  computeGuardedFingerprint,
  computePublishedFrontier,
  evaluateCurrentGeneration,
  type PublishedFrontier,
} from "../src/runtime/home-generation.ts"
import { parseDshRuntimeLock } from "../src/runtime/lockfile.ts"
import { buildDshRuntimeManifest, parseDshRuntimeManifest } from "../src/runtime/manifest.ts"
import { readCurrentInputs, readExactDshVersion, resolvePublishedFrontier } from "./check-dsh-home-generation.ts"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const defaultRepoRoot = resolve(packageRoot, "../..")

const PACKAGE_JSON = "packages/ellamaka-cordis/package.json"
const CLOSURE_VERSION_FILE = "packages/ellamaka-cordis/src/runtime/closure-version.ts"
const MANIFEST_FILE = "packages/ellamaka-cordis/generated/dsh-runtime-manifest.json"
const LOCK_FILE = "packages/ellamaka-cordis/generated/dsh-runtime-lock.json"
const MANIFEST_SCRIPT = "packages/ellamaka-cordis/script/generate-dsh-runtime-manifest.ts"
const LOCK_SCRIPT = "packages/ellamaka-cordis/script/generate-dsh-runtime-lock.ts"
const CHECK_SCRIPT = "packages/ellamaka-cordis/script/check-dsh-home-generation.ts"

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export type UpgradeMode = "noop" | "generation-only" | "full"

export type UpgradeStep =
  | "write-engine-version"
  | "write-generation"
  | "generate-manifest"
  | "generate-lock"
  | "install"
  | "check"
  | "test-tools"

const STEP_LABELS: Record<UpgradeStep, string> = {
  "write-engine-version": "写引擎版本号",
  "write-generation": "写数据目录代数",
  "generate-manifest": "生成引擎清单",
  "generate-lock": "生成完整依赖清单",
  install: "安装依赖",
  check: "代数检查",
  "test-tools": "工具测试",
}

const FULL_STEPS: UpgradeStep[] = [
  "write-engine-version",
  "write-generation",
  "generate-manifest",
  "generate-lock",
  "install",
  "check",
  "test-tools",
]

const GENERATION_ONLY_STEPS: UpgradeStep[] = [
  "write-generation",
  "generate-manifest",
  "generate-lock",
  "check",
  "test-tools",
]

const VERIFY_ONLY_STEPS: UpgradeStep[] = ["check", "test-tools"]

/** Bad user input (exit code 2), as opposed to a failed step (exit code 1). */
export class UpgradeArgumentError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = "UpgradeArgumentError"
  }
}

export interface UpgradePlan {
  mode: UpgradeMode
  currentVersion: string
  targetVersion: string
  currentGeneration: number
  targetGeneration: number
  frontierGeneration: number
  engineAlreadyPublished: boolean
  generationBumped: boolean
  steps: UpgradeStep[]
}

export interface PlanUpgradeInput {
  currentVersion: string
  targetVersion: string
  currentGeneration: number
  fingerprint: string
  frontier: PublishedFrontier
  /** Whether the committed manifest + lock already match the current sources. */
  manifestsConsistent: boolean
}

/** True when the generation check would reject this checkout. */
function isStale(frontier: PublishedFrontier, generation: number, fingerprint: string): boolean {
  try {
    evaluateCurrentGeneration({ frontier, generation, fingerprint })
    return false
  } catch (error) {
    if (error instanceof HomeGenerationError && error.code === "DSH_HOME_GENERATION_STALE") return true
    throw error
  }
}

/**
 * Decide what an upgrade invocation must do.
 *
 * - `noop`: the target is already pinned, the generation is not stale, and
 *   both generated manifests are current. This also applies at the bootstrap
 *   frontier, where no release has exposed an engine version yet.
 * - `generation-only`: same engine version, but Home inputs drifted.
 * - `full`: the target is newer, the generation is stale, or local generated
 *   artifacts need repair.
 */
export function planUpgrade(input: PlanUpgradeInput): UpgradePlan {
  const { currentVersion, targetVersion, currentGeneration, fingerprint, frontier, manifestsConsistent } = input

  if (!EXACT_VERSION_RE.test(targetVersion)) {
    throw new UpgradeArgumentError(`目标版本必须是精确版本（例如 0.2.0-rc.3），收到 ${JSON.stringify(targetVersion)}`)
  }
  if (compareSemVer(targetVersion, currentVersion) < 0) {
    throw new UpgradeArgumentError(`禁止降级：当前 ${currentVersion}，目标 ${targetVersion}`)
  }

  const versionChanges = targetVersion !== currentVersion
  const stale = isStale(frontier, currentGeneration, fingerprint)
  const needsBump = versionChanges || stale
  const targetGeneration = needsBump ? Math.max(currentGeneration, frontier.generation + 1) : currentGeneration

  const frontierEngine = frontier.releases.map((item) => item.engineVersion).find((value) => value !== "")
  const engineAlreadyPublished = frontierEngine !== undefined && targetVersion === frontierEngine

  let mode: UpgradeMode = "full"
  // At frontier 0 there is no published engine version to compare against.
  // The version and generation checks plus the local manifest check already
  // prove that this checkout needs no writes. Keep an engine ahead of a known
  // frontier on the full path: that is an upgrade still in flight, and its
  // failed install must be retried.
  const bootstrapNoop = frontier.generation === 0
  if (!versionChanges && !stale && manifestsConsistent && (engineAlreadyPublished || bootstrapNoop)) mode = "noop"
  else if (!versionChanges && engineAlreadyPublished) mode = "generation-only"

  return {
    mode,
    currentVersion,
    targetVersion,
    currentGeneration,
    targetGeneration,
    frontierGeneration: frontier.generation,
    engineAlreadyPublished,
    generationBumped: targetGeneration !== currentGeneration,
    steps:
      mode === "noop"
        ? VERIFY_ONLY_STEPS
        : mode === "generation-only"
          ? GENERATION_ONLY_STEPS
          : FULL_STEPS.filter((step) => step !== "write-generation" || targetGeneration !== currentGeneration),
  }
}

/** Merge exact `name@version` engine-closure exceptions into a bunfig copy. */
export function mergeMinimumReleaseAgeExcludes(bunfig: string, exemptions: readonly string[]): string {
  if (exemptions.length === 0) return bunfig

  const block = bunfig.match(/(minimumReleaseAgeExcludes\s*=\s*\[)([^\]]*)(\])/)
  if (block) {
    const existing = [...(block[2] ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1])
    const merged = [...new Set([...existing, ...exemptions])]
    const rebuilt = `\n${merged.map((value) => `  ${JSON.stringify(value)},\n`).join("")}`
    return bunfig.replace(block[0], `${block[1]}${rebuilt}${block[3]}`)
  }

  if (!/^\[install\]\s*$/m.test(bunfig)) {
    throw new Error("bunfig.toml 里没有 [install] 段，无法临时注入年龄限制例外")
  }
  const additions = `minimumReleaseAgeExcludes = [\n${exemptions.map((value) => `  ${JSON.stringify(value)},\n`).join("")}]`
  return bunfig.replace(/^\[install\]\s*$/m, (line) => `${line}\n${additions}`)
}

/** Exact `name@version` pairs for the engine closure carried by a runtime lock. */
export function exactEngineClosureExemptions(lockJson: string): string[] {
  const lock = parseDshRuntimeLock(lockJson)
  const pairs = new Set<string>()
  for (const path of Object.keys(lock.packages)) {
    const marker = path.lastIndexOf("node_modules/")
    if (marker === -1) continue
    const [first, second] = path.slice(marker + "node_modules/".length).split("/")
    if (!first) continue
    const name = first.startsWith("@") ? (second ? `${first}/${second}` : undefined) : first
    if (name === undefined) continue
    const version = lock.packages[path]?.version
    if (typeof version !== "string") continue
    pairs.add(`${name}@${version}`)
  }
  return [...pairs].sort()
}

export interface UpgradeDeps {
  plan: (targetVersion: string) => Promise<UpgradePlan>
  writeEngineVersion: (version: string) => void
  writeGeneration: (generation: number) => void
  generateManifest: () => void
  generateLock: () => void
  ageExemptions: () => readonly string[]
  install: (exemptions: readonly string[]) => void
  runCheck: () => void
  runToolTests: () => void
  log: (line: string) => void
}

function describe(plan: UpgradePlan): string[] {
  const modeLabel = plan.mode === "noop" ? "无需升级（只重跑校验）" : plan.mode === "full" ? "完整升级" : "只提升代数"
  return [
    `published frontier: ${plan.frontierGeneration}`,
    `引擎版本: ${plan.currentVersion} → ${plan.targetVersion}`,
    `数据目录代数: ${plan.currentGeneration} → ${plan.targetGeneration}`,
    `模式: ${modeLabel}`,
    `将执行: ${plan.steps.map((step) => STEP_LABELS[step]).join(" → ")}`,
  ]
}

export async function runUpgrade(argv: string[], deps: UpgradeDeps): Promise<number> {
  const dryRun = argv.includes("--dry-run")
  const positional = argv.filter((arg) => !arg.startsWith("--"))
  const unknownFlags = argv.filter((arg) => arg.startsWith("--") && arg !== "--dry-run")

  if (unknownFlags.length > 0) {
    deps.log(`错误: 未知参数 ${unknownFlags.join(", ")}；只支持 <版本> 和 --dry-run`)
    return 2
  }
  if (positional.length !== 1) {
    deps.log("错误: 用法 bun run dsh:upgrade <版本> [--dry-run]")
    return 2
  }

  const targetVersion = positional[0]
  let plan: UpgradePlan
  try {
    plan = await deps.plan(targetVersion)
  } catch (error) {
    if (error instanceof UpgradeArgumentError) {
      deps.log(`错误: ${error.message}`)
      return 2
    }
    deps.log(`错误: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  for (const line of describe(plan)) deps.log(line)

  if (dryRun) {
    deps.log("dry-run：不写文件、不装包、不跑测试")
    return 0
  }

  if (plan.mode !== "noop" && plan.generationBumped) {
    deps.log(`目标代数固定为 ${plan.targetGeneration}（published frontier + 1），重跑会得到同一个数`)
  }

  const completed: UpgradeStep[] = []
  for (const step of plan.steps) {
    try {
      switch (step) {
        case "write-engine-version":
          deps.writeEngineVersion(plan.targetVersion)
          break
        case "write-generation":
          deps.writeGeneration(plan.targetGeneration)
          break
        case "generate-manifest":
          deps.generateManifest()
          break
        case "generate-lock":
          deps.generateLock()
          break
        case "install":
          deps.install(deps.ageExemptions())
          break
        case "check":
          deps.runCheck()
          break
        case "test-tools":
          deps.runToolTests()
          break
      }
      completed.push(step)
    } catch (error) {
      deps.log(`失败: ${STEP_LABELS[step]}（${error instanceof Error ? error.message : String(error)}）`)
      deps.log(`已完成: ${completed.map((item) => STEP_LABELS[item]).join(" → ") || "无"}`)
      deps.log("两条安全出路：")
      deps.log(`  1) 直接重跑同一条命令：bun run dsh:upgrade ${targetVersion}（目标代数仍是 ${plan.targetGeneration}）`)
      deps.log(
        "  2) 检查后手动撤销本次升级改动：先保留已有工作（包括同一文件中的原有改动），再只撤销本次升级差异后重来。",
      )
      deps.log("     只读检查（在仓库根目录执行）：")
      deps.log(
        `     git diff -- ${[PACKAGE_JSON, CLOSURE_VERSION_FILE, MANIFEST_FILE, LOCK_FILE, "bun.lock"].join(" ")}`,
      )
      return 1
    }
  }

  if (plan.mode === "noop") deps.log("ok: 无需升级，已重跑代数检查与工具测试")
  else deps.log(`ok: DSH 已升级到 ${plan.targetVersion}，数据目录代数 ${plan.targetGeneration}`)
  return 0
}

function runBun(repoRoot: string, args: string[]): void {
  execFileSync("bun", args, { cwd: repoRoot, stdio: "inherit" })
}

export function writeEngineVersionFile(repoRoot: string, version: string): void {
  const path = join(repoRoot, PACKAGE_JSON)
  const text = readFileSync(path, "utf8")
  const updated = text.replace(/("@deepseek-ai\/dsh"\s*:\s*")[^"]*(")/, `$1${version}$2`)
  if (updated === text) throw new Error(`${PACKAGE_JSON} 里找不到 @deepseek-ai/dsh 依赖`)
  JSON.parse(updated)
  writeFileSync(path, updated)
}

export function writeGenerationFile(repoRoot: string, generation: number): void {
  const path = join(repoRoot, CLOSURE_VERSION_FILE)
  const text = readFileSync(path, "utf8")
  const updated = text.replace(/(DSH_CLOSURE_VERSION\s*=\s*)\d+/, `$1${generation}`)
  if (updated === text) throw new Error(`${CLOSURE_VERSION_FILE} 里找不到 DSH_CLOSURE_VERSION`)
  writeFileSync(path, updated)
}

/** Local, network-free drift check for the two generated files. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readDependencies(repoRoot: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, PACKAGE_JSON), "utf8"))
  if (!isRecord(parsed) || !isRecord(parsed["dependencies"])) return {}
  const dependencies: Record<string, string> = {}
  for (const [name, version] of Object.entries(parsed["dependencies"])) {
    if (typeof version === "string") dependencies[name] = version
  }
  return dependencies
}

function manifestsConsistent(repoRoot: string): boolean {
  try {
    const fresh = buildDshRuntimeManifest({ dependencies: readDependencies(repoRoot) })
    const committed = parseDshRuntimeManifest(readFileSync(join(repoRoot, MANIFEST_FILE), "utf8"))
    const lock = parseDshRuntimeLock(readFileSync(join(repoRoot, LOCK_FILE), "utf8"))
    return committed.fingerprint === fresh.fingerprint && lock.manifestFingerprint === fresh.fingerprint
  } catch {
    return false
  }
}

function installWithExemptions(repoRoot: string, exemptions: readonly string[]): void {
  if (exemptions.length === 0) {
    runBun(repoRoot, ["install"])
    return
  }
  const bunfig = readFileSync(join(repoRoot, "bunfig.toml"), "utf8")
  const merged = mergeMinimumReleaseAgeExcludes(bunfig, exemptions)
  const dir = mkdtempSync(join(tmpdir(), "ellamaka-dsh-upgrade-"))
  try {
    const configPath = join(dir, "bunfig.toml")
    writeFileSync(configPath, merged)
    runBun(repoRoot, ["install", "--config", configPath])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function realDeps(repoRoot: string): UpgradeDeps {
  return {
    plan: async (targetVersion) => {
      const { committed } = await resolvePublishedFrontier(repoRoot)
      const frontier = computePublishedFrontier(committed)
      const currentVersion = readExactDshVersion(repoRoot)
      const fingerprint = computeGuardedFingerprint({
        dshVersion: currentVersion,
        inputs: readCurrentInputs(repoRoot),
      })
      return planUpgrade({
        currentVersion,
        targetVersion,
        currentGeneration: DSH_CLOSURE_VERSION,
        fingerprint,
        frontier,
        manifestsConsistent: manifestsConsistent(repoRoot),
      })
    },
    writeEngineVersion: (version) => writeEngineVersionFile(repoRoot, version),
    writeGeneration: (generation) => writeGenerationFile(repoRoot, generation),
    generateManifest: () => runBun(repoRoot, [MANIFEST_SCRIPT]),
    generateLock: () => runBun(repoRoot, [LOCK_SCRIPT]),
    ageExemptions: () => {
      try {
        return exactEngineClosureExemptions(readFileSync(join(repoRoot, LOCK_FILE), "utf8"))
      } catch {
        return []
      }
    },
    install: (exemptions) => installWithExemptions(repoRoot, exemptions),
    runCheck: () => runBun(repoRoot, [CHECK_SCRIPT]),
    runToolTests: () => runBun(repoRoot, ["run", "--cwd", "packages/ellamaka-cordis", "test:tools"]),
    log: (line) => process.stdout.write(`${line}\n`),
  }
}

if (import.meta.main) {
  const repoRoot = process.env["ELLAMAKA_REPO_ROOT"] ?? defaultRepoRoot
  const code = await runUpgrade(process.argv.slice(2), realDeps(repoRoot))
  process.exit(code)
}
