import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildReleaseIdentity } from "@wopal/ellamaka-release/identity"
import { ABSENT_INPUT, DSH_HOME_GENERATION_INPUTS, computeGuardedFingerprint } from "../src/runtime/home-generation.ts"
import { readAtTag, resolvePublishedFrontier } from "./check-dsh-home-generation.ts"

const tag = "ellamaka-cli-v2.0.9"
const closurePath = "packages/ellamaka-cordis/src/runtime/closure-version.ts"
const packagePath = "packages/ellamaka-cordis/package.json"
const inputPath = DSH_HOME_GENERATION_INPUTS[0]
const closureSource = "export const DSH_CLOSURE_VERSION = 3\n"
const engineVersion = "0.2.0-rc.2"
const scriptDir = dirname(fileURLToPath(import.meta.url))

let repoRoot: string

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ellamaka-generation-history-"))
  git("init", "--template=")
  git("config", "user.name", "Generation Test")
  git("config", "user.email", "generation@example.invalid")
  for (const [path, content] of [
    [closurePath, closureSource],
    [packagePath, JSON.stringify({ dependencies: { "@deepseek-ai/dsh": engineVersion } })],
    [inputPath, "// historical Home writer\n"],
  ] as const) {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true })
    writeFileSync(join(repoRoot, path), content)
  }
  git("add", ".")
  git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Historical release")
  git("tag", tag)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function removeBlob(path: string): void {
  const oid = git("rev-parse", `${tag}:${path}`).trim()
  unlinkSync(join(repoRoot, ".git", "objects", oid.slice(0, 2), oid.slice(2)))
  // The tree still records the file, but its content is no longer readable.
  expect(git("ls-tree", "-z", tag, "--", path)).not.toBe("")
}

function manifest(): string {
  const commit = git("rev-parse", tag).trim()
  return JSON.stringify({
    version: "2.0.9",
    releaseIdentity: buildReleaseIdentity({
      product: "ellamaka-cli",
      version: "2.0.9",
      channel: "stable",
      upstreamLock: { schemaVersion: 1, sources: { opencode: { version: "1.0.0", gitCommit: "0".repeat(40) } } },
      gitCommit: commit,
      builtAt: "2026-10-23T00:00:00Z",
      workflowRunId: "1",
    }),
  })
}

function publishClosureSource(source: string): void {
  writeFileSync(join(repoRoot, closurePath), source)
  git("add", closurePath)
  git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Update published generation")
  git("tag", "-f", tag)
  // Parsing must use the tagged source, never the valid working copy.
  writeFileSync(join(repoRoot, closurePath), closureSource)
}

describe("readAtTag with real Git history", () => {
  it("reads the tagged content even when the working file changes", () => {
    writeFileSync(join(repoRoot, closurePath), "working copy differs\n")
    expect(readAtTag(repoRoot, tag, closurePath)).toBe(closureSource)
  })

  it("returns null only for a path absent from a valid tree", () => {
    expect(readAtTag(repoRoot, tag, "not-in-this-release.ts")).toBeNull()
  })

  it("propagates a bad ref even when the requested path is absent", () => {
    expect(() => readAtTag(repoRoot, "missing-release", "not-in-this-release.ts")).toThrow()
  })

  it("propagates an unreadable blob whose path is still in the tree", () => {
    removeBlob(closurePath)
    expect(() => readAtTag(repoRoot, tag, closurePath)).toThrow()
  })
})

describe("published history fails closed without network access", () => {
  it.each([
    ["empty source", ""],
    ["missing constant", "export const OTHER = 3\n"],
    ["missing initializer", "export const DSH_CLOSURE_VERSION =\n"],
    ["non-numeric initializer", "export const DSH_CLOSURE_VERSION = unknown\n"],
    ["zero", "export const DSH_CLOSURE_VERSION = 0\n"],
    ["negative integer", "export const DSH_CLOSURE_VERSION = -3\n"],
    ["fraction", "export const DSH_CLOSURE_VERSION = 3.5\n"],
    ["integer-valued decimal", "export const DSH_CLOSURE_VERSION = 3.0\n"],
    ["unsafe integer", "export const DSH_CLOSURE_VERSION = 9007199254740993\n"],
    ["numeric suffix", "export const DSH_CLOSURE_VERSION = 3oops\n"],
    ["arithmetic expression", "export const DSH_CLOSURE_VERSION = 3 + 1\n"],
    ["multiline expression", "export const DSH_CLOSURE_VERSION = 3\n + 1\n"],
    ["exponent", "export const DSH_CLOSURE_VERSION = 3e2\n"],
    ["duplicate declarations", `${closureSource}${closureSource}`],
    ["conflicting declarations", `${closureSource}export const DSH_CLOSURE_VERSION = 4\n`],
    ["commented constant", `// ${closureSource}`],
    ["string containing a constant", `export const OTHER = ${JSON.stringify(closureSource)}\n`],
  ])("rejects an existing published closure file with %s", async (_label, source) => {
    publishClosureSource(source)
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(manifest()))
    try {
      await expect(resolvePublishedFrontier(repoRoot)).rejects.toMatchObject({ code: "DSH_HOME_GENERATION_INVALID" })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it.each([
    [
      "comments and semicolon",
      "/** Published generation. */\nexport const DSH_CLOSURE_VERSION = 4; // generation\n",
      4,
    ],
    ["largest safe integer", "export const DSH_CLOSURE_VERSION = 9007199254740991\n", 9007199254740991],
  ])("accepts a valid published constant with %s", async (_label, source, generation) => {
    publishClosureSource(source)
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(manifest()))
    try {
      const { committed } = await resolvePublishedFrontier(repoRoot)
      expect(committed).toHaveLength(1)
      expect(committed[0]?.generation).toBe(generation)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("keeps generation 0 for a release that genuinely predates closure-version.ts", async () => {
    git("rm", closurePath)
    git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Release without generation")
    git("tag", "-f", tag)
    const body = manifest()
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body))
    try {
      const { committed } = await resolvePublishedFrontier(repoRoot)
      expect(committed).toHaveLength(1)
      expect(committed[0]?.generation).toBe(0)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("keeps genuinely absent generation inputs in the historical fingerprint", async () => {
    const body = manifest()
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body))
    try {
      const { committed } = await resolvePublishedFrontier(repoRoot)
      const inputs = Object.fromEntries(DSH_HOME_GENERATION_INPUTS.map((path) => [path, ABSENT_INPUT]))
      inputs[inputPath] = "// historical Home writer\n"
      expect(committed).toHaveLength(1)
      expect(committed[0]?.generation).toBe(3)
      expect(committed[0]?.fingerprint).toBe(computeGuardedFingerprint({ dshVersion: engineVersion, inputs }))
    } finally {
      fetchMock.mockRestore()
    }
  })

  it.each([closurePath, packagePath, inputPath])("rejects unreadable published content at %s", async (path) => {
    const body = manifest()
    removeBlob(path)
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body))
    try {
      await expect(resolvePublishedFrontier(repoRoot)).rejects.toMatchObject({ status: 128 })
    } finally {
      fetchMock.mockRestore()
    }
  })

  it.each(["check-dsh-home-generation.ts", "upgrade-dsh.ts"])(
    "%s exits 1 when the published generation is malformed",
    (script) => {
      publishClosureSource("export const DSH_CLOSURE_VERSION = 3.5\n")
      const preload = join(repoRoot, "manifest-preload.ts")
      writeFileSync(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(manifest())})\n`)
      const result = spawnSync(process.execPath, ["--preload", preload, join(scriptDir, script), engineVersion], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ELLAMAKA_REPO_ROOT: repoRoot },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("DSH_HOME_GENERATION_INVALID")
      expect(result.stdout).not.toContain("published frontier = 0")
      expect(result.stdout).not.toContain("ok:")
    },
  )

  it.each(["check-dsh-home-generation.ts", "upgrade-dsh.ts"])(
    "%s exits 1 instead of bootstrapping when the generation blob is unreadable",
    (script) => {
      const body = manifest()
      removeBlob(closurePath)
      const preload = join(repoRoot, "manifest-preload.ts")
      writeFileSync(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(body)})\n`)
      const result = spawnSync(process.execPath, ["--preload", preload, join(scriptDir, script), engineVersion], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ELLAMAKA_REPO_ROOT: repoRoot },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout + result.stderr).toContain("git show")
      expect(result.stdout).not.toContain("published frontier = 0")
      expect(result.stdout).not.toContain("ok:")
    },
  )
})
