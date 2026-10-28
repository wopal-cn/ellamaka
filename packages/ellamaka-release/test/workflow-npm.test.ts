import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const currentDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(currentDir, "..", "..", "..")
const workflow = readFileSync(join(root, ".github", "workflows", "publish-ellamaka-npm.yml"), "utf8")

describe("publish-ellamaka-npm workflow", () => {
  test("owns an independent npm tag line and retry path", () => {
    expect(workflow).toContain("ellamaka-npm-v*")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain('EXPECTED_TAG="ellamaka-npm-v${VERSION}"')
    expect(workflow).toContain('GITHUB_REF_TYPE" != "tag"')
  })

  test("validates the exact SDK and Plugin version instead of product versions", () => {
    expect(workflow).toContain("packages/sdk/js/package.json")
    expect(workflow).toContain("packages/plugin/package.json")
    expect(workflow).not.toContain("packages/ellamaka-cli/package.json")
    expect(workflow).not.toContain("packages/ellamaka-desktop/package.json")
  })

  test("runs publisher tests and clean-install smoke before publishing", () => {
    const testIdx = workflow.indexOf("bun test test/npm-publish-*.test.ts")
    const smokeIdx = workflow.indexOf("bun packages/ellamaka-release/src/cli/verify-npm.ts")
    const publishIdx = workflow.indexOf("bun packages/ellamaka-release/src/cli/publish-npm.ts")
    expect(testIdx).toBeGreaterThan(-1)
    expect(smokeIdx).toBeGreaterThan(testIdx)
    expect(publishIdx).toBeGreaterThan(smokeIdx)
  })

  test("uses Node 24 OIDC trusted publishing only in the npm workflow", () => {
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("contents: read")
    expect(workflow).toMatch(/node-version:\s*["']24["']/)
    expect(workflow).toMatch(/registry-url:\s*["']https:\/\/registry\.npmjs\.org["']/)
    expect(workflow).not.toContain("NPM_TOKEN")
  })
})
