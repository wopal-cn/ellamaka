import { describe, expect, it } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  computeGuardedFingerprint,
  computePublishedFrontier,
  type PublishedFrontier,
} from "../src/runtime/home-generation.ts"
import {
  UpgradeArgumentError,
  exactEngineClosureExemptions,
  mergeMinimumReleaseAgeExcludes,
  planUpgrade,
  runUpgrade,
  type UpgradeDeps,
  type UpgradePlan,
  type UpgradeStep,
  writeEngineVersionFile,
  writeGenerationFile,
} from "./upgrade-dsh.ts"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const packageJsonPath = "packages/ellamaka-cordis/package.json"
const closureVersionPath = "packages/ellamaka-cordis/src/runtime/closure-version.ts"

const FRONTIER_VERSION = "0.2.0-rc.2"

function fingerprint(version: string, salt = ""): string {
  return computeGuardedFingerprint({ dshVersion: version, inputs: { "salt.ts": salt } })
}

function frontierOf(generation: number, version = FRONTIER_VERSION): PublishedFrontier {
  return computePublishedFrontier([
    {
      product: "ellamaka-cli",
      tag: "ellamaka-cli-v2.0.9-rc.1",
      commit: "0".repeat(40),
      generation,
      fingerprint: fingerprint(version),
      engineVersion: version,
    },
  ])
}

function plan(overrides: Partial<Parameters<typeof planUpgrade>[0]> = {}): UpgradePlan {
  return planUpgrade({
    currentVersion: FRONTIER_VERSION,
    targetVersion: FRONTIER_VERSION,
    currentGeneration: 3,
    fingerprint: fingerprint(FRONTIER_VERSION),
    frontier: frontierOf(3),
    manifestsConsistent: true,
    ...overrides,
  })
}

describe("planUpgrade", () => {
  it("rejects a non-exact version", () => {
    expect(() => plan({ targetVersion: "^0.2.0" })).toThrow(UpgradeArgumentError)
    expect(() => plan({ targetVersion: "latest" })).toThrow(UpgradeArgumentError)
  })

  it("rejects a downgrade", () => {
    expect(() => plan({ currentVersion: "0.2.0-rc.3", targetVersion: "0.2.0-rc.2" })).toThrow(UpgradeArgumentError)
  })

  it("is a no-op when nothing changed", () => {
    const result = plan()
    expect(result.mode).toBe("noop")
    expect(result.targetGeneration).toBe(3)
    expect(result.steps).toEqual(["check", "test-tools"])
  })

  it("is a no-op at the real bootstrap frontier without a published engine version", () => {
    const result = plan({ frontier: frontierOf(0, "") })
    expect(result.engineAlreadyPublished).toBe(false)
    expect(result.mode).toBe("noop")
    expect(result.targetGeneration).toBe(3)
    expect(result.steps).toEqual(["check", "test-tools"])
  })

  it("repairs manifest drift at the bootstrap frontier instead of skipping the pipeline", () => {
    const result = plan({ frontier: frontierOf(0, ""), manifestsConsistent: false })
    expect(result.mode).toBe("full")
    expect(result.targetGeneration).toBe(3)
    expect(result.steps).toEqual([
      "write-engine-version",
      "generate-manifest",
      "generate-lock",
      "install",
      "check",
      "test-tools",
    ])
  })

  it("still upgrades a newer engine at the bootstrap frontier", () => {
    const result = plan({ frontier: frontierOf(0, ""), targetVersion: "0.2.0-rc.3" })
    expect(result.mode).toBe("full")
    expect(result.steps).toContain("install")
  })

  it("bumps only the generation when Home inputs changed at the same engine version", () => {
    const result = plan({ fingerprint: fingerprint(FRONTIER_VERSION, "changed") })
    expect(result.mode).toBe("generation-only")
    expect(result.targetGeneration).toBe(4)
    expect(result.steps).toEqual(["write-generation", "generate-manifest", "generate-lock", "check", "test-tools"])
    expect(result.steps).not.toContain("install")
  })

  it("runs the full pipeline when the engine version moves forward", () => {
    const result = plan({ targetVersion: "0.2.0-rc.3" })
    expect(result.mode).toBe("full")
    expect(result.targetGeneration).toBe(4)
    expect(result.steps).toEqual([
      "write-engine-version",
      "write-generation",
      "generate-manifest",
      "generate-lock",
      "install",
      "check",
      "test-tools",
    ])
  })

  it("keeps the target generation stable once a failed attempt already wrote it", () => {
    const result = plan({
      currentVersion: "0.2.0-rc.3",
      currentGeneration: 4,
      fingerprint: fingerprint("0.2.0-rc.3"),
      targetVersion: "0.2.0-rc.3",
    })
    expect(result.targetGeneration).toBe(4)
    expect(result.mode).toBe("full")
  })

  it("does not lower a generation that is already ahead of the frontier", () => {
    const result = plan({ currentGeneration: 5, targetVersion: "0.2.0-rc.3" })
    expect(result.targetGeneration).toBe(5)
  })

  it("re-plans when the in-repo manifests drifted", () => {
    expect(plan({ manifestsConsistent: false }).mode).toBe("generation-only")
  })
})

interface Harness {
  deps: UpgradeDeps
  calls: UpgradeStep[]
  state: { version: string; generation: number; salt: string }
}

function harness(
  options: {
    salt?: string
    failAt?: UpgradeStep
    generation?: number
    frontier?: PublishedFrontier
    manifestsConsistent?: boolean
  } = {},
): Harness {
  const calls: UpgradeStep[] = []
  const state = {
    version: FRONTIER_VERSION,
    generation: options.generation ?? 3,
    salt: options.salt ?? "",
  }
  const frontier = options.frontier ?? frontierOf(3)
  const failAt = options.failAt

  const step = (name: UpgradeStep, run: () => void) => {
    calls.push(name)
    if (failAt === name) throw new Error(`injected failure at ${name}`)
    run()
  }

  const deps: UpgradeDeps = {
    plan: async (targetVersion) =>
      planUpgrade({
        currentVersion: state.version,
        targetVersion,
        currentGeneration: state.generation,
        fingerprint: fingerprint(state.version, state.salt),
        frontier,
        manifestsConsistent: options.manifestsConsistent ?? true,
      }),
    writeEngineVersion: (version) => step("write-engine-version", () => void (state.version = version)),
    writeGeneration: (generation) => step("write-generation", () => void (state.generation = generation)),
    generateManifest: () => step("generate-manifest", () => {}),
    generateLock: () => step("generate-lock", () => {}),
    ageExemptions: () => ["@deepseek-ai/dsh@0.2.0-rc.3"],
    install: () => step("install", () => {}),
    runCheck: () => step("check", () => {}),
    runToolTests: () => step("test-tools", () => {}),
    log: () => {},
  }
  return { deps, calls, state }
}

describe("runUpgrade", () => {
  it("rejects a missing or malformed target with exit code 2", async () => {
    const { deps, calls } = harness()
    expect(await runUpgrade([], deps)).toBe(2)
    expect(await runUpgrade(["latest"], deps)).toBe(2)
    expect(calls).toEqual([])
  })

  it("prints the plan and touches nothing in dry-run mode", async () => {
    const { deps, calls } = harness()
    expect(await runUpgrade(["0.2.0-rc.3", "--dry-run"], deps)).toBe(0)
    expect(calls).toEqual([])
  })

  it("only verifies when nothing changed", async () => {
    const { deps, calls } = harness()
    expect(await runUpgrade([FRONTIER_VERSION], deps)).toBe(0)
    expect(calls).toEqual(["check", "test-tools"])
  })

  it("only verifies at the bootstrap frontier when the same version and manifests are current", async () => {
    const { deps, calls } = harness({ frontier: frontierOf(0, "") })
    expect(await runUpgrade([FRONTIER_VERSION], deps)).toBe(0)
    expect(calls).toEqual(["check", "test-tools"])
  })

  it("replays the repair steps after a bootstrap upgrade failed with manifest drift", async () => {
    const options = { frontier: frontierOf(0, ""), manifestsConsistent: false }
    const first = harness({ ...options, failAt: "generate-lock" })
    expect(await runUpgrade(["0.2.0-rc.3"], first.deps)).toBe(1)

    const second = harness({ ...options, generation: first.state.generation })
    second.state.version = first.state.version
    expect(await runUpgrade(["0.2.0-rc.3"], second.deps)).toBe(0)
    expect(second.state.generation).toBe(first.state.generation)
    expect(second.calls).toEqual([
      "write-engine-version",
      "generate-manifest",
      "generate-lock",
      "install",
      "check",
      "test-tools",
    ])
  })

  it("runs the documented step order for a real upgrade", async () => {
    const { deps, calls } = harness()
    expect(await runUpgrade(["0.2.0-rc.3"], deps)).toBe(0)
    expect(calls).toEqual([
      "write-engine-version",
      "write-generation",
      "generate-manifest",
      "generate-lock",
      "install",
      "check",
      "test-tools",
    ])
  })

  const failureSteps = [
    ["write-engine-version", "写引擎版本号"],
    ["write-generation", "写数据目录代数"],
    ["generate-manifest", "生成引擎清单"],
    ["generate-lock", "生成完整依赖清单"],
    ["install", "安装依赖"],
    ["check", "代数检查"],
    ["test-tools", "工具测试"],
  ] as const

  it.each(failureSteps)("reports %s failure with safe retry and manual recovery guidance", async (failing, label) => {
    const { deps, calls } = harness({ failAt: failing })
    const logs: string[] = []
    deps.log = (line) => logs.push(line)

    expect(await runUpgrade(["0.2.0-rc.3"], deps)).toBe(1)

    const failedIndex = failureSteps.findIndex(([step]) => step === failing)
    expect(calls).toEqual(failureSteps.slice(0, failedIndex + 1).map(([step]) => step))
    expect(logs).toContain(`失败: ${label}（injected failure at ${failing}）`)
    const output = logs.join("\n")
    expect(output).not.toMatch(/\bgit\s+(?:checkout|restore|reset|clean)\b/)
    const completed = failureSteps.slice(0, failedIndex).map(([, stepLabel]) => stepLabel)
    expect(logs).toContain(`已完成: ${completed.join(" → ") || "无"}`)

    expect(output).toContain("两条安全出路")
    expect(output).toContain("1) 直接重跑同一条命令：bun run dsh:upgrade 0.2.0-rc.3（目标代数仍是 4）")
    expect(output).toContain("2) 检查后手动撤销本次升级改动")
    expect(output).toContain("先保留已有工作（包括同一文件中的原有改动）")
    expect(output).toContain("只撤销本次升级差异")
    expect(output).toContain("只读检查（在仓库根目录执行）")
    expect(logs.find((line) => line.trim().startsWith("git diff --"))?.trim()).toBe(
      "git diff -- packages/ellamaka-cordis/package.json packages/ellamaka-cordis/src/runtime/closure-version.ts packages/ellamaka-cordis/generated/dsh-runtime-manifest.json packages/ellamaka-cordis/generated/dsh-runtime-lock.json bun.lock",
    )
  })

  it.each(["generate-manifest", "generate-lock", "install", "test-tools"] as const)(
    "stops with exit code 1 when %s fails, and the next run keeps the same target generation",
    async (failing) => {
      const first = harness({ failAt: failing })
      expect(await runUpgrade(["0.2.0-rc.3"], first.deps)).toBe(1)

      const second = harness({ generation: first.state.generation })
      second.state.version = first.state.version
      second.state.salt = first.state.salt
      expect(await runUpgrade(["0.2.0-rc.3"], second.deps)).toBe(0)
      expect(second.state.generation).toBe(4)
    },
  )
})

describe("temporary release-age exemptions", () => {
  const lockJson = JSON.stringify({
    schema: "ellamaka.dsh-runtime-lock/v1",
    manifestFingerprint: "candidate",
    packages: {
      "node_modules/@deepseek-ai/dsh": { version: "0.2.0-rc.3" },
      "node_modules/@anthropic-ai/sdk": { version: "0.90.0" },
      "node_modules/chokidar": { version: "4.0.3" },
      "node_modules/@deepseek-ai/dsh/node_modules/chokidar": { version: "3.6.0" },
      "node_modules/parent/node_modules/chokidar": { version: "3.6.0" },
      "node_modules/parent": { version: "1.0.0" },
      "node_modules/parent/node_modules/@opentelemetry/api": { version: "1.9.0" },
      "node_modules/parent/node_modules/@opentelemetry/api/node_modules/readdirp": { version: "3.6.0" },
      "node_modules/parent/node_modules/@deepseek-ai/dsh-plugin-test": { version: "0.2.0-rc.3", optional: true },
    },
  })
  const expected = [
    "@anthropic-ai/sdk@0.90.0",
    "@deepseek-ai/dsh-plugin-test@0.2.0-rc.3",
    "@deepseek-ai/dsh@0.2.0-rc.3",
    "@opentelemetry/api@1.9.0",
    "chokidar@3.6.0",
    "chokidar@4.0.3",
    "parent@1.0.0",
    "readdirp@3.6.0",
  ]

  it("extracts and deduplicates exact pairs from the entire candidate lock, including nested packages", () => {
    expect(exactEngineClosureExemptions(lockJson)).toEqual(expected)
  })

  it("merges the complete closure into valid TOML while preserving existing configuration", () => {
    const original = readFileSync(join(repositoryRoot, "bunfig.toml"), "utf8")
    const before = Bun.TOML.parse(original)
    const merged = mergeMinimumReleaseAgeExcludes(original, expected)
    const after = Bun.TOML.parse(merged)
    expect(after).toEqual({
      ...before,
      install: {
        ...before.install,
        minimumReleaseAgeExcludes: [...new Set([...before.install.minimumReleaseAgeExcludes, ...expected])],
      },
    })
    expect(mergeMinimumReleaseAgeExcludes(merged, expected)).toBe(merged)
    expect(readFileSync(join(repositoryRoot, "bunfig.toml"), "utf8")).toBe(original)
  })

  it("adds exact exceptions when the install section has no existing exceptions", () => {
    const original = '[install]\nminimumReleaseAge = 259200\n\n[test]\nroot = "tests"\n'
    expect(Bun.TOML.parse(mergeMinimumReleaseAgeExcludes(original, expected))).toEqual({
      install: { minimumReleaseAge: 259200, minimumReleaseAgeExcludes: expected },
      test: { root: "tests" },
    })
  })
})

describe("real artifact writers", () => {
  it("point the engine and the generation at the new values without disturbing anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-upgrade-"))
    try {
      mkdirSync(join(dir, "packages/ellamaka-cordis/src/runtime"), { recursive: true })
      copyFileSync(join(repositoryRoot, packageJsonPath), join(dir, packageJsonPath))
      copyFileSync(join(repositoryRoot, closureVersionPath), join(dir, closureVersionPath))
      const before = JSON.parse(readFileSync(join(dir, packageJsonPath), "utf8"))

      writeEngineVersionFile(dir, "0.2.0-rc.3")
      writeGenerationFile(dir, 4)

      const after = JSON.parse(readFileSync(join(dir, packageJsonPath), "utf8"))
      expect(after.dependencies["@deepseek-ai/dsh"]).toBe("0.2.0-rc.3")
      expect(after.version).toBe(before.version)
      expect(after.dependencies["@wopal/ellamaka-core"]).toBe(before.dependencies["@wopal/ellamaka-core"])
      expect(readFileSync(join(dir, closureVersionPath), "utf8")).toMatch(/DSH_CLOSURE_VERSION = 4(\s|$)/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
