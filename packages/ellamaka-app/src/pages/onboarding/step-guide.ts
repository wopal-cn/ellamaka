import { marked, type Tokens } from "marked"

export type StepGuideAssets = Readonly<Record<string, string>>

export const STEP_GUIDE_IDS = [
  "system-check",
  "install-cli",
  "ontology-setup",
  "create-space",
  "ai-provider",
  "memory-config",
  "done",
] as const

export type StepGuideId = typeof STEP_GUIDE_IDS[number]

const STEP_GUIDE_ALIASES: Record<string, StepGuideId> = {
  "github-auth": "ontology-setup",
  "install-wopal-cli": "install-cli",
  "install-ellamaka-cli": "install-cli",
  "star-guide": "done",
}

const SAFE_ASSET_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function resolveStepGuideId(step: string): StepGuideId | null {
  if ((STEP_GUIDE_IDS as readonly string[]).includes(step)) {
    return step as StepGuideId
  }
  return STEP_GUIDE_ALIASES[step] ?? null
}

export function resolveStepGuideImageSource(
  source: string,
  assets: StepGuideAssets,
): string | null {
  const trimmed = source.trim()
  if (trimmed.startsWith("asset:")) {
    const key = trimmed.slice("asset:".length)
    if (!SAFE_ASSET_KEY.test(key) || key.includes("..")) return null
    return assets[key] ?? null
  }

  try {
    const url = new URL(trimmed)
    return url.protocol === "https:" ? trimmed : null
  } catch {
    return null
  }
}

export function prepareStepGuideMarkdown(
  markdown: string,
  assets: StepGuideAssets,
): string {
  const replacements: Array<{ raw: string; html: string }> = []
  marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type !== "image") return
    const image = token as Tokens.Image
    const resolved = resolveStepGuideImageSource(image.href, assets)
    if (!resolved) {
      replacements.push({
        raw: image.raw,
        html: `> 图片未显示：${image.text.trim() || "未提供图片说明"}`,
      })
      return
    }

    const safeAlt = escapeHtml(image.text.trim())
    const caption = safeAlt ? `<figcaption>${safeAlt}</figcaption>` : ""
    replacements.push({
      raw: image.raw,
      html: [
        '<figure class="ob-step-guide-figure">',
        `<img src="${escapeHtml(resolved)}" alt="${safeAlt}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`,
        caption,
        "</figure>",
      ].join(""),
    })
  })

  return replacements.reduce(
    (result, replacement) => result.replace(replacement.raw, replacement.html),
    markdown,
  )
}
