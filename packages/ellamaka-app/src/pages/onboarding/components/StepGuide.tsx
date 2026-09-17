import { createMemo } from "solid-js"
import { Markdown } from "@wopal/ui/markdown"
import {
  prepareStepGuideMarkdown,
  type StepGuideAssets,
} from "../step-guide"

export interface StepGuideProps {
  step: string
  source: string
  assets: StepGuideAssets
}

export function StepGuide(props: StepGuideProps) {
  const markdown = createMemo(() => prepareStepGuideMarkdown(props.source, props.assets))

  return (
    <Markdown
      class="ob-step-guide-markdown"
      text={markdown()}
      cacheKey={`onboarding-step-guide:${props.step}`}
    />
  )
}
