import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "@wopal/ellamaka-core/global"
import { Glob } from "@wopal/ellamaka-core/util/glob"
import * as Log from "@wopal/ellamaka-core/util/log"
import { ConfigMarkdown } from "@/config/markdown"
import { resolveWopalSpaceRoot } from "@/config/wopal-space-settings"
import { InstanceState } from "@/effect/instance-state"
import { isRecord } from "@/util/record"
import { inferAgentScope, normalizeRulePath } from "./name"

const log = Log.create({ service: "rule" })

const RULE_PATTERN = "**/*.{md,mdc}"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String)),
  agentScope: Schema.optional(Schema.String),
  source: Schema.Literals(["global", "space"]),
  location: Schema.String,
}).annotate({ identifier: "RuleCapabilityInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export interface Interface {
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Rule") {}

type Frontmatter = {
  description?: string
  keywords?: string[]
}

// Only single-level subdirectories are agent scopes (`fae/astro.md` → "fae");
// root-level files and deeper paths carry no agent scope. Path identity and
// scope inference are POSIX-normalized in `./name` so the public name does not
// depend on the host OS.
function frontmatter(data: unknown): Frontmatter {
  if (!isRecord(data)) return {}
  const result: Frontmatter = {}
  if (typeof data.description === "string") {
    const description = data.description.trim()
    if (description.length > 0) result.description = description
  }
  if (Array.isArray(data.keywords)) {
    const keywords = data.keywords
      .filter((keyword): keyword is string => typeof keyword === "string")
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length > 0)
    if (keywords.length > 0) result.keywords = keywords
  }
  return result
}

// Missing or invalid frontmatter is not an error: the rule stays in the list
// with its metadata omitted.
const readFrontmatter = Effect.fnUntraced(function* (location: string) {
  return yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(location),
    catch: (error) => error,
  }).pipe(
    Effect.map((doc) => frontmatter(doc.data)),
    Effect.catch((error) =>
      Effect.sync(() => {
        log.warn("failed to parse rule frontmatter", { rule: location, error })
        return {} satisfies Frontmatter
      }),
    ),
  )
})

const scanLayer = Effect.fnUntraced(function* (root: string, source: Info["source"]) {
  const matches = yield* Effect.tryPromise({
    try: () => Glob.scan(RULE_PATTERN, { cwd: root, absolute: true, include: "file", symlink: true }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log.error("failed to scan rules", { dir: root, error })
        return [] as string[]
      }),
    ),
  )

  return yield* Effect.forEach(
    matches,
    (location) =>
      Effect.gen(function* () {
        const name = normalizeRulePath(path.relative(root, location))
        const agentScope = inferAgentScope(name)
        const meta = yield* readFrontmatter(location)
        return {
          name,
          ...meta,
          ...(agentScope ? { agentScope } : {}),
          source,
          location,
        } satisfies Info
      }),
    { concurrency: "unbounded" },
  )
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const state = yield* InstanceState.make(
      Effect.fn("Rule.state")(function* (ctx) {
        // Scan once per instance: global first, then the space layer overrides
        // entries with the same relative path. Non-WopalSpace instances only
        // see the global layer.
        const merged = new Map<string, Info>()
        for (const entry of yield* scanLayer(path.join(global.wopalHome, "rules"), "global")) {
          merged.set(entry.name, entry)
        }
        const spaceRoot = resolveWopalSpaceRoot(ctx.directory)
        if (spaceRoot) {
          const spaceRules = path.join(spaceRoot, ".wopal", "rules")
          for (const entry of yield* scanLayer(spaceRules, "space")) {
            merged.set(entry.name, entry)
          }
        }
        return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
      }),
    )

    const all = Effect.fn("Rule.all")(function* () {
      return yield* InstanceState.get(state)
    })

    return Service.of({ all })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Global.defaultLayer))

export * as Rule from "."
