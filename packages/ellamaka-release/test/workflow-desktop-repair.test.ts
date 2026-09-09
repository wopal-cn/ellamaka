import { describe, expect, test } from "bun:test"

const root = new URL("../../../", import.meta.url)

async function source(path: string) {
  return Bun.file(new URL(path, root)).text()
}

describe("desktop release repair", () => {
  test("publishes only beta or prod with one build context", async () => {
    const workflow = await source(".github/workflows/publish-ellamaka-desktop.yml")

    expect(workflow).toContain('default: "prod"')
    expect(workflow).toContain("channel: ${{ steps.version.outputs.channel }}")
    expect(workflow).toContain("OPENCODE_CHANNEL: ${{ needs.version.outputs.channel }}")
    expect(workflow).toContain("OPENCODE_VERSION: ${{ needs.version.outputs.version }}")
    expect(workflow).not.toContain("Build sidecar (Node.js runtime)")
    expect(workflow).toContain("--publish never")
  })

  test("release triggered by desktop tag push, with dispatch as re-release/dev path", async () => {
    const workflow = await source(".github/workflows/publish-ellamaka-desktop.yml")

    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toMatch(/\n  push:\s*\n\s*tags:\s*\[\s*"ellamaka-desktop-v\*"\s*\]/)
    expect(workflow).toContain('github.event_name }}" = "push"')
    expect(workflow).toContain("${GITHUB_REF_NAME#ellamaka-desktop-v}")
  })

  test("release builds gate version against the desktop anchor package.json", async () => {
    const workflow = await source(".github/workflows/publish-ellamaka-desktop.yml")

    expect(workflow).toContain("packages/ellamaka-desktop/package.json")
    expect(workflow).toContain("Validate version matches package.json anchor")
  })

  test("isolates beta storage and fails closed on existing manifest", async () => {
    const workflow = await source(".github/workflows/publish-ellamaka-desktop.yml")

    expect(workflow).toContain('CHANNEL" = "beta"')
    expect(workflow).toContain("ellamaka-desktop/beta")
    // Per §9, use head-object to check for existing manifest (fail-closed),
    // not list-objects-v2 for recursive clear.
    expect(workflow).toContain("head-object")
    expect(workflow).not.toContain('aws s3 rm "s3://wopal-release/${VERSION_PREFIX}/"')
    expect(workflow).toContain("effective manifest already exists")
    expect(workflow).toContain(".zip.blockmap")
    expect(workflow).toContain(".exe.blockmap")
    // Latest manifest upload
    expect(workflow).toContain('${LATEST_PREFIX}/manifest.json')
    // TTL: versioned 30-day, latest 60-second, no legacy values
    expect(workflow).toContain("max-age=2592000")
    expect(workflow).toContain("max-age=60")
    expect(workflow).not.toContain("max-age=604800")
    expect(workflow).not.toContain("max-age=300")
    // Purge URL includes latest manifest
    expect(workflow).toContain('${LATEST_BASE}/manifest.json')
  })

  test("injects release version and ad-hoc signs macOS", async () => {
    const config = await source("packages/ellamaka-desktop/electron-builder.config.ts")

    expect(config).toContain('identity: "-"')
    expect(config).toContain("extraMetadata")
    expect(config).toContain("packageName")
    expect(config).toContain('executableName: "ellamaka"')
    expect(config).toContain("OPENCODE_VERSION")
    expect(config).toContain("OPENCODE_BUILD_ID")
    expect(config).toContain("ellamaka-desktop/beta/latest")
  })

  test("enables isolated beta update checks", async () => {
    const constants = await source("packages/ellamaka-desktop/src/main/constants.ts")
    const updater = await source("packages/ellamaka-desktop/src/main/updater.ts")

    expect(constants).toContain('CHANNEL === "beta" || CHANNEL === "prod"')
    expect(updater).toContain('autoUpdater.allowPrerelease = CHANNEL === "beta"')
  })

  test("release-cli.sh / release-desktop.sh push namespaced product tags that trigger workflows", async () => {
    const cliScript = await source("scripts/release-cli.sh")
    const desktopScript = await source("scripts/release-desktop.sh")
    const engine = await source("scripts/lib/release.sh")

    // One-step release model (docs/DISTRIBUTION.md §4.1): bump anchors,
    // commit, create namespaced tag, push — push:tags triggers the workflow.
    // failed-attempt re-release goes through workflow_dispatch --ref <tag>.
    expect(engine).toContain('TAG="${PRODUCT}-v${VERSION}"')
    expect(engine).toContain("dispatch_workflow")

    // Desktop channel is a single switch: --beta means beta channel + beta
    // bump in one flag. The old --channel flag is rejected explicitly.
    expect(desktopScript).toContain("--beta")
    expect(desktopScript).toContain('--channel) die')
    expect(desktopScript).toContain("不接受 --channel")
    // CLI never carries a beta channel: --beta is rejected explicitly.
    expect(cliScript).toContain('--beta) die')

    // push : tags 触发（一步制）；re-release 仍走 gh workflow run
    expect(engine).toContain('push "$REMOTE" "$BRANCH" "$TAG"')
    expect(engine).toContain("tag push 触发")
    expect(engine).toContain("gh workflow run")
    expect(engine).toContain("--ref")

    // Removed anti-patterns:
    // - No --retag (committed releases are immutable; failed attempts retry
    //   via re-release dispatch, tags are never moved)
    expect(engine).not.toContain("--retag")
    // - No implicit -N auto-increment for prod
    expect(engine).not.toContain("自动递增 -N")
    // - No generic vX.Y.Z tag (must be namespaced)
    expect(engine).not.toMatch(/VERSION="v\$PLAIN_VERSION"/)
  })

  test("release scripts reject withdrawn versions before mutation", async () => {
    const engine = await source("scripts/lib/release.sh")

    // Per docs/DISTRIBUTION.md §7.3, withdrawn-versions.json is the
    // permanent record of versions that must never be reused.
    expect(engine).toContain("withdrawn-versions.json")
    expect(engine).toContain("withdrawn")
  })

  test("release scripts retry failed attempts and refuse committed tags", async () => {
    const engine = await source("scripts/lib/release.sh")

    // Failed-attempt retry protocol (§7.1 manifest-last): a tag whose
    // manifest is absent is a failed attempt and may be re-dispatched on
    // that tag; a tag with an effective manifest is immutable and refused.
    expect(engine).toContain("has_effective_manifest")
    expect(engine).toContain("highest_released_tag")
    expect(engine).toContain("check_branch_channel_policy")
    // Committed releases are immutable: refuse to re-release a tag that has
    // a valid manifest.
    expect(engine).toContain("已发布 release 不可变")
  })

  test("pins release workflows to Node 24-native official actions", async () => {
    const cli = await source(".github/workflows/publish-ellamaka-cli.yml")
    const desktop = await source(".github/workflows/publish-ellamaka-desktop.yml")

    expect(cli).toContain("actions/checkout@v6")
    expect(cli).toContain("actions/cache@v5")

    expect(desktop).toContain("actions/checkout@v6")
    expect(desktop).toContain("oven-sh/setup-bun@v2")
    expect(desktop).toContain("actions/cache@v5")
    expect(desktop).toContain("actions/upload-artifact@v7")
    expect(desktop).toContain("actions/download-artifact@v8")
    expect(desktop).not.toContain("actions/upload-artifact@v5")
    expect(desktop).not.toContain("actions/download-artifact@v5")
  })

  test("carries build identity via release context into packages and manifests", async () => {
    const desktop = await source(".github/workflows/publish-ellamaka-desktop.yml")
    const cli = await source(".github/workflows/publish-ellamaka-cli.yml")

    expect(desktop).toContain("OPENCODE_BUILD_ID: ${{ github.sha }}")
    expect(desktop).toContain("ELLAMAKA_RELEASE_CONTEXT_PATH")
    expect(desktop).toContain("--release-context-path release-context.json")
    expect(cli).toContain("ELLAMAKA_RELEASE_CONTEXT_PATH")
    expect(cli).toContain("--release-context-path release-context.json")
  })

  test("gates both publish workflows on DSH runtime manifest freshness", async () => {
    // Both real build jobs run the read-only manifest check (--check) before
    // packaging, so a stale committed manifest fails the release closed.
    const cli = await source(".github/workflows/publish-ellamaka-cli.yml")
    const desktop = await source(".github/workflows/publish-ellamaka-desktop.yml")

    expect(cli).toContain("generate-dsh-runtime-manifest.ts --check")
    expect(desktop).toContain("generate-dsh-runtime-manifest.ts --check")
    // Gate must precede the packaging step in both workflows.
    expect(cli.indexOf("generate-dsh-runtime-manifest.ts --check")).toBeLessThan(cli.indexOf("- name: Build"))
    expect(desktop.indexOf("generate-dsh-runtime-manifest.ts --check")).toBeLessThan(
      desktop.indexOf("Build desktop (electron-vite)"),
    )
  })

  test("withdraw script requires exactly one product (cli or desktop)", async () => {
    const script = await source("scripts/withdraw-release.sh")

    expect(script).toContain("cli")
    expect(script).toContain("desktop")
    // 二选一：不能同时撤回两个产品
    expect(script).toContain("不能同时")
  })

  test("withdraw script defaults to the latest released version of the selected channel", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // 省略 version 时撤回该渠道最新发布版本（不是"上一个"）
    expect(script).toContain("默认撤回最新发布版本")
    expect(script).toContain("find_previous_version")
    expect(script).toContain("ls-remote")
  })

  test("withdraw script records the version and dispatches the cleanup workflow", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // 登记 withdrawn-versions.json（提交 + push）
    expect(script).toContain("withdrawn-versions.json")
    expect(script).toContain('git -C "$REPO_ROOT" commit')
    expect(script).toContain('git -C "$REPO_ROOT" push')

    // dispatch cleanup-releases.yml withdraw 模式（保留 action，脚本传参触发）
    expect(script).toContain("gh workflow run cleanup-releases.yml")
    expect(script).toContain("mode=withdraw")
    expect(script).toContain("withdraw-version")
    expect(script).toContain("fallback-version")
    expect(script).toContain("apply=true")
  })

  test("withdraw script has no manual fallback knob — it is always derived", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // fallback 固定取同渠道上一版本，不接受用户输入（减少出错面）
    expect(script).not.toContain("--fallback")
    expect(script).toContain("fallback 自动取同渠道上一版本")
  })

  test("withdraw script matches namespaced product tags", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // 实际 tag 是 ellamaka-cli-vX.Y.Z / ellamaka-desktop-vX.Y.Z，
    // 不能用裸 ${product}-v* 前缀（cli-v* / desktop-v* 永远匹配不到）
    expect(script).toContain('ls-remote --tags origin "ellamaka-${product}-v*"')
    expect(script).not.toContain('ls-remote --tags origin "${product}-v*"')
  })

  test("withdraw script validates the target version exists before recording", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // 版本必须真实存在：远端 tag + R2 versioned manifest，否则在登记前中止
    expect(script).toContain("tag_exists")
    expect(script).toContain("manifest_exists")
    expect(script).toContain("validate_version_exists")
    // 校验先于登记：validate 调用必须出现在 record 调用之前
    const validateIdx = script.indexOf("validate_version_exists")
    const recordIdx = script.indexOf('record_withdrawn "$PRODUCT_KEY" "$VERSION"')
    expect(validateIdx).toBeGreaterThan(-1)
    expect(recordIdx).toBeGreaterThan(validateIdx)
  })

  test("withdraw script rejects a fallback that is itself withdrawn", async () => {
    const script = await source("scripts/withdraw-release.sh")

    expect(script).toContain("本身已被撤回")
  })

  test("withdraw script supports dry-run without recording or dispatching", async () => {
    const script = await source("scripts/withdraw-release.sh")

    expect(script).toContain("--dry-run")
    expect(script).toContain("DRY_RUN")
    expect(script).toContain("[DRY RUN] 不 dispatch")
  })

  test("withdraw script fails closed on dirty branch or uncommitted withdrawn file", async () => {
    const script = await source("scripts/withdraw-release.sh")

    expect(script).toContain("当前分支不是 main")
    expect(script).toContain("未提交修改")
  })

  test("withdraw script is idempotent for already-withdrawn versions", async () => {
    const script = await source("scripts/withdraw-release.sh")

    expect(script).toContain("已在 withdrawn-versions.json 中登记（已执行过撤回）")
    expect(script).toContain("无需重复撤回")
  })

  test("withdraw script resolves versions within a single channel", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // 版本解析必须带 channel：stable 只与 stable 比较，beta 只与 beta 比较
    expect(script).toContain("highest_released")
    expect(script).toContain("find_previous_version")
    expect(script).toContain("channel")
    // 渠道判定：-beta.N 属于 beta，其余属于 stable
    expect(script).toContain("-beta.")
  })

  test("withdraw script requires channel selection for the multi-channel desktop product", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // desktop 多渠道，必须显式 --channel；cli 只有 stable
    expect(script).toContain("--channel")
    expect(script).toContain("desktop 是多渠道产品，必须用 --channel 指定撤回渠道")
    expect(script).toContain("cli 只有 stable 渠道")
  })

  test("withdraw script rejects channel/version mismatch", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // 显式 version 的渠道必须与 --channel 一致
    expect(script).toContain("与 --channel")
  })

  test("withdraw script maps product to full registry key", async () => {
    const script = await source("scripts/withdraw-release.sh")

    // withdrawn-versions.json 与 cleanup workflow 使用全名 key
    // （ellamaka-cli / ellamaka-desktop），脚本参数 cli|desktop 必须映射
    expect(script).toContain("ellamaka-desktop")
    expect(script).toContain("ellamaka-cli")
    // 登记与 dispatch 使用映射后的全名，而非裸参数
    expect(script).toMatch(/PRODUCT_KEY/)
  })
})
