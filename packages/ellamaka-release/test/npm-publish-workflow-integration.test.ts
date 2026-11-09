import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { spawnSync } from "child_process"

const root = resolve(import.meta.dir, "..", "..", "..")
const workflow = readFileSync(join(root, ".github/workflows/publish-ellamaka-npm.yml"), "utf8")

describe("npm workflow selection", () => {
  test("release script encodes the selected package and exact version in the tag", () => {
    const cases = [
      { args: ["--package", "@wopal/ellamaka-sdk", "4.0.0"], tag: "ellamaka-npm-v4.0.0-sdk" },
      { args: ["--package", "@wopal/ellamaka-plugin", "5.0.0"], tag: "ellamaka-npm-v5.0.0-plugin" },
      { args: [], tag: "-sdk-v" },
    ]
    for (const item of cases) {
      const result = spawnSync("bash", ["scripts/release-npm.sh", "--dry-run", ...item.args], {
        cwd: root,
        encoding: "utf8",
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(item.tag)
      if (item.args[1] === "@wopal/ellamaka-sdk") expect(result.stdout).not.toContain("@wopal/ellamaka-plugin")
      if (item.args[1] === "@wopal/ellamaka-plugin") expect(result.stdout).not.toContain("@wopal/ellamaka-sdk")
    }
  })

  test("workflow accepts exactly the selected manifest versions and rejects a mismatched tag", () => {
    const sdkVersion = JSON.parse(readFileSync(join(root, "packages/sdk/js/package.json"), "utf8")).version
    const pluginVersion = JSON.parse(readFileSync(join(root, "packages/plugin/package.json"), "utf8")).version
    const block = workflow.match(/id: selection[\s\S]*?run: \|\n([\s\S]*?)\n      - uses: oven-sh/)
    expect(block).not.toBeNull()
    const script = block![1]!.replace(/^          /gm, "").replaceAll("${{ github.event_name }}", "push")
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-workflow-test-"))
    try {
      for (const [tag, expected] of [
        [`ellamaka-npm-v${sdkVersion}-sdk`, 0],
        [`ellamaka-npm-v${pluginVersion}-plugin`, 0],
        [`ellamaka-npm-v${sdkVersion}-sdk-v${pluginVersion}-plugin`, 0],
        ["ellamaka-npm-v999.0.0-sdk", 1],
      ] as const) {
        const result = spawnSync("bash", ["-c", script], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_REF_TYPE: "tag",
            GITHUB_REF_NAME: tag,
            GITHUB_OUTPUT: join(dir, "output"),
            RETRY_TAG: "",
          },
        })
        expect(result.status).toBe(expected)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
