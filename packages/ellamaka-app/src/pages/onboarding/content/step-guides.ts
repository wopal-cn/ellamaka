import systemCheckGuide from "./zh-CN/guides/system-check.md?raw"
import installCliGuide from "./zh-CN/guides/install-cli.md?raw"
import ontologySetupGuide from "./zh-CN/guides/ontology-setup.md?raw"
import createSpaceGuide from "./zh-CN/guides/create-space.md?raw"
import aiProviderGuide from "./zh-CN/guides/ai-provider.md?raw"
import memoryConfigGuide from "./zh-CN/guides/memory-config.md?raw"
import doneGuide from "./zh-CN/guides/done.md?raw"
import {
  resolveStepGuideId,
  type StepGuideAssets,
  type StepGuideId,
} from "../step-guide"

const STEP_GUIDES: Record<StepGuideId, string> = {
  "system-check": systemCheckGuide,
  "install-cli": installCliGuide,
  "ontology-setup": ontologySetupGuide,
  "create-space": createSpaceGuide,
  "ai-provider": aiProviderGuide,
  "memory-config": memoryConfigGuide,
  done: doneGuide,
}

const assetModules = import.meta.glob("./zh-CN/assets/**/*.{png,jpg,jpeg,webp,gif,svg}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>

const assetPrefix = "./zh-CN/assets/"

export const STEP_GUIDE_ASSETS: StepGuideAssets = Object.fromEntries(
  Object.entries(assetModules)
    .filter(([path]) => path.startsWith(assetPrefix))
    .map(([path, url]) => [path.slice(assetPrefix.length), url]),
)

export function getStepGuideSource(step: string): string {
  const guideId = resolveStepGuideId(step)
  return guideId ? STEP_GUIDES[guideId] : ""
}
