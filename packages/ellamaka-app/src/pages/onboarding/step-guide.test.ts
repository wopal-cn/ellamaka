import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  prepareStepGuideMarkdown,
  resolveStepGuideId,
  resolveStepGuideImageSource,
  STEP_GUIDE_IDS,
} from "./step-guide"

describe("onboarding step guide", () => {
  test("allows HTTPS image URLs and adds privacy and loading attributes", () => {
    const markdown = "![同步示意图](https://cdn.example.com/onboarding/sync.webp)"

    const result = prepareStepGuideMarkdown(markdown, {})

    expect(result).toContain('src="https://cdn.example.com/onboarding/sync.webp"')
    expect(result).toContain('alt="同步示意图"')
    expect(result).toContain('loading="lazy"')
    expect(result).toContain('decoding="async"')
    expect(result).toContain('referrerpolicy="no-referrer"')
  })

  test("supports valid Markdown image URLs containing parentheses", () => {
    const result = prepareStepGuideMarkdown(
      "![流程图](https://cdn.example.com/onboarding/diagram_(v2).webp)",
      {},
    )

    expect(result).toContain('src="https://cdn.example.com/onboarding/diagram_(v2).webp"')
  })

  test("resolves bundled image aliases without exposing filesystem paths", () => {
    expect(resolveStepGuideImageSource("asset:ontology/fork.webp", {
      "ontology/fork.webp": "app://renderer/assets/fork-a1b2.webp",
    })).toBe("app://renderer/assets/fork-a1b2.webp")
  })

  test("rejects insecure and executable external image protocols", () => {
    for (const source of [
      "http://cdn.example.com/image.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "file:///tmp/private.png",
    ]) {
      expect(resolveStepGuideImageSource(source, {})).toBeNull()
    }
  })

  test("renders a readable fallback when an image source is rejected", () => {
    const result = prepareStepGuideMarkdown("![架构图](http://example.com/diagram.png)", {})

    expect(result).not.toContain("<img")
    expect(result).toContain("图片未显示：架构图")
  })

  test("escapes image alternative text before generating HTML", () => {
    const result = prepareStepGuideMarkdown(
      "![说明 & <测试>](https://cdn.example.com/image.png)",
      {},
    )

    expect(result).toContain('alt="说明 &amp; &lt;测试&gt;"')
    expect(result).not.toContain('alt="说明 & <测试>"')
  })

  test("maps legacy onboarding steps to their canonical guides", () => {
    expect(resolveStepGuideId("github-auth")).toBe("ontology-setup")
    expect(resolveStepGuideId("install-wopal-cli")).toBe("install-cli")
    expect(resolveStepGuideId("install-ellamaka-cli")).toBe("install-cli")
    expect(resolveStepGuideId("star-guide")).toBe("done")
    expect(resolveStepGuideId("unknown-step")).toBeNull()
  })

  test("provides a non-empty Markdown guide for every canonical step", () => {
    const guideDir = join(import.meta.dir, "content", "zh-CN", "guides")

    for (const step of STEP_GUIDE_IDS) {
      const source = readFileSync(join(guideDir, `${step}.md`), "utf-8")
      expect(source.trim().length).toBeGreaterThan(0)
      expect(source).not.toMatch(/^\s*<\/?[a-z][^>]*>/im)
    }
  })
})
