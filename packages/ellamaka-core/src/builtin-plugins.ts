import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import npa from "npm-package-arg"

export const DSH_ADAPTER_ID = "dsh-adapter"

export function isDshAdapterIdentity(value: unknown): boolean {
  return typeof value === "string" && value.split("/").at(-1) === DSH_ADAPTER_ID
}

/** Identify reserved plugins without evaluating their code or installing a package. */
export async function isBuiltinDshAdapter(spec: string): Promise<boolean> {
  if (!spec.startsWith("file:") && !path.isAbsolute(spec) && !spec.startsWith(".")) {
    const parsed = npa(spec)
    const alias: unknown = "subSpec" in parsed ? parsed.subSpec : undefined
    return (
      isDshAdapterIdentity(parsed.name) ||
      (parsed.type === "alias" &&
        !!alias &&
        typeof alias === "object" &&
        "name" in alias &&
        isDshAdapterIdentity(alias.name))
    )
  }
  const file = spec.startsWith("file:") ? fileURLToPath(spec) : path.resolve(spec)
  const leaf = path.basename(file)
  if (leaf === DSH_ADAPTER_ID || /^dsh-adapter\.[cm]?[jt]sx?$/.test(leaf)) return true
  if (/^index\.[cm]?[jt]sx?$/.test(leaf)) {
    let owner = path.dirname(file)
    while (["src", "dist", "lib", "build"].includes(path.basename(owner))) owner = path.dirname(owner)
    if (path.basename(owner) === DSH_ADAPTER_ID) return true
  }
  let dir = (await stat(file).catch(() => undefined))?.isDirectory() ? file : path.dirname(file)
  while (true) {
    const text = await readFile(path.join(dir, "package.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
      throw error
    })
    if (text !== undefined) {
      const json: unknown = JSON.parse(text)
      if (!json || typeof json !== "object") throw new Error("Cannot determine plugin package identity")
      return ("name" in json && isDshAdapterIdentity(json.name)) || ("id" in json && json.id === DSH_ADAPTER_ID)
    }
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}
