import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs"
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
    const executable = hook
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
    expect(executable).toContain("git diff --cached --name-only -z")
    // `T` (type change) must be in the filter: a symlink replaced by a regular
    // file still has content to check. Without it such a commit bypasses all
    // three gates.
    expect(executable).toMatch(/--diff-filter=[ACMRT]*T/)
    // Incremental mode: `lint:files` judges only the selected files against the
    // baseline. The bare `lint` command would compare the whole repository and
    // is not what a staged-only hook should run. Asserted against the executable
    // lines only, so the header prose cannot satisfy it.
    expect(executable).toContain("bun run lint:files")
    expect(executable).not.toMatch(/bun run lint[^:]/)
  })

  test("includes a staged type change in the checked file set", () => {
    // Real Git proof for the `T` status: a tracked symlink replaced by a
    // regular file is reported by `git diff --cached` as `T`, not `M`.
    const repo = mkdtempSync(join(scratch, "hook-type-change-"))
    const bin = join(repo, "test-bin")
    const capture = join(repo, "bun-argv")
    const callMarker = "<call>"
    mkdirSync(bin)
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true })
    writeFileSync(
      join(bin, "bun"),
      '#!/bin/sh\nprintf \'%s\\0\' "$CALL_MARKER" >> "$ELLAMAKA_TEST_CAPTURE"\nprintf \'%s\\0\' "$@" >> "$ELLAMAKA_TEST_CAPTURE"\n',
      { mode: 0o755 },
    )
    writeFileSync(join(repo, "scripts", "ci", "run-gitleaks.sh"), 'touch "$GITLEAKS_MARKER"\nexit 0\n')
    git(repo, ["init", "-q"])
    git(repo, ["config", "user.email", "hook-test@example.com"])
    git(repo, ["config", "user.name", "hook test"])
    // A tracked symlink, committed first, then replaced by a regular file.
    writeFileSync(join(repo, "target.ts"), "export const target = 1\n")
    symlinkSync("target.ts", join(repo, "linked.ts"))
    git(repo, ["add", "target.ts", "linked.ts"])
    git(repo, ["commit", "-q", "-m", "init"])
    rmSync(join(repo, "linked.ts"))
    writeFileSync(join(repo, "linked.ts"), "export const linked = 1\n")
    git(repo, ["add", "linked.ts"])

    expect(git(repo, ["diff", "--cached", "--name-status"])).toContain("T\tlinked.ts")

    const scannerRan = join(repo, "gitleaks-ran")
    const result = Bun.spawnSync({
      cmd: ["sh", "-c", hook],
      cwd: repo,
      env: {
        ...cleanGitEnv(),
        PATH: `${bin}:${minimalPath}`,
        ELLAMAKA_TEST_CAPTURE: capture,
        CALL_MARKER: callMarker,
        GITLEAKS_MARKER: scannerRan,
      },
    })
    expect(result.exitCode).toBe(0)

    const tokens = readFileSync(capture, "utf8").split("\0")
    if (tokens[tokens.length - 1] === "") tokens.pop()
    const calls: string[][] = []
    for (const token of tokens) {
      if (token === callMarker) {
        calls.push([])
        continue
      }
      const current = calls[calls.length - 1]
      if (!current) throw new Error("the capture starts with an argument instead of a call marker")
      current.push(token)
    }
    // The type-changed file reaches lint. Before the fix it produced no calls
    // at all and the hook exited 0 without checking anything.
    expect(calls[0]).toEqual(["run", "lint:files", "--", "linked.ts"])
    expect(existsSync(scannerRan)).toBe(true)
  })

  test("passes filenames containing n and spaces to both checks as intact arguments", () => {
    const repo = mkdtempSync(join(scratch, "hook-argv-"))
    const bin = join(repo, "test-bin")
    const capture = join(repo, "bun-argv")
    // A value that cannot collide with a real argv token.
    const callMarker = "<call>"
    mkdirSync(bin)
    mkdirSync(join(repo, "packages", "with spaces"), { recursive: true })
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true })
    // The hook calls `bun` once per stage, so every invocation is appended with
    // a record marker instead of overwriting the previous one. Arguments are
    // NUL-separated so a path containing spaces survives intact.
    writeFileSync(
      join(bin, "bun"),
      '#!/bin/sh\nprintf \'%s\\0\' "$CALL_MARKER" >> "$ELLAMAKA_TEST_CAPTURE"\nprintf \'%s\\0\' "$@" >> "$ELLAMAKA_TEST_CAPTURE"\n',
      { mode: 0o755 },
    )
    // The scanner is an external boundary; this test observes shell argv only.
    writeFileSync(join(repo, "scripts", "ci", "run-gitleaks.sh"), "exit 0\n")
    const files = ["packages/button.ts", "packages/with spaces/plugin.ts"]
    for (const file of files) writeFileSync(join(repo, file), "export {}\n")
    git(repo, ["init", "-q"])
    git(repo, ["add", "--", ...files])
    const result = Bun.spawnSync({
      cmd: ["sh", "-c", hook],
      cwd: repo,
      env: {
        ...cleanGitEnv(),
        PATH: `${bin}:${minimalPath}`,
        ELLAMAKA_TEST_CAPTURE: capture,
        CALL_MARKER: callMarker,
      },
    })
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)

    // Split the capture back into one argv array per `bun` invocation.
    const tokens = readFileSync(capture, "utf8").split("\0")
    if (tokens[tokens.length - 1] === "") tokens.pop()
    const calls: string[][] = []
    for (const token of tokens) {
      if (token === callMarker) {
        calls.push([])
        continue
      }
      const current = calls[calls.length - 1]
      if (!current) throw new Error("the capture starts with an argument instead of a call marker")
      current.push(token)
    }

    // Lint receives the staged files themselves, in order and unsplit.
    expect(calls[0]).toEqual(["run", "lint:files", "--", ...files])
    // The format scope resolver is invoked without the paths: `--intersect`
    // reads them from stdin, so no staged filename may leak into its argv.
    expect(calls[1]).toEqual(["run", "packages/opencode/script/format/files.ts", "--intersect"])
    expect(calls.length).toBe(2)
  })

  test("hands the resolved format scope to prettier as intact arguments", () => {
    // W-02: the previous test only proved the resolver is invoked. Here the
    // fake resolver returns a real NUL-separated list, so the test observes the
    // actual argv `prettier --check` receives. A dropped or split filename in
    // the format stage now fails the test instead of passing silently.
    const repo = mkdtempSync(join(scratch, "hook-prettier-argv-"))
    const bin = join(repo, "test-bin")
    const bunCapture = join(repo, "bun-argv")
    const prettierCapture = join(repo, "prettier-argv")
    const resolverStdin = join(repo, "resolver-stdin")
    const scopeList = join(repo, "scope-list")
    const callMarker = "<call>"
    mkdirSync(bin)
    mkdirSync(join(repo, "packages", "with spaces"), { recursive: true })
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true })
    writeFileSync(
      join(bin, "bun"),
      [
        "#!/bin/sh",
        'printf \'%s\\0\' "$CALL_MARKER" >> "$ELLAMAKA_TEST_CAPTURE"',
        'printf \'%s\\0\' "$@" >> "$ELLAMAKA_TEST_CAPTURE"',
        'case "$*" in',
        '  *format/files.ts*) cat > "$ELLAMAKA_RESOLVER_STDIN"; cat "$ELLAMAKA_SCOPE_LIST" ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, "bunx"),
      [
        "#!/bin/sh",
        'printf \'%s\\0\' "$CALL_MARKER" >> "$ELLAMAKA_PRETTIER_CAPTURE"',
        'printf \'%s\\0\' "$@" >> "$ELLAMAKA_PRETTIER_CAPTURE"',
        'exit "${PRETTIER_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    writeFileSync(join(repo, "scripts", "ci", "run-gitleaks.sh"), 'touch "$GITLEAKS_MARKER"\nexit 0\n')

    const staged = [
      "packages/nname.ts",
      "packages/with spaces/plugin.ts",
      "packages/opencode/src/upstream.ts",
      "docs/notes.md",
    ]
    for (const file of staged) {
      mkdirSync(dirname(join(repo, file)), { recursive: true })
      writeFileSync(join(repo, file), "x\n")
    }
    git(repo, ["init", "-q"])
    git(repo, ["add", "--", ...staged])

    // The resolver's answer: every staged candidate except the upstream file,
    // which sits outside the formatting scope.
    const resolved = staged.filter((file) => !file.startsWith("packages/opencode/"))
    writeFileSync(scopeList, resolved.map((file) => file + "\0").join(""))

    const scannerRan = join(repo, "gitleaks-ran")
    const result = Bun.spawnSync({
      cmd: ["sh", "-c", hook],
      cwd: repo,
      env: {
        ...cleanGitEnv(),
        PATH: `${bin}:${minimalPath}`,
        ELLAMAKA_TEST_CAPTURE: bunCapture,
        ELLAMAKA_PRETTIER_CAPTURE: prettierCapture,
        ELLAMAKA_RESOLVER_STDIN: resolverStdin,
        ELLAMAKA_SCOPE_LIST: scopeList,
        CALL_MARKER: callMarker,
        GITLEAKS_MARKER: scannerRan,
      },
    })
    expect(result.exitCode).toBe(0)

    // The candidates the hook handed to the resolver: NUL-separated, unsplit.
    // Compared as sets because git reports the staged paths in its own order.
    const candidates = readFileSync(resolverStdin, "utf8").split("\0")
    if (candidates[candidates.length - 1] === "") candidates.pop()
    expect([...candidates].sort()).toEqual([...staged].sort())

    // And the argv prettier actually received.
    const tokens = readFileSync(prettierCapture, "utf8").split("\0")
    if (tokens[tokens.length - 1] === "") tokens.pop()
    const calls: string[][] = []
    for (const token of tokens) {
      if (token === callMarker) {
        calls.push([])
        continue
      }
      const current = calls[calls.length - 1]
      if (!current) throw new Error("the capture starts with an argument instead of a call marker")
      current.push(token)
    }
    expect(calls).toEqual([["prettier", "--check", "--", ...resolved]])
    // Names containing spaces and the letter n survive whole; the upstream file
    // never reaches prettier.
    expect(calls[0]).toContain("packages/with spaces/plugin.ts")
    expect(calls[0]).toContain("packages/nname.ts")
    expect(calls[0]).not.toContain("packages/opencode/src/upstream.ts")
    expect(existsSync(scannerRan)).toBe(true)
  })

  test("fails the commit when prettier fails and still runs gitleaks", () => {
    const repo = mkdtempSync(join(scratch, "hook-prettier-fail-"))
    const bin = join(repo, "test-bin")
    const scopeList = join(repo, "scope-list")
    const resolverStdin = join(repo, "resolver-stdin")
    const bunCapture = join(repo, "bun-argv")
    const prettierCapture = join(repo, "prettier-argv")
    const callMarker = "<call>"
    mkdirSync(bin)
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true })
    writeFileSync(
      join(bin, "bun"),
      [
        "#!/bin/sh",
        'printf \'%s\\0\' "$CALL_MARKER" >> "$ELLAMAKA_TEST_CAPTURE"',
        'printf \'%s\\0\' "$@" >> "$ELLAMAKA_TEST_CAPTURE"',
        'case "$*" in',
        '  *format/files.ts*) cat > "$ELLAMAKA_RESOLVER_STDIN"; cat "$ELLAMAKA_SCOPE_LIST" ;;',
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, "bunx"),
      [
        "#!/bin/sh",
        'printf \'%s\\0\' "$CALL_MARKER" >> "$ELLAMAKA_PRETTIER_CAPTURE"',
        'printf \'%s\\0\' "$@" >> "$ELLAMAKA_PRETTIER_CAPTURE"',
        'exit "${PRETTIER_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    writeFileSync(join(repo, "scripts", "ci", "run-gitleaks.sh"), 'touch "$GITLEAKS_MARKER"\nexit 0\n')
    writeFileSync(join(repo, "docs.md"), "# title\n")
    git(repo, ["init", "-q"])
    git(repo, ["add", "docs.md"])
    writeFileSync(scopeList, "docs.md\0")

    const scannerRan = join(repo, "gitleaks-ran")
    const result = Bun.spawnSync({
      cmd: ["sh", "-c", hook],
      cwd: repo,
      env: {
        ...cleanGitEnv(),
        PATH: `${bin}:${minimalPath}`,
        ELLAMAKA_TEST_CAPTURE: bunCapture,
        ELLAMAKA_PRETTIER_CAPTURE: prettierCapture,
        ELLAMAKA_RESOLVER_STDIN: resolverStdin,
        ELLAMAKA_SCOPE_LIST: scopeList,
        CALL_MARKER: callMarker,
        GITLEAKS_MARKER: scannerRan,
        PRETTIER_EXIT_CODE: "1",
      },
    })
    // A formatting failure on its own is enough to block the commit...
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("bun run format")
    // ...and the secret scan still ran.
    expect(existsSync(scannerRan)).toBe(true)
  })

  test("scans staged content with the repo's gitleaks bootstrap", () => {
    expect(hook).toContain("scripts/ci/run-gitleaks.sh")
    expect(hook).not.toContain("|| true")
    expect(hook).not.toContain("continue-on-error")
    expect(hook).not.toContain("gitleaks git")
  })

  test("runs the bootstrap before the fast checks are considered done", () => {
    // Match the executable lines, not the prose above them: the header comment
    // mentions both commands, and an assertion that lands in a comment proves
    // nothing about the order they actually run in.
    const lintIndex = hook.split("\n").findIndex((line) => line.trimStart().startsWith("bun run lint"))
    const gitleaksIndex = hook
      .split("\n")
      .findIndex((line) => line.trimStart().startsWith("sh scripts/ci/run-gitleaks.sh"))
    expect(lintIndex).toBeGreaterThan(-1)
    expect(gitleaksIndex).toBeGreaterThan(lintIndex)
  })

  test("still scans for secrets after a failing lint or format check", () => {
    // Behavioural proof, not a text-shape check: `bun` fails every stage and the
    // scanner writes its own marker. If the hook used `set -e` (or otherwise
    // aborted on the first failure) the marker would never appear and a secret
    // would reach the commit unnoticed.
    const repo = mkdtempSync(join(scratch, "hook-gitleaks-after-failure-"))
    const bin = join(repo, "test-bin")
    const scannerRan = join(repo, "gitleaks-ran")
    mkdirSync(bin)
    mkdirSync(join(repo, "scripts", "ci"), { recursive: true })
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    writeFileSync(join(repo, "scripts", "ci", "run-gitleaks.sh"), 'touch "$GITLEAKS_MARKER"\nexit 0\n')
    writeFileSync(join(repo, "broken.ts"), "export const x = 1\n")
    git(repo, ["init", "-q"])
    git(repo, ["add", "broken.ts"])
    const result = Bun.spawnSync({
      cmd: ["sh", "-c", hook],
      cwd: repo,
      env: { ...cleanGitEnv(), PATH: `${bin}:${minimalPath}`, GITLEAKS_MARKER: scannerRan },
    })
    expect(existsSync(scannerRan)).toBe(true)
    // The failing checks still fail the commit.
    expect(result.exitCode).not.toBe(0)
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
