import { plugin } from "bun"
import solidPlugin from "vite-plugin-solid"

const solid = solidPlugin({
  include:
    /\/(?:chat-blocks|chat-tool-blocks|prompt-navigator|spinner|workbench-chat-timeline|workbench-markdown-renderer|ellamaka-file|done)\.tsx$/,
})

type SolidTransformResult = string | { code: string } | null | undefined
type SolidTransform = (source: string, id: string, options: { ssr: boolean }) => Promise<SolidTransformResult>

plugin({
  name: "ellamaka-chat-solid-jsx",
  setup(build) {
    build.onLoad(
      {
        filter:
          /\/(?:chat-blocks|chat-tool-blocks|prompt-navigator|spinner|workbench-chat-timeline|workbench-markdown-renderer|ellamaka-file|done)\.tsx$/,
      },
      async ({ path }) => {
        const transform = solid.transform as unknown as SolidTransform
        const source = await Bun.file(path).text()
        const result = await transform(source, path, { ssr: false })
        if (!result) return { contents: source, loader: "tsx" }
        return { contents: typeof result === "string" ? result : result.code, loader: "tsx" }
      },
    )
  },
})
