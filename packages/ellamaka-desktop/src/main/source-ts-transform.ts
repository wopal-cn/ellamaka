import { transformSync } from "amaro"

const SOURCE_PATH_MARKERS = ["/plugins/", "/skills/"]

/** True for a TypeScript source file owned by a space plugin or skill. */
export function isUserTypeScriptSource(path: string): boolean {
  return path.endsWith(".ts") && SOURCE_PATH_MARKERS.some((marker) => path.includes(marker))
}

/** Transform TypeScript features Node's strip-only mode rejects (parameter properties). */
export function transformUserTypeScript(source: string): string {
  return transformSync(source, { mode: "transform", sourceMap: true }).code
}
