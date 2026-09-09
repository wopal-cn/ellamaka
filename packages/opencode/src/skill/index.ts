import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@wopal/ellamaka-core/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@wopal/ellamaka-core/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { Glob } from "@wopal/ellamaka-core/util/glob"
import * as Log from "@wopal/ellamaka-core/util/log"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"

const log = Log.create({ service: "skill" })
const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
  spaceDir: string | undefined
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
  skills: Record<string, Info>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

const parseSkill = Effect.fnUntraced(function* (match: string, bus: Bus.Interface, state?: ScanState) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return undefined

  if (!isSkillFrontmatter(md.data)) return

  if (state) {
    if (state.skills[md.data.name]) {
      log.warn("duplicate skill name", {
        name: md.data.name,
        existing: state.skills[md.data.name].location,
        duplicate: match,
      })
    }

    state.dirs.add(path.dirname(match))
    state.skills[md.data.name] = {
      name: md.data.name,
      description: md.data.description,
      location: match,
      content: md.content,
    }
    return
  }

  return {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  bus: Bus.Interface,
  spaceDir: string | undefined,
) {
  const parsed = yield* Effect.forEach(discovered.matches, (match) => parseSkill(match, bus), {
    concurrency: "unbounded",
  })

  // Group duplicates per skill name so we emit one structured summary line
  // instead of N flood-style WARN entries. Within each group, the winner is:
  //   - in wopal-space mode: the entry whose location is under spaceDir
  //   - otherwise: the last-scanned entry (preserves legacy override order)
  // Non-winner duplicates are dropped after being recorded in the summary.
  const byName = new Map<string, Info[]>()
  for (const info of parsed) {
    if (!info) continue
    state.dirs.add(path.dirname(info.location))
    const list = byName.get(info.name)
    if (list) list.push(info)
    else byName.set(info.name, [info])
  }

  const duplicates: Array<{ name: string; winner: string; dropped: string[] }> = []
  for (const infos of byName.values()) {
    let winner: Info
    if (spaceDir && infos.length > 1) {
      const spaceIdx = infos.findIndex((i) => i.location.startsWith(spaceDir + path.sep))
      winner = spaceIdx >= 0 ? infos[spaceIdx] : infos[infos.length - 1]
    } else {
      winner = infos[infos.length - 1]
    }
    state.skills[winner.name] = winner
    if (infos.length > 1) {
      duplicates.push({
        name: winner.name,
        winner: winner.location,
        dropped: infos.filter((i) => i !== winner).map((i) => i.location),
      })
    }
  }

  if (duplicates.length > 0) {
    log.warn("duplicate skills resolved", {
      spaceDir: spaceDir ?? "(none)",
      count: duplicates.length,
      details: duplicates,
    })
  }
  log.info("init", { count: Object.keys(state.skills).length })
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: AppFileSystem.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  disableAgentsSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set(), skills: {} }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    if (!disableAgentsSkills) externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      const dirName = path.basename(root)
      const disabled =
        dirName === ".claude"
          ? disableClaudeCodeSkills
          : dirName === ".agents"
            ? disableAgentsSkills
            : false
      if (disabled) continue

      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  // Determine the space directory so loadSkills can enforce "space skills win"
  // as an explicit priority, not a scan-order side effect. Only meaningful in
  // wopal-space mode (isWopalSpace=true); spaceDir is the <spaceRoot>/.wopal
  // member of configDirs, identified as the configDir that is NOT under
  // Global.Path.wopalHome and NOT Global.Path.config.
  let spaceDir: string | undefined
  const isWopalSpace = yield* config.isWopalSpace()
  if (isWopalSpace) {
    for (const dir of configDirs) {
      const underHomeWopal = dir === global.wopalHome || dir.startsWith(global.wopalHome + path.sep)
      const isConfig = dir === global.config
      if (!underHomeWopal && !isConfig) {
        spaceDir = dir
        break
      }
    }
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      log.warn("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
    spaceDir,
  }
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        // RuntimeFlags reads WOPAL_SPACE env at layer init time, but the
        // Desktop sidecar sets that env only inside config-layer detection
        // (loadWopalSpaceSettingsFiles) — which can run AFTER RuntimeFlags
        // has already snapshotted false. Config.isWopalSpace() is the
        // runtime-authoritative check, so honor it as an additional
        // disable trigger for .claude/ skills. .agents/ stays enabled (it
        // is an industry-standard dir loaded in all modes).
        const isWopalSpace = yield* config.isWopalSpace()
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills || isWopalSpace,
          flags.disableAgentsSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        yield* loadSkills(s, yield* InstanceState.get(discovered), bus, (yield* InstanceState.get(discovered)).spaceDir)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, require, all, dirs, available })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."