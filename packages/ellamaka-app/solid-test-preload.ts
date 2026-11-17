import { plugin } from "bun"
import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import solidPlugin from "vite-plugin-solid"

const solid = solidPlugin({
  include: /\.(?:jsx|tsx)$/,
})

type SolidTransformResult = string | { code: string } | null | undefined
type SolidTransform = (source: string, id: string, options: { ssr: boolean }) => Promise<SolidTransformResult>

const isSourcePath = (path: string) => /\.(?:jsx|tsx)$/.test(path) && !path.split(/[/\\]/).includes("node_modules")

// Bun runs tests without Vite's import.meta.glob transform. Keep theme
// discovery equivalent to Vite's eager JSON glob, but only in the test loader.
async function expandThemeGlob(source: string, path: string) {
  if (!path.replaceAll("\\", "/").endsWith("/packages/ui/src/theme/context.tsx")) return source
  const expression = 'import.meta.glob<{ default: DesktopTheme }>("./themes/*.json", { eager: true })'
  if (!source.includes(expression)) return source
  const names = (await readdir(join(dirname(path), "themes"))).filter((name) => name.endsWith(".json")).sort()
  const imports = names.map((name, index) => `import themeForTest${index} from "./themes/${name}"`).join("\n")
  const entries = names.map((name, index) => `"./themes/${name}": { default: themeForTest${index} }`).join(",\n")
  return `${imports}\n${source.replace(expression, `{ ${entries} }`)}`
}

async function transformSolid(source: string, path: string) {
  // vite-plugin-solid exposes transform through Vite's overloaded hook type.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const transform = solid.transform as unknown as SolidTransform
  return transform(source, path, { ssr: false })
}

plugin({
  name: "ellamaka-chat-solid-jsx",
  setup(build) {
    build.onLoad(
      {
        filter: /\.(?:jsx|tsx)$/,
      },
      async ({ path }) => {
        const source = await expandThemeGlob(await Bun.file(path).text(), path)
        if (!isSourcePath(path)) return { contents: source, loader: "tsx" }
        const result = await transformSolid(source, path)
        if (!result) return { contents: source, loader: "tsx" }
        return { contents: typeof result === "string" ? result : result.code, loader: "tsx" }
      },
    )
  },
})
