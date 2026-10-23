/**
 * Verify that this checkout's DSH Home generation is consistent with the
 * published generation frontier (DESIGN-dsh-base.md §release-boundary).
 *
 *   bun packages/ellamaka-cordis/script/check-dsh-home-generation.ts
 *
 * Read-only: it never writes a file.
 *
 * A release counts as "committed" only when all of the following hold:
 *   - a namespaced tag `ellamaka-{cli,desktop}-v<version>` exists,
 *   - the versioned immutable R2 manifest exists (HTTP 200),
 *   - the manifest's ReleaseIdentity parses, its product/version match the tag,
 *     and its build.sourceTag / build.gitCommit match the tag and its commit.
 *
 * Tags without a manifest are failed attempts and are ignored. Unreadable
 * manifests, unreachable history, or a broken identity fail closed.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PRODUCTS } from "@wopal/ellamaka-release/cleanup/products"
import {
  parseNamespacedTag,
  parseReleaseIdentity,
  parseReleaseVersion,
  type ReleaseChannel,
} from "@wopal/ellamaka-release/identity"
import { DSH_CLOSURE_VERSION } from "../src/runtime/closure-version.ts"
import {
  ABSENT_INPUT,
  DSH_HOME_GENERATION_INPUTS,
  HomeGenerationError,
  computeGuardedFingerprint,
  computePublishedFrontier,
  evaluateCurrentGeneration,
  parseClosureGeneration,
  type CommittedRelease,
} from "../src/runtime/home-generation.ts"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const defaultRepoRoot = resolve(packageRoot, "../..")

/** Same CDN root as scripts/lib/release.sh:manifest_url and ellamaka-release inventory. */
const RELEASE_CDN_BASE = "https://download.coursedao.com"

const PACKAGE_JSON = "packages/ellamaka-cordis/package.json"
const CLOSURE_VERSION_FILE = "packages/ellamaka-cordis/src/runtime/closure-version.ts"

function fail(code: string, message: string): never {
  throw new HomeGenerationError(code, message)
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/** Read a file at a tag; `null` when the path did not exist in that release. */
export function readAtTag(repoRoot: string, tag: string, path: string): string | null {
  if (git(repoRoot, ["ls-tree", "-z", tag, "--", path]) === "") return null
  return git(repoRoot, ["show", `${tag}:${path}`])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactDshVersion(raw: string, where: string): string {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed)) fail("DSH_HOME_GENERATION_INVALID", `${where} 不是 JSON 对象`)
  const dependencies = parsed["dependencies"]
  if (!isRecord(dependencies)) fail("DSH_HOME_GENERATION_INVALID", `${where} 缺少 dependencies`)
  const version = dependencies["@deepseek-ai/dsh"]
  if (typeof version !== "string" || version.length === 0) {
    fail("DSH_HOME_GENERATION_INVALID", `${where} 没有声明 @deepseek-ai/dsh 依赖`)
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail("DSH_HOME_GENERATION_INVALID", `${where} 的 @deepseek-ai/dsh 必须是精确版本，实际为 ${version}`)
  }
  return version
}

async function fetchManifest(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { redirect: "follow" })
  } catch (error) {
    throw new HomeGenerationError(
      "DSH_HOME_GENERATION_ORACLE_UNAVAILABLE",
      `无法读取 release manifest ${url}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (response.status === 404) return null
  if (response.status !== 200) {
    fail(
      "DSH_HOME_GENERATION_ORACLE_UNAVAILABLE",
      `release manifest ${url} 返回 HTTP ${response.status}，无法判断该 tag 是否为已提交 release`,
    )
  }
  const body = await response.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new HomeGenerationError("DSH_HOME_GENERATION_ORACLE_UNAVAILABLE", `release manifest ${url} 不是合法 JSON`)
  }
}

interface ReleaseCandidates {
  committed: CommittedRelease[]
  failedAttempts: string[]
}

async function collectCommittedReleases(repoRoot: string): Promise<ReleaseCandidates> {
  const tags = git(repoRoot, ["tag", "-l", "ellamaka-cli-v*", "ellamaka-desktop-v*"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()

  const committed: CommittedRelease[] = []
  const failedAttempts: string[] = []

  for (const tag of tags) {
    const parsed = parseNamespacedTag(tag)
    const product = parsed.product
    const commit = git(repoRoot, ["rev-list", "-n", "1", tag]).trim()
    const channel: ReleaseChannel = parseReleaseVersion(parsed.version).channel
    const url = `${RELEASE_CDN_BASE}/${PRODUCTS[product].pathForVersion(parsed.version, channel)}/manifest.json`

    const manifest = await fetchManifest(url)
    if (manifest === null) {
      failedAttempts.push(tag)
      continue
    }

    if (!isRecord(manifest)) {
      fail("DSH_HOME_GENERATION_ORACLE_UNAVAILABLE", `${tag} 的 manifest 不是 JSON 对象`)
    }
    const record = manifest
    if (record.version !== parsed.version) {
      fail("DSH_HOME_GENERATION_ORACLE_UNAVAILABLE", `${tag} 的 manifest 版本 ${String(record.version)} 与 tag 不一致`)
    }
    if (record.releaseIdentity === undefined) {
      fail("DSH_HOME_GENERATION_ORACLE_UNAVAILABLE", `${tag} 的 manifest 缺少 releaseIdentity，无法确认来源`)
    }

    let identity
    try {
      identity = parseReleaseIdentity(record.releaseIdentity)
    } catch (error) {
      fail(
        "DSH_HOME_GENERATION_ORACLE_UNAVAILABLE",
        `${tag} 的 ReleaseIdentity 不合法: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (identity.kind !== "release") {
      fail("DSH_HOME_GENERATION_ORACLE_UNAVAILABLE", `${tag} 的 ReleaseIdentity 不是 release 记录`)
    }
    if (identity.product !== product) {
      fail(
        "DSH_HOME_GENERATION_ORACLE_UNAVAILABLE",
        `${tag} 的 ReleaseIdentity 产品是 ${identity.product}，与 tag 不一致`,
      )
    }
    if (identity.version !== parsed.version) {
      fail("DSH_HOME_GENERATION_ORACLE_UNAVAILABLE", `${tag} 的 ReleaseIdentity 版本与 tag 不一致`)
    }
    if (identity.build.sourceTag !== tag) {
      fail(
        "DSH_HOME_GENERATION_ORACLE_UNAVAILABLE",
        `${tag} 的 ReleaseIdentity sourceTag 是 ${identity.build.sourceTag}，与 tag 不一致`,
      )
    }
    if (identity.build.gitCommit !== commit) {
      fail(
        "DSH_HOME_GENERATION_ORACLE_UNAVAILABLE",
        `${tag} 的 ReleaseIdentity gitCommit ${identity.build.gitCommit} 与 tag 指向的 commit ${commit} 不一致`,
      )
    }

    const closureSource = readAtTag(repoRoot, tag, CLOSURE_VERSION_FILE)
    const generation = closureSource === null ? 0 : parseClosureGeneration(closureSource)
    if (generation === null) {
      fail(
        "DSH_HOME_GENERATION_INVALID",
        `${tag}:${CLOSURE_VERSION_FILE} 存在但没有可解析的 DSH_CLOSURE_VERSION；只有历史文件不存在才是 generation 0`,
      )
    }
    if (generation === 0) {
      // A release that predates the compatibility constant has no DSH Home
      // contract at all; its fingerprint is never compared (see
      // computePublishedFrontier), so record a stable placeholder.
      committed.push({ product, tag, commit, generation, fingerprint: "generation-0", engineVersion: "" })
      continue
    }
    const pkgSource = readAtTag(repoRoot, tag, PACKAGE_JSON)
    if (pkgSource === null) {
      fail("DSH_HOME_GENERATION_ORACLE_UNAVAILABLE", `${tag} 声明了代数 ${generation} 却缺少 ${PACKAGE_JSON}`)
    }
    const dshVersion = exactDshVersion(pkgSource, `${tag}:${PACKAGE_JSON}`)

    const inputs: Record<string, string> = {}
    for (const path of DSH_HOME_GENERATION_INPUTS) {
      inputs[path] = readAtTag(repoRoot, tag, path) ?? ABSENT_INPUT
    }

    committed.push({
      product,
      tag,
      commit,
      generation,
      fingerprint: computeGuardedFingerprint({ dshVersion, inputs }),
      engineVersion: dshVersion,
    })
  }

  return { committed, failedAttempts }
}

export function readCurrentInputs(repoRoot: string): Record<string, string> {
  const inputs: Record<string, string> = {}
  for (const path of DSH_HOME_GENERATION_INPUTS) {
    try {
      inputs[path] = readFileSync(join(repoRoot, path), "utf8")
    } catch {
      fail(
        "DSH_HOME_GENERATION_INPUT_MISSING",
        `当前 generation input 缺失：${path}（DSH_HOME_GENERATION_INPUTS 与实际代码不一致）`,
      )
    }
  }
  return inputs
}

export function readExactDshVersion(repoRoot: string): string {
  return exactDshVersion(readFileSync(join(repoRoot, PACKAGE_JSON), "utf8"), PACKAGE_JSON)
}

/** Resolve the published generation frontier for a checkout. */
export async function resolvePublishedFrontier(repoRoot: string): Promise<ReleaseCandidates> {
  return collectCommittedReleases(repoRoot)
}

async function main(): Promise<void> {
  const repoRoot = process.env["ELLAMAKA_REPO_ROOT"] ?? defaultRepoRoot
  const { committed, failedAttempts } = await collectCommittedReleases(repoRoot)

  const frontier = computePublishedFrontier(committed)
  const fingerprint = computeGuardedFingerprint({
    dshVersion: readExactDshVersion(repoRoot),
    inputs: readCurrentInputs(repoRoot),
  })
  const verdict = evaluateCurrentGeneration({
    frontier,
    generation: DSH_CLOSURE_VERSION,
    fingerprint,
  })

  process.stdout.write(
    `已确认 ${committed.length} 个已提交 release（忽略 ${failedAttempts.length} 个无 manifest 的 failed attempt tag），published frontier = ${frontier.generation}\n`,
  )

  switch (verdict.status) {
    case "aligned":
      process.stdout.write("ok: DSH Home generation 与 published frontier 一致\n")
      break
    case "bumped":
      process.stdout.write(`ok: DSH Home generation 已从 ${verdict.frontier} 提升到 ${verdict.generation}\n`)
      break
    case "bootstrap":
      process.stdout.write(
        `ok: 暂无已提交的代际基准（published frontier = 0），当前 DSH Home generation ${verdict.generation} 作为起点\n`,
      )
      break
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    if (error instanceof HomeGenerationError) {
      process.stderr.write(`error: ${error.message}\n`)
      process.exit(1)
    }
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
