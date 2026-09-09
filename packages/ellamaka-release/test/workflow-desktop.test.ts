import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const currentDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(currentDir, "..", "..", "..")
const workflow = readFileSync(join(root, ".github", "workflows", "publish-ellamaka-desktop.yml"), "utf8")
const builderConfig = readFileSync(join(root, "packages", "ellamaka-desktop", "electron-builder.config.ts"), "utf8")
const finalizeScript = readFileSync(join(root, "packages", "ellamaka-desktop", "scripts", "finalize-latest-json.ts"), "utf8")

describe("publish-ellamaka-desktop workflow", () => {
  test("uploads the versioned set driven by the manifest declaration", () => {
    // The uploaded set equals the declared set by construction; dist globs
    // must not drive versioned uploads.
    expect(workflow).toContain("Uploading versioned artifacts (declared set)...")
    expect(workflow).toContain('put_with_cache "dist/${name}" "${VERSION_PREFIX}/${name}"')
    expect(workflow).toContain('console.log([a.name, a.ext].join("\\t"))')
  })

  test("verifies versioned uploads against the manifest, not local dist files", () => {
    expect(workflow).toContain("Verifying R2 uploads against manifest...")
    expect(workflow).toContain("ERROR: manifest artifact missing sha256/size: $mname")
    expect(workflow).toContain("manifest_sha")
    expect(workflow).toContain("manifest_size")
    expect(workflow).toContain('while IFS=$\'\\t\' read -r name ext; do')
  })

  test("promotes latest aliases only after versioned verification passes", () => {
    // A failed verify must never point the beta/stable latest channel at a
    // broken release. Previously the aliases were written before verify.
    const verifyIdx = workflow.indexOf("Verifying R2 uploads against manifest...")
    const manifestIdx = workflow.indexOf("promoted latest manifest: ${LATEST_PREFIX}/manifest.json")
    const feedIdx = workflow.indexOf("promoted feed: ${LATEST_PREFIX}/${feed}")
    expect(verifyIdx).toBeGreaterThan(-1)
    expect(manifestIdx).toBeGreaterThan(verifyIdx)
    expect(feedIdx).toBeGreaterThan(verifyIdx)
  })

  test("no longer produces or uploads rpm packages", () => {
    expect(workflow).not.toMatch(/\*\.rpm/)
    expect(workflow).not.toContain("application/x-rpm")
    expect(builderConfig).toContain('target: ["AppImage", "deb"]')
    expect(builderConfig).not.toMatch(/rpm/)
    expect(finalizeScript).not.toMatch(/\.rpm/)
  })

  test("versions updater feeds and blockmaps for withdrawal restore", () => {
    // 撤回需要从 fallback 的 versioned prefix 恢复 latest（manifest + feeds
    // + updater 资产）。feeds 只在构建期生成，必须随版本归档，否则撤回后
    // latest feeds 悬空、自动更新全渠道失效。
    expect(workflow).toContain('"${VERSION_PREFIX}/${feed}"')
    expect(workflow).toContain("versioned feed")
    expect(workflow).toContain("dist/ellamaka-desktop-*.blockmap")
  })

  test("cleanup withdraw restores the whole latest channel and guards fallback health", () => {
    const cleanupCli = readFileSync(join(root, "packages", "ellamaka-release", "src", "cli", "cleanup.ts"), "utf8")
    const core = readFileSync(join(root, "packages", "ellamaka-release", "src", "cleanup", "core.ts"), "utf8")

    // 恢复整个 latest 通道（不止 manifest），fallback 自身已撤回时拒绝
    expect(core).toContain("restore-latest-channel")
    expect(cleanupCli).toContain("listR2ObjectKeys")
    expect(core).toContain("itself withdrawn")
  })

  test("withdraw purge covers latest feeds and updater copies", () => {
    const cleanupYml = readFileSync(join(root, ".github", "workflows", "cleanup-releases.yml"), "utf8")

    expect(cleanupYml).toContain("${ROOT}/latest/latest.yml")
    expect(cleanupYml).toContain("${ROOT}/latest/${name}.blockmap")
  })

  test("gates on DSH runtime manifest freshness before packaging", () => {
    // The packaged sidecar inlines generated/dsh-runtime-manifest.json at
    // bundle time; the committed manifest must match the source before
    // packaging. The check is read-only (--check) and precedes the build.
    expect(workflow).toContain("Verify DSH runtime manifest freshness")
    expect(workflow).toContain("generate-dsh-runtime-manifest.ts --check")
    const gateIdx = workflow.indexOf("generate-dsh-runtime-manifest.ts --check")
    const buildIdx = workflow.indexOf("Build desktop (electron-vite)")
    expect(gateIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeGreaterThan(gateIdx)
  })
})
