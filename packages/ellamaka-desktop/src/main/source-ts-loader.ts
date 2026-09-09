import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const SOURCE_PATH_MARKERS = ["/plugins/", "/skills/"]

export async function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (specifier: string, context: unknown) => Promise<{ url: string }>,
): Promise<{ url: string }> {
  if (
    !specifier.endsWith(".js") ||
    !(specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("file://"))
  ) {
    return nextResolve(specifier, context)
  }

  const parentURL = context.parentURL
  if (!parentURL || !SOURCE_PATH_MARKERS.some((marker) => parentURL.includes(marker))) {
    return nextResolve(specifier, context)
  }

  const candidateURL = specifier.startsWith("file://") ? specifier : new URL(specifier, parentURL).href
  const candidatePath = fileURLToPath(candidateURL)
  if (existsSync(candidatePath)) return nextResolve(specifier, context)

  const sourcePath = candidatePath.slice(0, -3) + ".ts"
  if (!existsSync(sourcePath)) return nextResolve(specifier, context)
  return nextResolve(pathToFileURL(sourcePath).href, context)
}
