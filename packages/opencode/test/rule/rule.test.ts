import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Global } from "@wopal/ellamaka-core/global"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Rule } from "../../src/rule"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer))

const ruleLayer = (wopalHome: string) => Rule.layer.pipe(Layer.provide(Global.layerWith({ wopalHome })))

async function writeRule(root: string, relative: string, content: string) {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function markWopalSpace(root: string) {
  await fs.mkdir(path.join(root, ".wopal"), { recursive: true })
  await fs.writeFile(path.join(root, ".wopal", ".git"), "")
}

const allRules = (wopalHome: string, directory: string) =>
  Effect.gen(function* () {
    const rule = yield* Rule.Service
    return yield* rule.all()
  }).pipe(provideInstance(directory), Effect.provide(ruleLayer(wopalHome)))

describe("rule discovery", () => {
  it.live("merges the global and space layers, space overrides global by relative path", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const space = yield* tmpdirScoped()

      yield* Effect.promise(async () => {
        await markWopalSpace(space)
        await writeRule(
          home,
          "rules/typescript.md",
          "---\ndescription: TypeScript rules\nkeywords:\n  - ts\n  - types\n---\nbody\n",
        )
        await writeRule(home, "rules/shared.mdc", "---\ndescription: Global shared\n---\n")
        await writeRule(home, "rules/global-only.mdc", "---\ndescription: Global only\n---\n")
        await writeRule(home, "rules/fae/astro.md", "---\ndescription: Astro for fae\n---\n")
        await writeRule(home, "rules/deep/nested/notes.md", "---\ndescription: Deep\n---\n")
        await writeRule(space, ".wopal/rules/shared.mdc", "---\ndescription: Space shared\n---\n")
        await writeRule(space, ".wopal/rules/space-only.md", "---\ndescription: Space only\n---\n")
        await writeRule(space, ".wopal/rules/wopal/mem.md", "---\ndescription: Space agent rule\n---\n")
      })

      const list = yield* allRules(home, space)

      expect(list.map((rule) => rule.name)).toEqual([
        "deep/nested/notes.md",
        "fae/astro.md",
        "global-only.mdc",
        "shared.mdc",
        "space-only.md",
        "typescript.md",
        "wopal/mem.md",
      ])

      const byName = new Map(list.map((rule) => [rule.name, rule]))
      expect(byName.get("typescript.md")).toMatchObject({
        name: "typescript.md",
        description: "TypeScript rules",
        keywords: ["ts", "types"],
        source: "global",
        location: path.join(home, "rules", "typescript.md"),
      })
      expect(byName.get("typescript.md")?.agentScope).toBeUndefined()

      // Same relative path in both layers: the space entry wins and carries the space location.
      expect(byName.get("shared.mdc")).toMatchObject({
        description: "Space shared",
        source: "space",
        location: path.join(space, ".wopal", "rules", "shared.mdc"),
      })

      // `.mdc` files are discovered alongside `.md` files in both layers.
      expect(byName.get("global-only.mdc")).toMatchObject({ source: "global" })
      expect(byName.get("space-only.md")).toMatchObject({ source: "space" })

      // A single-level subdirectory is the agent scope; deeper paths are not.
      expect(byName.get("fae/astro.md")).toMatchObject({ agentScope: "fae", source: "global" })
      expect(byName.get("wopal/mem.md")).toMatchObject({ agentScope: "wopal", source: "space" })
      expect(byName.get("deep/nested/notes.md")?.agentScope).toBeUndefined()
    }),
  )

  it.live("resolves the space layer from a nested instance directory", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const space = yield* tmpdirScoped()
      const nested = path.join(space, "projects", "demo")

      yield* Effect.promise(async () => {
        await markWopalSpace(space)
        await writeRule(space, ".wopal/rules/space.md", "---\ndescription: Space\n---\n")
        await fs.mkdir(nested, { recursive: true })
      })

      const list = yield* allRules(home, nested)

      expect(list.map((rule) => rule.name)).toEqual(["space.md"])
      expect(list[0]?.source).toBe("space")
    }),
  )

  it.live("only scans the global layer for non-WopalSpace instances", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped()

      yield* Effect.promise(async () => {
        await writeRule(home, "rules/global.md", "---\ndescription: Global\n---\n")
        // A rules directory without the `.wopal/.git` space marker must not be scanned.
        await writeRule(dir, ".wopal/rules/local.md", "---\ndescription: Local\n---\n")
      })

      const list = yield* allRules(home, dir)

      expect(list.map((rule) => rule.name)).toEqual(["global.md"])
      expect(list[0]?.source).toBe("global")
    }),
  )

  it.live("keeps rules with missing or invalid frontmatter, with metadata omitted", () =>
    Effect.gen(function* () {
      const home = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped()

      yield* Effect.promise(async () => {
        await writeRule(home, "rules/no-frontmatter.md", "# plain markdown\n\nbody\n")
        await writeRule(home, "rules/broken.md", "---\ndescription: [unclosed\n---\nbody\n")
        await writeRule(home, "rules/empty-frontmatter.mdc", "---\n---\nbody\n")
      })

      const list = yield* allRules(home, dir)

      expect(list.map((rule) => rule.name)).toEqual(["broken.md", "empty-frontmatter.mdc", "no-frontmatter.md"])
      for (const rule of list) {
        expect(rule.description).toBeUndefined()
        expect(rule.keywords).toBeUndefined()
        expect(rule.source).toBe("global")
      }
    }),
  )
})
