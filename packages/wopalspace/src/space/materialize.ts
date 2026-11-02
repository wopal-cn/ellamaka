import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SpaceSchema } from "./assembly"

/**
 * Skeleton rendering for a Space.
 *
 * Idempotent: existing files are preserved byte for byte and only missing
 * managed files are created. A missing template is reported, never written.
 * Templates come from an injected source so a first init can read the
 * ontology working tree while a rerun reads the Space branch.
 */

export interface InitResult {
  readonly created: string[]
  readonly skipped: string[]
  readonly missing: string[]
  readonly success: boolean
}

export interface MaterializeOptions {
  /** Whether the first-run guide is rendered; only true on a fresh Space. */
  readonly bootstrap?: boolean
}

export interface TemplateSource {
  readonly read: (template: string) => string | null
  readonly label: (template: string) => string
}

export interface RenderContext {
  readonly spaceName: string
  readonly spaceRoot: string
  readonly ontologyRepo: string
  readonly ontologyName: string
}

/** Template source backed by a directory on disk. */
export function filesystemTemplates(root: string): TemplateSource {
  return {
    read: (template) => {
      const path = join(root, template)
      if (!existsSync(path)) return null
      try {
        return readFileSync(path, "utf8")
      } catch {
        return null
      }
    },
    label: (template) => join(root, template),
  }
}

function createDirs(
  result: { created: string[]; skipped: string[] },
  spaceRoot: string,
  prefix: string,
  dirs: SpaceSchema["space"]["dirs"],
): void {
  for (const entry of dirs) {
    const target = join(spaceRoot, prefix, entry.path)
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true })
      result.created.push(target)
    } else {
      result.skipped.push(target)
    }
    for (const keep of entry.keep ?? []) {
      const keepPath = join(target, keep)
      if (existsSync(keepPath)) {
        result.skipped.push(keepPath)
        continue
      }
      writeFileSync(keepPath, "")
      result.created.push(keepPath)
    }
  }
}

function renderFiles(
  result: { created: string[]; skipped: string[]; missing: string[] },
  spaceRoot: string,
  prefix: string,
  files: SpaceSchema["space"]["files"],
  source: TemplateSource,
  context: RenderContext,
): void {
  for (const entry of files) {
    const content = source.read(entry.template)
    const target = join(spaceRoot, prefix, entry.target)
    if (content === null) {
      result.missing.push(source.label(entry.template))
      continue
    }
    if (existsSync(target)) {
      result.skipped.push(target)
      continue
    }
    const rendered = content
      .replaceAll("{space-name}", context.spaceName)
      .replaceAll("<space-root-path>", context.spaceRoot)
      .replaceAll("${ONTOLOGY_REPO}", context.ontologyRepo)
      .replaceAll("${ONTOLOGY_NAME}", context.ontologyName)
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, rendered)
    result.created.push(target)
  }
}

/** Render a Space skeleton from its schema. */
export function materializeSpace(
  spaceRoot: string,
  schema: SpaceSchema,
  source: TemplateSource,
  context: RenderContext,
  options: MaterializeOptions = {},
): InitResult {
  const result = { created: [] as string[], skipped: [] as string[], missing: [] as string[], success: true }
  const bootstrap = options.bootstrap ?? true
  try {
    createDirs(result, spaceRoot, schema.runtime.path, schema.runtime.dirs)
    createDirs(result, spaceRoot, "", schema.space.dirs)
    renderFiles(result, spaceRoot, schema.runtime.path, schema.runtime.files, source, context)
    const spaceFiles = bootstrap
      ? schema.space.files
      : schema.space.files.filter((entry) => entry.target !== "BOOTSTRAP.md")
    renderFiles(result, spaceRoot, "", spaceFiles, source, context)
  } catch (error) {
    result.success = false
    result.missing.push("Unexpected error: " + (error instanceof Error ? error.message : String(error)))
  }
  return result
}
