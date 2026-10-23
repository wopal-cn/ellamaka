import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const currentDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(currentDir, "..", "..", "..")
const workflowText = (file: string) => readFileSync(join(root, ".github", "workflows", file), "utf8")

const hook = readFileSync(join(root, ".husky", "pre-commit"), "utf8")
const wrapper = readFileSync(join(root, "scripts", "ci", "run-gitleaks.sh"), "utf8")
const prepare = readFileSync(join(root, "scripts", "ci", "prepare-dsh-sandbox.sh"), "utf8")
const gitleaksIgnore = readFileSync(join(root, ".gitleaksignore"), "utf8")

/** Gitleaks release pinned by the wrapper, plus the official checksums. */
const PINNED_VERSION = "8.30.1"
const PINNED_CHECKSUMS: Record<string, string> = {
  darwin_arm64: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  darwin_x64: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  linux_arm64: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
}

function platformKey(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `${os}_${arch}`
}

const cacheHome = mkdtempSync(join(tmpdir(), "ellamaka-gitleaks-cache-"))
const scratch = mkdtempSync(join(tmpdir(), "ellamaka-gitleaks-scratch-"))

afterAll(() => {
  rmSync(cacheHome, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

/** A PATH without any global gitleaks, as on a clean developer machine. */
const minimalPath = "/usr/bin:/bin:/usr/sbin:/sbin"

function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("GIT_")) continue
    env[key] = value
  }
  return env
}

function runWrapper(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: ["bash", join(root, "scripts", "ci", "run-gitleaks.sh"), ...args],
    cwd,
    env: { ...cleanGitEnv(), PATH: minimalPath, XDG_CACHE_HOME: cacheHome, ...extraEnv },
  })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: { ...cleanGitEnv(), PATH: minimalPath } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

describe("pre-commit hook", () => {
  test("does not run any test suite", () => {
    // Test suites moved to the nightly/manual CI workflow and the release
    // gate. A pre-commit suite is a tax people skip with --no-verify.
    expect(hook).not.toMatch(/bun test|test:unit|test:integration|test:tools|test:ci/)
    expect(hook).not.toContain("typecheck")
  })

  test("checks only staged files with the repository lint command", () => {
    expect(hook).toContain("git diff --cached --name-only")
    expect(hook).toContain("bun run lint")
    expect(hook).toContain("--diff-filter=ACMR")
  })

  test("passes filenames containing n and spaces to lint as intact arguments", () => {
    const repo = mkdtempSync(join(scratch, "hook-argv-"))
    const bin = join(repo, "test-bin")
    const capture = join(repo, "lint-argv")
    mkdirSync(bin)
    mkdirSync(join(repo, "packages", "with spaces"), { recursive: true })
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true })
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$ELLAMAKA_TEST_CAPTURE"\n', { mode: 0o755 })
    // The scanner is an external boundary; this test observes shell argv only.
    writeFileSync(join(repo, "scripts", "ci", "run-gitleaks.sh"), "exit 0\n")
    const files = ["packages/button.ts", "packages/with spaces/plugin.ts"]
    for (const file of files) writeFileSync(join(repo, file), "export {}\n")
    git(repo, ["init", "-q"])
    git(repo, ["add", "--", ...files])
    const result = Bun.spawnSync({
      cmd: ["sh", "-c", hook],
      cwd: repo,
      env: { ...cleanGitEnv(), PATH: `${bin}:${minimalPath}`, ELLAMAKA_TEST_CAPTURE: capture },
    })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    expect(readFileSync(capture, "utf8").split("\0")).toEqual(["run", "lint", "--", ...files, ""])
  })

  test("scans staged content with the repo's gitleaks bootstrap", () => {
    expect(hook).toContain("scripts/ci/run-gitleaks.sh")
    expect(hook).not.toContain("|| true")
    expect(hook).not.toContain("continue-on-error")
    expect(hook).not.toContain("gitleaks git")
  })

  test("runs the bootstrap before the fast checks are considered done", () => {
    const lintIndex = hook.indexOf("bun run lint")
    const gitleaksIndex = hook.indexOf("scripts/ci/run-gitleaks.sh")
    expect(lintIndex).toBeGreaterThan(-1)
    expect(gitleaksIndex).toBeGreaterThan(lintIndex)
  })
})

describe("gitleaks bootstrap", () => {
  test("pins the release version and the official checksums for every supported asset", () => {
    expect(wrapper).toContain(`GITLEAKS_VERSION="${PINNED_VERSION}"`)
    for (const checksum of Object.values(PINNED_CHECKSUMS)) expect(wrapper).toContain(checksum)
  })

  test("verifies the checksum before executing and never needs a global install", () => {
    expect(wrapper).toContain("sha256sum")
    expect(wrapper).toContain("shasum -a 256")
    expect(wrapper).toMatch(/checksum mismatch/i)
    // The binary is resolved from the cache, not from PATH.
    expect(wrapper).not.toMatch(/command -v gitleaks/)
  })

  test("caches the verified binary under the user cache directory", () => {
    expect(wrapper).toContain("XDG_CACHE_HOME:-$HOME/.cache")
    expect(wrapper).toContain("ellamaka/gitleaks")
    expect(wrapper).toContain("ellamaka/gitleaks/${GITLEAKS_VERSION}")
    // Nothing is vendored into the repository.
    expect(existsSync(join(root, "vendor", "gitleaks"))).toBe(false)
    expect(existsSync(join(root, "scripts", "ci", "gitleaks"))).toBe(false)
  })

  test("keeps the existing fixture fingerprints for staged scans", () => {
    // Staged scans fingerprint as file:rule:line (no commit), so the
    // redaction-test fixtures need file-scoped entries in addition to the
    // historical commit-scoped ones.
    expect(gitleaksIgnore).toContain("packages/http-recorder/test/record-replay.test.ts:generic-api-key:127")
    expect(gitleaksIgnore).toContain("packages/http-recorder/test/record-replay.test.ts:gcp-api-key:129")
    expect(gitleaksIgnore).toContain("packages/http-recorder/test/record-replay.test.ts:generic-api-key:150")
    expect(gitleaksIgnore).toContain("packages/http-recorder/test/record-replay.test.ts:generic-api-key:314")
  })

  test("downloads once, then reuses the cached binary", () => {
    const first = runWrapper(["version"], root)
    expect(first.output).toContain(PINNED_VERSION)
    expect(first.exitCode).toBe(0)

    const binary = join(cacheHome, "ellamaka", "gitleaks", PINNED_VERSION, "gitleaks")
    expect(existsSync(binary)).toBe(true)
    const installedAt = statSync(binary).mtimeMs

    const second = runWrapper(["version"], root)
    expect(second.exitCode).toBe(0)
    expect(statSync(binary).mtimeMs).toBe(installedAt)
    expect(readdirSync(dirname(binary)).filter((name) => name.includes(".download."))).toEqual([])
  }, 120_000)

  test("rejects a download whose bytes do not match the pinned checksum", () => {
    const mirror = join(scratch, "mirror")
    const corruptedCache = join(scratch, "corrupted-cache")
    mkdirSync(mirror, { recursive: true })
    const asset = `gitleaks_${PINNED_VERSION}_${platformKey()}.tar.gz`
    writeFileSync(join(mirror, asset), "not the pinned artifact")

    const result = runWrapper(["version"], root, {
      GITLEAKS_DOWNLOAD_BASE_URL: `file://${mirror}`,
      XDG_CACHE_HOME: corruptedCache,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toMatch(/checksum mismatch/i)
    expect(existsSync(join(corruptedCache, "ellamaka", "gitleaks", PINNED_VERSION, "gitleaks"))).toBe(false)
  }, 120_000)

  test("blocks a fake secret staged for commit", () => {
    const repo = join(scratch, "leaky-repo")
    mkdirSync(repo, { recursive: true })
    git(repo, ["init", "-q", "."])
    git(repo, ["config", "user.email", "hook-test@example.com"])
    git(repo, ["config", "user.name", "hook test"])
    git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
    writeFileSync(join(repo, "config.ts"), 'const apiKey = "sk-proj-9fK2mQ7xR4tY8pL1nB6vC3dZ5wH0jS2aG4eU7iO9kM1"\n')
    git(repo, ["add", "config.ts"])

    const result = runWrapper([], repo)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("generic-api-key")
  }, 120_000)
})

describe("DSH sandbox preparation", () => {
  test("probes bubblewrap for real and fails the job when it cannot confine", () => {
    expect(prepare).toContain("bwrap")
    expect(prepare).toContain("--unshare-pid")
    expect(prepare).toContain("apparmor_restrict_unprivileged_userns")
    expect(prepare).toContain("unprivileged_userns_clone")
    // Probe failure is a hard failure, never a skip.
    expect(prepare).toMatch(/probe failed|cannot create/i)
    expect(prepare).not.toContain("|| true")
    expect(prepare).not.toContain("exit 0")
  })

  test("the Publish workflows call the probe instead of installing ad hoc", () => {
    for (const file of ["publish-ellamaka-cli.yml", "publish-ellamaka-desktop.yml"]) {
      expect(workflowText(file)).toContain("bash scripts/ci/prepare-dsh-sandbox.sh")
    }
  })
})
