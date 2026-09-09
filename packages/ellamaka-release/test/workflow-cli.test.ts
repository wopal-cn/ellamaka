import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const currentDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(currentDir, "..", "..", "..")
const workflow = readFileSync(join(root, ".github", "workflows", "publish-ellamaka-cli.yml"), "utf8")

function count(text: string, needle: string) {
  return text.split(needle).length - 1
}

describe("publish-ellamaka workflow", () => {
  test("release triggered by CLI tag push, with dispatch as re-release/dev path", () => {
    // release-cli.sh / release-desktop.sh own trigger authority: one-step
    // bump → push namespaced tag → push:tags fires this workflow. failed-attempt
    // re-release and CI dev builds go through workflow_dispatch.
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toMatch(/\n  push:\s*\n\s*tags:\s*\[\s*"ellamaka-cli-v\*"\s*\]/)
    expect(workflow).toContain('github.event_name }}" = "push"')
    expect(workflow).toContain("${GITHUB_REF_NAME#ellamaka-cli-v}")
  })

  test("release builds gate version against the CLI anchor package.json", () => {
    // The version truth source is packages/ellamaka-cli/package.json
    // (DISTRIBUTION.md §3.2). The tag version must equal the anchor file;
    // mismatches fail before any build starts.
    expect(workflow).toContain("packages/ellamaka-cli/package.json")
    expect(workflow).toContain("Validate version matches package.json anchor")
  })

  test("builds release binaries with release channel and archives the 4 P1 artifacts", () => {
    expect(workflow).toContain("OPENCODE_RELEASE: ${{ needs.version.outputs.release }}")
    expect(workflow).toContain("bash scripts/build.sh cli --platform \"${PLATFORM}\" --arch primary --web-ui \"${WEB_UI}\"")
    expect(workflow).toContain("ellamaka-darwin-arm64.tar.gz")
    expect(workflow).toContain("ellamaka-darwin-x64.tar.gz")
    expect(workflow).toContain("ellamaka-linux-x64.tar.gz")
    expect(workflow).toContain("ellamaka-windows-x64.zip")
    expect(workflow).not.toContain("dist/ellamaka-darwin-arm64.zip")
    expect(workflow).not.toContain("dist/ellamaka-darwin-x64.zip")
  })

  test("selects the embedded web UI during manual dispatch", () => {
    expect(workflow).toContain("web_ui:")
    expect(workflow).toContain("default: \"ellamaka-app\"")
    expect(workflow).toContain("- ellamaka-app")
    expect(workflow).toContain("- app")
    expect(workflow).toContain("- none")
    expect(workflow).toContain("WEB_UI: ${{ github.event.inputs.web_ui || 'ellamaka-app' }}")
  })

  test("generates release context from namespaced tag + upstream lock", () => {
    // Per DISTRIBUTION.md §7.1, the workflow generates a release-context.json
    // from the checked-out namespaced tag + upstream lock + github.sha +
    // github.run_id. Build and manifest steps both read it. The upstream lock
    // path is the CLI default (release/upstreams.lock.json).
    expect(workflow).toContain("release-context.json")
    expect(workflow).toContain("bun packages/ellamaka-release/src/cli/context.ts")
    expect(workflow).toContain("ELLAMAKA_RELEASE_CONTEXT_PATH")
    expect(workflow).toContain("GITHUB_REF_NAME")
    expect(workflow).toContain("GITHUB_RUN_ID")
  })

  test("generates schema v2 manifest from release context (not override params)", () => {
    // package-release.mjs manifest must receive --release-context-path; it
    // must NOT receive --version/--tag/--build as override params that could
    // desync from the release context. The engineApi mechanism was removed
    // (07d38d89ec), so --engine-api must not appear either.
    expect(workflow).toContain("bun packages/ellamaka-release/src/cli/manifest.ts manifest")
    expect(workflow).toContain("--release-context-path")
    expect(workflow).not.toContain("--engine-api")
    expect(workflow).not.toMatch(/--tag v"\$VERSION"/)
    expect(workflow).not.toMatch(/--build "\$BUILD"/)
    expect(workflow).toContain("ellamaka/latest/manifest.json")
    expect(workflow).not.toContain("ellamaka/latest/checksums.txt")
    expect(workflow).not.toContain("ellamaka/latest/release-notes.md")
    // TTL: versioned paths use 30-day cache, latest uses 60-second cache
    expect(workflow).toContain("max-age=2592000")
    expect(workflow).toContain("max-age=60")
    expect(workflow).not.toContain("max-age=604800")
    expect(workflow).not.toContain("max-age=300")
  })

  test("does NOT clear versioned prefix before upload (immutable, fail-closed)", () => {
    // Per DISTRIBUTION.md §7.1, versioned R2 paths are immutable. The old
    // `aws s3 rm --recursive` clear must be removed; if an effective manifest
    // already exists at the target path, the workflow must fail closed.
    expect(workflow).not.toContain('aws s3 rm "s3://wopal-release/${VERSION_PREFIX}/"')
    expect(workflow).toContain("manifest.json")
    // fail-closed: check for existing manifest before upload
    expect(workflow).toMatch(/manifest\.json.*exists|already.*manifest|fail.*closed|effective manifest/i)
  })

  test("uploads manifest last as the commit point (manifest-last protocol)", () => {
    // Per §9, the manifest is written last as the release commit point. The
    // `put_with_cache` for manifest.json must come after artifacts.
    const manifestIdx = workflow.indexOf('put_with_cache "release-output/manifest.json" "${VERSION_PREFIX}/manifest.json"')
    const artifactIdx = workflow.indexOf('put_with_cache "dist/${name}" "${VERSION_PREFIX}/${name}"')
    expect(manifestIdx).toBeGreaterThan(artifactIdx)
    expect(manifestIdx).toBeGreaterThan(-1)
  })

  test("verifies R2 uploads against manifest hashes (not local dist files)", () => {
    expect(workflow).toContain("Verifying R2 uploads against manifest...")
    expect(workflow).toContain("manifest_sha")
    expect(workflow).toContain("manifest_size")
    expect(workflow).toContain("head-object")
    expect(workflow).toContain("expected_hash")
    expect(workflow).not.toContain("local  sha256")
    expect(workflow).not.toContain("local_hash")
    // The verify loop iterates manifest artifacts, never dist globs — a dist
    // file absent from the manifest must not fake a mismatch via empty
    // array lookups.
    expect(workflow).not.toMatch(/for f in dist\/ellamaka-\*/)
    expect(workflow).toContain('while IFS=$\'\\t\' read -r name ext; do')
    expect(workflow).toContain('console.log([a.name, a.ext].join("\\t"))')
  })

  test("promotes latest alias only after versioned verification passes", () => {
    // A failed verify must never point the stable alias at a broken release.
    // Previously the latest manifest was written before verification.
    const verifyIdx = workflow.indexOf("Verifying R2 uploads against manifest...")
    const promoteIdx = workflow.indexOf("promoted latest manifest: ellamaka/latest/manifest.json")
    expect(verifyIdx).toBeGreaterThan(-1)
    expect(promoteIdx).toBeGreaterThan(verifyIdx)
  })

  test("purges CDN cache for latest alias and release artifacts", () => {
    expect(workflow).toContain("Purge Cloudflare CDN cache")
    expect(workflow).toContain("CLOUDFLARE_CACHE_PURGE_TOKEN")
    expect(workflow).toContain("CLOUDFLARE_CACHE_PURGE_ZONE")
    expect(workflow).toContain("offset+=30")
    expect(workflow).toContain("ellamaka/latest/manifest.json")
    expect(workflow).toContain("ellamaka/v${VERSION}/manifest.json")
    expect(workflow).toContain("for (const a of m.artifacts) console.log(a.url)")
    expect(workflow).not.toContain("purge_everything")
  })

  test("creates GitHub releases idempotently (no overwrite of committed release)", () => {
    // Per §8/§9, committed releases are immutable. `gh release edit` on an
    // existing committed release is forbidden; only `gh release create` is
    // allowed (idempotent create-if-absent).
    expect(workflow).toContain("wopal-cn/ellamaka")
    expect(workflow).toContain("wopal-cn/wopal-space-ontology")
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}")
    expect(workflow).toContain("RELEASE_TOKEN secret is required to publish the ontology GitHub release.")
    expect(workflow).toContain("--notes-file release-output/release-notes.md")
    expect(count(workflow, "bun packages/ellamaka-release/src/cli/gitee.ts")).toBe(2)
    expect(count(workflow, "--repo wopal-cn/ellamaka")).toBeGreaterThanOrEqual(2)
    expect(count(workflow, "--repo wopal-cn/wopal-space-ontology")).toBeGreaterThanOrEqual(2)
    // No gh release edit (committed release cannot be overwritten)
    expect(workflow).not.toContain("gh release edit")
    expect(workflow).not.toContain("--generate-notes")
  })

  test("does not inline cleanup (uses separate cleanup-releases workflow)", () => {
    // Per Task 5, cleanup is a separate workflow with protection model.
    // The inline cleanup job must be removed.
    expect(workflow).not.toContain("cleanup-ellamaka-releases.mjs")
  })

  test("gates on DSH runtime manifest freshness before packaging", () => {
    // The bundled CLI inlines generated/dsh-runtime-manifest.json at bundle
    // time; the committed manifest must match the source before packaging.
    // The check is read-only (--check) and precedes the Build step.
    expect(workflow).toContain("Verify DSH runtime manifest freshness")
    expect(workflow).toContain("bun packages/ellamaka-cordis/script/generate-dsh-runtime-manifest.ts --check")
    const gateIdx = workflow.indexOf("generate-dsh-runtime-manifest.ts --check")
    const buildIdx = workflow.indexOf("- name: Build")
    expect(gateIdx).toBeGreaterThan(-1)
    expect(buildIdx).toBeGreaterThan(gateIdx)
  })
})
