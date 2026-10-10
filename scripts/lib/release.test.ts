import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// Unit tests for scripts/lib/release.sh helpers. The lib is sourced in a
// fresh bash subprocess per case (top-level `set -euo pipefail` + globals)
// so tests cannot pollute the bun process.

const REPO_ROOT = join(import.meta.dir, "../..")

function runLib(snippet: string, env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")
  const script = `
    set -euo pipefail
    ${exports}
    export REPO_ROOT=${JSON.stringify(REPO_ROOT)}
    source "$REPO_ROOT/scripts/lib/release.sh" >/dev/null 2>&1
    ${snippet}
  `
  const proc = Bun.spawnSync(["bash", "-c", script])
  if (proc.exitCode !== 0) {
    throw new Error(`lib snippet failed: ${proc.stderr.toString().trim()}`)
  }
  return proc.stdout.toString().trim()
}

describe("release.sh manifest_url", () => {
  test("CLI product resolves the ellamaka/ versioned path", () => {
    const url = runLib('manifest_url "2.0.5-rc.6"', { PRODUCT: "ellamaka-cli" })
    expect(url).toBe("https://download.coursedao.com/ellamaka/v2.0.5-rc.6/manifest.json")
  }, 120_000)

  test("desktop stable resolves the ellamaka-desktop/ versioned path", () => {
    const url = runLib('manifest_url "2.0.6"', { PRODUCT: "ellamaka-desktop", CHANNEL: "stable" })
    expect(url).toBe("https://download.coursedao.com/ellamaka-desktop/v2.0.6/manifest.json")
  }, 120_000)

  test("desktop beta resolves the ellamaka-desktop/beta/ versioned path", () => {
    const url = runLib('manifest_url "2.0.5-beta.1"', { PRODUCT: "ellamaka-desktop", CHANNEL: "beta" })
    expect(url).toBe("https://download.coursedao.com/ellamaka-desktop/beta/v2.0.5-beta.1/manifest.json")
  }, 120_000)

  test("desktop defaults to the stable root when CHANNEL is unset", () => {
    const url = runLib('manifest_url "2.0.6"', { PRODUCT: "ellamaka-desktop" })
    expect(url).toBe("https://download.coursedao.com/ellamaka-desktop/v2.0.6/manifest.json")
  }, 120_000)

  test("desktop accepts an explicit channel overriding the ambient CHANNEL", () => {
    const url = runLib('manifest_url "2.0.5-beta.2" "beta"', {
      PRODUCT: "ellamaka-desktop",
      CHANNEL: "stable",
    })
    expect(url).toBe("https://download.coursedao.com/ellamaka-desktop/beta/v2.0.5-beta.2/manifest.json")
  }, 120_000)
})

describe("release.sh cross-channel oracle", () => {
  test("beta records stay visible to highest_released_tag while a stable release runs", () => {
    // 发布 desktop stable 时（环境 CHANNEL=stable），beta 记录必须仍按 beta 根
    // 查询（best-effort curl 桩：beta 根 200，stable 根 404）。串根缺陷会查
    // stable 根 → 全部 404 → 输出空。
    const out = runLib(
      `
        curl() { case "$*" in *"/beta/"*) printf 200 ;; *) printf 404 ;; esac; }
        highest_released_tag ellamaka-desktop beta
      `,
      { PRODUCT: "ellamaka-desktop", CHANNEL: "stable" },
    )
    expect(out).toMatch(/^\d+\.\d+\.\d+-beta\.\d+$/)
  })

  test("stable records stay visible to highest_released_tag while a beta release runs", () => {
    // 发布 desktop beta 时（环境 CHANNEL=beta），stable 记录必须仍按 stable 根
    // 查询。串根缺陷会查 beta 根 → 看不到已发 stable → 输出空。
    const out = runLib(
      `
        curl() { case "$*" in *"/beta/"*) printf 404 ;; *) printf 200 ;; esac; }
        highest_released_tag ellamaka-desktop stable
      `,
      { PRODUCT: "ellamaka-desktop", CHANNEL: "beta" },
    )
    expect(out).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe("release.sh bump_commit_subject", () => {
  test("CLI rc carries the product and version without channel suffix", () => {
    const subject = runLib("bump_commit_subject", {
      PRODUCT: "ellamaka-cli",
      VERSION: "2.0.5-rc.6",
      CHANNEL_LABEL: "stable",
    })
    expect(subject).toBe("chore(release): bump ellamaka-cli to 2.0.5-rc.6")
  }, 120_000)

  test("desktop stable has no channel suffix", () => {
    const subject = runLib("bump_commit_subject", {
      PRODUCT: "ellamaka-desktop",
      VERSION: "2.0.6",
      CHANNEL_LABEL: "stable",
    })
    expect(subject).toBe("chore(release): bump ellamaka-desktop to 2.0.6")
  }, 120_000)

  test("desktop beta is annotated with the channel", () => {
    const subject = runLib("bump_commit_subject", {
      PRODUCT: "ellamaka-desktop",
      VERSION: "2.0.5-beta.1",
      CHANNEL_LABEL: "beta",
    })
    expect(subject).toBe("chore(release): bump ellamaka-desktop to 2.0.5-beta.1 (beta)")
  }, 120_000)
})

describe("build.sh release channel guard", () => {
  test("the CLI channel export is skipped in release mode", async () => {
    const buildSh = await Bun.file(join(REPO_ROOT, "scripts/build.sh")).text()
    // build-env (D-03) derives the release channel from the version shape and
    // fail-closes on contradiction; exporting the dev default ("main") broke
    // every CLI release build.
    expect(buildSh).toMatch(/if \[\[ -z "\$\{ELLAMAKA_RELEASE:-\}" \]\]; then\n\s*export ELLAMAKA_CHANNEL="\$CHANNEL"/)
  })
})

describe("release shell positional version", () => {
  test("both shells capture a positional [version] argument", async () => {
    // usage 承诺 `[version]` 位置参数（lib 的显式版本链路：渠道自动推断 +
    // version-line 单调校验都依赖它）。desktop 壳曾漏接该分支，任何版本参数
    // 都被当"未知选项"拒绝。
    for (const shell of ["scripts/release-cli.sh", "scripts/release-desktop.sh"]) {
      const src = await Bun.file(join(REPO_ROOT, shell)).text()
      expect(src).toMatch(/\*\)\n\s+\[ -z "\$VERSION" \] \|\| die "重复的版本参数/)
    }
  })
})

describe("release.sh check_npm_base_burned", () => {
  function runCheck(snippet: string, env: Record<string, string>): { out: string; code: number } {
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n")
    const script = `
      set -euo pipefail
      ${exports}
      export REPO_ROOT=${JSON.stringify(REPO_ROOT)}
      source "$REPO_ROOT/scripts/lib/release.sh" >/dev/null 2>&1
      ${snippet}
    `
    const proc = Bun.spawnSync(["bash", "-c", script], { timeout: 120_000 })
    return { out: proc.stdout.toString().trim() + "\n" + proc.stderr.toString().trim(), code: proc.exitCode }
  }

  test("clean base: reports publishable and exits 0", () => {
    // 目标 base 与 workspace 包 base 不同 → registry 上不可能存在该版本，
    // 无需构建比对，直接判 publishable。钉住接线（命令形态、gate 行为）。
    const { out, code } = runCheck(`check_npm_base_burned "9.9.9"; echo "rc=$?"`, {
      PRODUCT: "ellamaka-cli",
    })
    expect(code).toBe(0)
    expect(out).toContain("publishable")
    expect(out).toContain("rc=0")
  }, 120_000)

  test("burned base: aborts with the digest mismatch and a version suggestion", () => {
    // 2026-10-10 失败模式：registry 内容与构建不一致。桩掉 publish CLI 返回
    // 烧毁错误，guard 必须 abort 并给出 minor 建议版本。
    const stub = join("/tmp", `publish-stub-${Date.now()}.ts`)
    require("node:fs").writeFileSync(
      stub,
      `console.error("Error: @wopal/ellamaka-plugin@2.0.8 is already on the registry, but its contents differ from this build (registry bd058b97, local cfcff584). npm versions are immutable and this version number is permanently burned: bump the version and re-release.")\nprocess.exit(1)\n`,
    )
    const { out, code } = runCheck(`check_npm_base_burned "2.0.9"; echo "rc=$?"`, {
      PRODUCT: "ellamaka-cli",
      ELLAMAKA_NPM_PUBLISH_CLI: stub,
    })
    require("node:fs").rmSync(stub)
    expect(code).toBe(1)
    expect(out).toContain("已烧毁")
    expect(out).toContain("permanently burned")
    expect(out).toMatch(/--minor/)
    expect(out).toMatch(/2\.1\.0/)
  }, 120_000)

  test("publish CLI unavailable: skips the check instead of blocking releases", () => {
    // guard 是加固性预检：publish CLI 缺失（或 bun 不可用）不得让仓库无法发布。
    // fail-open 并说明原因。
    const { out, code } = runCheck(`check_npm_base_burned "2.0.8"; echo "rc=$?"`, {
      PRODUCT: "ellamaka-cli",
      ELLAMAKA_NPM_PUBLISH_CLI: "/tmp/ellamaka-no-such-publish-cli.ts",
    })
    expect(code).toBe(0)
    expect(out).toContain("跳过 npm base 预检")
    expect(out).toContain("rc=0")
  }, 120_000)
})

describe("release.sh confirm model", () => {
  function runShell(snippet: string, env: Record<string, string>): { out: string; code: number } {
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n")
    const script = `
      set -euo pipefail
      ${exports}
      export REPO_ROOT=${JSON.stringify(REPO_ROOT)}
      source "$REPO_ROOT/scripts/lib/release.sh" >/dev/null 2>&1
      ${snippet}
    `
    const proc = Bun.spawnSync(["bash", "-c", script])
    return { out: proc.stdout.toString().trim() + "\n" + proc.stderr.toString().trim(), code: proc.exitCode }
  }

  test("confirm_release_gate: --yes proceeds, non-interactive without --yes aborts", () => {
    // confirm_release_gate 的非交互 fail-closed 与 --yes 直通行 —— 发布前的
    // 最后人工门禁（对齐 wopal-cli bump-release）。stdout+stderr 合并断言。
    // 120s 超时：工作区在外置磁盘上，source lib 的 IO 耗时波动可达 7s+。
    const proceed = runShell(`confirm_release_gate; echo "rc=$?"`, {
      PRODUCT: "ellamaka-cli",
      VERSION: "2.0.9",
      ASSUME_YES: "true",
    })
    expect(proceed.code).toBe(0)
    expect(proceed.out).toContain("rc=0")

    const aborted = runShell(`confirm_release_gate; echo "rc=$?" </dev/null`, {
      PRODUCT: "ellamaka-cli",
      VERSION: "2.0.9",
      ASSUME_YES: "false",
    })
    expect(aborted.code).toBe(1)
    expect(aborted.out).toContain("非交互终端")
  }, 120_000)
})
