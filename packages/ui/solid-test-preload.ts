import { plugin } from "bun"
import solidPlugin from "vite-plugin-solid"

const solid = solidPlugin({
  include: /\.(?:jsx|tsx)$/,
})

type SolidTransformResult = string | { code: string } | null | undefined
type SolidTransform = (source: string, id: string, options: { ssr: boolean }) => Promise<SolidTransformResult>

const isSourcePath = (path: string) => /\.(?:jsx|tsx)$/.test(path) && !path.split(/[/\\]/).includes("node_modules")

async function transformSolid(source: string, path: string) {
  // vite-plugin-solid exposes transform through Vite's overloaded hook type.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const transform = solid.transform as unknown as SolidTransform
  return transform(source, path, { ssr: false })
}

plugin({
  name: "wopal-ui-solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.(?:jsx|tsx)$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      if (!isSourcePath(path)) return { contents: source, loader: "tsx" }
      const result = await transformSolid(source, path)
      if (!result) return { contents: source, loader: "tsx" }
      return { contents: typeof result === "string" ? result : result.code, loader: "tsx" }
    })
  },
})
