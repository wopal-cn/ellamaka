import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import {
  createInstallHome,
  ontologyGit,
  prepareOntologyScenario,
  registryText,
  useGithubShapedFork,
} from "../../fixtures/compatibility/ontology"
import { createOntologyService } from "../../../src/ontology"
import type { PullRequestSnapshot } from "../../../src/ontology/types"

let parent: string
let fixture: CompatibilityFixture
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "wopalspace-ontology-"))
})
afterEach(() => {
  fixture?.dispose()
  rmSync(parent, { recursive: true, force: true })
})

function service(home = fixture.home, pr = { query: async () => [] as readonly PullRequestSnapshot[] }) {
  return createOntologyService({ host: { wopalHome: home }, git: ontologyGit(fixture), pr })
}

describe("Ontology list and inspect are local reads", () => {
  test("list reports registered identity and repository facts without touching Git", async () => {
    fixture = createCompatibilityFixture(parent)
    const before = fixture.snapshot()
    const result = await service().list()
    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      name: "test-onto",
      mode: "clone",
      path: fixture.ontology,
      available: true,
      repo: { readable: true },
    })
    expect(result.items[0]?.spaces.map((space) => space.name)).toEqual(["demo-space"])
    expect(fixture.snapshot()).toEqual(before)
  })

  test("list reports an unreadable registered repository as a diagnostic instead of a summary failure", async () => {
    fixture = createCompatibilityFixture(parent)
    rmSync(fixture.ontology, { recursive: true, force: true })
    const result = await service().list()
    expect(result.items[0]).toMatchObject({
      name: "test-onto",
      available: false,
      repo: { readable: false, diagnostic: expect.stringContaining("not readable") },
    })
  })

  test("inspect reports the fork chain, dirty state and local facts without fetching", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    prepareOntologyScenario(fixture, "dirty")
    const before = fixture.snapshot()
    const result = await service().inspect("test-onto")
    expect(result).toMatchObject({
      name: "test-onto",
      mode: "fork",
      upstreamRepo: fixture.upstream,
      repository: { dirty: true },
    })
    expect(result.downstream.map((segment) => segment.label)).toEqual([
      "origin/main → local/main",
      "upstream/main → local/main",
    ])
    expect(result.upstream.map((segment) => segment.label)).toEqual([
      "local/main → origin/main",
      "origin/main → upstream/main",
    ])
    expect(result.downstream.every((segment) => segment.kind === "merge")).toBe(true)
    expect(result.upstream.every((segment) => segment.kind === "push")).toBe(true)
    expect(fixture.snapshot()).toEqual(before)
  })

  test("inspect predicts a merge conflict without writing objects, refs, index or FETCH_HEAD", async () => {
    fixture = createCompatibilityFixture(parent)
    prepareOntologyScenario(fixture, "conflict")
    fixture.git(fixture.ontology, "fetch", "origin")
    const before = fixture.snapshot()
    const result = await service().inspect("test-onto")
    expect(result.downstream[0]?.mergePrediction).toBe("conflict")
    expect(result.downstream[0]?.conflictFiles).toContain("rules/typescript.md")
    expect(fixture.snapshot()).toEqual(before)
  })

  test("inspect is local-only even when the registered remote is unreachable", async () => {
    fixture = createCompatibilityFixture(parent)
    fixture.git(fixture.ontology, "remote", "set-url", "origin", join(fixture.root, "missing.git"))
    const before = fixture.git(fixture.ontology, "show-ref")
    const result = await service().inspect("test-onto")
    expect(result.mode).toBe("clone")
    expect(fixture.git(fixture.ontology, "show-ref")).toBe(before)
  })
})

describe("Ontology refresh separates Git and contribution PR facts", () => {
  test("refresh reports Git and PR success independently for a clone", async () => {
    fixture = createCompatibilityFixture(parent)
    const beforeObjects = fixture.snapshot().objects
    const result = await service().refresh("test-onto")
    expect(result.git).toMatchObject({ status: "ok", ok: true, remotes: { origin: { status: "ok" } } })
    expect(result.pr).toMatchObject({ status: "ok", ok: true })
    expect(result.contributions).toEqual([])
    expect(result.inspection.downstream).toHaveLength(1)
    expect(fixture.snapshot().objects).toEqual(beforeObjects)
  })

  test("a failed Git refresh still returns readable facts and a distinct PR result", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    prepareOntologyScenario(fixture, "dirty")
    // Keep GitHub identities for the PR lookup while the origin transport fails.
    const forkUrl = "https://github.com/fork-owner/wopal-space-ontology.git"
    const upstreamUrl = "https://github.com/wopal-cn/wopal-space-ontology.git"
    fixture.git(fixture.ontology, "remote", "set-url", "origin", forkUrl)
    fixture.git(fixture.ontology, "config", "url." + join(fixture.root, "missing.git") + ".insteadOf", forkUrl)
    fixture.git(fixture.ontology, "remote", "set-url", "upstream", upstreamUrl)
    fixture.git(fixture.ontology, "config", "url." + fixture.upstream + ".insteadOf", upstreamUrl)
    const result = await service().refresh("test-onto")
    expect(result.git).toMatchObject({ status: "failed", ok: false })
    expect(result.git.error?.code).toBe("ONTOLOGY_REFRESH_FAILED")
    // The injected adapter still answers, so the PR half is independent of the Git failure.
    expect(result.pr).toMatchObject({ status: "ok", ok: true })
    expect(result.contributions.map((entry) => entry.prLookup)).toContain("missing")
    expect(result.contributions).toContainEqual(expect.objectContaining({ branch: "contribute/topic" }))
    expect(result.inspection.repository.dirty).toBe(true)
  })

  test("refresh unions local, origin and worktree contribution branches and looks up a real PR identity", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    useGithubShapedFork(fixture, "fork-owner/wopal-space-ontology")
    fixture.git(
      fixture.ontology,
      "remote",
      "set-url",
      "upstream",
      "https://github.com/wopal-cn/wopal-space-ontology.git",
    )
    fixture.git(
      fixture.ontology,
      "config",
      "url." + fixture.upstream + ".insteadOf",
      "https://github.com/wopal-cn/wopal-space-ontology.git",
    )
    fixture.git(fixture.ontology, "push", "origin", "main:contribute/remote-only")
    fixture.git(fixture.ontology, "push", "origin", "main:contribute/both")
    fixture.git(fixture.ontology, "branch", "contribute/both")
    fixture.git(fixture.ontology, "branch", "contribute/local-only")
    const worktree = join(fixture.root, "contribution-worktree")
    fixture.git(fixture.ontology, "worktree", "add", "-b", "contribute/occupied", worktree, "main")
    const queried: string[] = []
    const remoteHead = fixture.git(fixture.ontology, "rev-parse", "origin/contribute/both")
    const api = createOntologyService({
      host: { wopalHome: fixture.home },
      git: ontologyGit(fixture),
      pr: {
        query: async (input) => {
          queried.push(input.upstreamRepo + " " + input.headFork + " " + input.headBranch + " " + input.baseBranch)
          if (input.headBranch === "contribute/both") {
            return [
              {
                number: 7,
                url: "https://github.com/wopal-cn/wopal-space-ontology/pull/7",
                state: "merged",
                baseBranch: "main",
                headBranch: "contribute/both",
                headFork: "fork-owner/wopal-space-ontology",
                headSha: remoteHead,
              },
              {
                number: 99,
                url: "https://github.com/wopal-cn/wopal-space-ontology/pull/99",
                state: "open",
                baseBranch: "main",
                headBranch: "contribute/both",
                headFork: "another-owner/wopal-space-ontology",
              },
            ]
          }
          return []
        },
      },
    })
    const result = await api.refresh("test-onto")
    expect(result.git).toMatchObject({ status: "ok", ok: true })
    expect(result.pr).toMatchObject({ status: "ok", ok: true })
    expect(result.contributions.map((entry) => [entry.branch, entry.origins])).toEqual([
      ["contribute/both", ["local", "remote"]],
      ["contribute/local-only", ["local"]],
      ["contribute/occupied", ["local"]],
      ["contribute/remote-only", ["remote"]],
    ])
    const both = result.contributions.find((entry) => entry.branch === "contribute/both")!
    expect(both).toMatchObject({ prLookup: "found", pr: { number: 7, state: "merged", headMatchesBranch: true } })
    expect(result.contributions.find((entry) => entry.branch === "contribute/local-only")!.prLookup).toBe("missing")
    expect(queried).toContain("wopal-cn/wopal-space-ontology fork-owner/wopal-space-ontology contribute/both main")
  })

  test("refresh distinguishes PR query failure from missing and ambiguous matches", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    useGithubShapedFork(fixture, "fork-owner/wopal-space-ontology")
    fixture.git(
      fixture.ontology,
      "remote",
      "set-url",
      "upstream",
      "https://github.com/wopal-cn/wopal-space-ontology.git",
    )
    fixture.git(
      fixture.ontology,
      "config",
      "url." + fixture.upstream + ".insteadOf",
      "https://github.com/wopal-cn/wopal-space-ontology.git",
    )
    fixture.git(fixture.ontology, "branch", "contribute/topic")
    const failing = await createOntologyService({
      host: { wopalHome: fixture.home },
      git: ontologyGit(fixture),
      pr: {
        query: async () => {
          throw new Error("gh is not authenticated")
        },
      },
    }).refresh("test-onto")
    expect(failing.git.status).toBe("ok")
    expect(failing.pr.status).toBe("failed")
    expect(failing.contributions[0]).toMatchObject({
      branch: "contribute/topic",
      prLookup: "failed",
      diagnostic: expect.stringContaining("pull request query failed"),
    })

    const ambiguous = await createOntologyService({
      host: { wopalHome: fixture.home },
      git: ontologyGit(fixture),
      pr: {
        query: async () => [
          {
            number: 1,
            url: "https://github.com/wopal-cn/wopal-space-ontology/pull/1",
            state: "open",
            baseBranch: "main",
            headBranch: "contribute/topic",
            headFork: "fork-owner/wopal-space-ontology",
          },
          {
            number: 2,
            url: "https://github.com/wopal-cn/wopal-space-ontology/pull/2",
            state: "closed",
            baseBranch: "main",
            headBranch: "contribute/topic",
            headFork: "fork-owner/wopal-space-ontology",
          },
        ],
      },
    }).refresh("test-onto")
    expect(ambiguous.contributions[0]).toMatchObject({
      prLookup: "failed",
      diagnostic: expect.stringMatching(/ambiguous/i),
    })
  })

  test("refresh keeps contribution facts in-memory and writes no contribution record", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    fixture.git(fixture.ontology, "branch", "contribute/topic")
    const homeEntries = () => readdirSync(fixture.home).sort()
    const before = { registry: registryText(fixture), entries: homeEntries() }
    await service().refresh("test-onto")
    expect({ registry: registryText(fixture), entries: homeEntries() }).toEqual(before)
  })

  test("refresh reports an unavailable contribution identity instead of pretending the lookup succeeded", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    fixture.git(fixture.ontology, "branch", "contribute/topic")
    // Local bare remotes carry no GitHub identity, so no PR query is attempted.
    const api = createOntologyService({ host: { wopalHome: fixture.home }, git: ontologyGit(fixture) })
    const result = await api.refresh("test-onto")
    expect(result.git.status).toBe("ok")
    expect(result.pr.ok).toBe(false)
    expect(result.pr.error?.code).toBe("ONTOLOGY_PR_QUERY_FAILED")
    expect(result.contributions[0]).toMatchObject({
      branch: "contribute/topic",
      prLookup: "failed",
      diagnostic: expect.stringContaining("identity is unavailable"),
    })
  })
})

describe("Ontology install registers only a validated repository", () => {
  test("a default source is normalized before Git sees it", async () => {
    fixture = createCompatibilityFixture(parent)
    const install = createInstallHome(fixture)
    await expect(service(install.home).install({ name: "onto", source: "../escape" })).rejects.toMatchObject({
      code: "ONTOLOGY_SOURCE_INVALID",
    })
    expect(JSON.parse(registryText(fixture, install.home)).ontologies).toEqual({})
  })

  test("clone creates, validates assembly, registers, and then reuses the same identity", async () => {
    fixture = createCompatibilityFixture(parent)
    const install = createInstallHome(fixture)
    const api = service(install.home)
    const created = await api.install({ name: "onto", source: install.source })
    expect(created).toMatchObject({ name: "onto", status: "created", mode: "clone", upstream: install.source })
    expect(fixture.git(created.path, "remote", "get-url", "origin")).toBe(install.source)
    expect(registryText(fixture, install.home)).toContain('"onto"')
    expect(await api.install({ name: "onto", source: install.source })).toMatchObject({
      status: "reused",
      path: created.path,
    })
    expect((await api.list()).items[0]).toMatchObject({ name: "onto", available: true })
  })

  test("fork install clones the fork, records upstream, and upgrades an existing clone", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    const install = createInstallHome(fixture, "upstream")
    const forkSource = "https://github.com/fork-owner/wopal-space-ontology.git"
    const forkFetcher = new URL("file://" + fixture.origin).href
    const api = createOntologyService({
      host: { wopalHome: install.home },
      git: (cwd, args, env) =>
        ontologyGit(fixture)(cwd, ["-c", "url." + fixture.origin + ".insteadOf=" + forkSource, ...args], env),
      fork: { ensure: async () => forkSource },
      pr: { query: async () => [] },
    })
    expect(forkFetcher).toBeDefined()
    const fork = await api.install({ name: "forked", source: install.source, mode: "fork" })
    expect(fork).toMatchObject({ status: "created", mode: "fork", upstream: install.source })
    expect(fixture.git(fork.path, "remote", "get-url", "origin")).toBe(forkSource)
    expect(fixture.git(fork.path, "remote", "get-url", "upstream")).toBe(install.source)

    const cloneHome = createInstallHome(fixture, "origin")
    const cloneApi = createOntologyService({
      host: { wopalHome: cloneHome.home },
      git: (cwd, args, env) =>
        ontologyGit(fixture)(cwd, ["-c", "url." + fixture.origin + ".insteadOf=" + forkSource, ...args], env),
      fork: { ensure: async () => forkSource },
      pr: { query: async () => [] },
    })
    const clone = await cloneApi.install({ name: "onto", source: cloneHome.source })
    expect(clone.mode).toBe("clone")
    const upgraded = await cloneApi.install({ name: "onto", source: cloneHome.source, mode: "fork" })
    expect(upgraded).toMatchObject({ status: "upgraded", mode: "fork" })
    expect(fixture.git(clone.path, "remote", "get-url", "upstream")).toBe(cloneHome.source)
  })

  test("rejects a source or topology conflict before rewriting the registration", async () => {
    fixture = createCompatibilityFixture(parent)
    const install = createInstallHome(fixture)
    const api = service(install.home)
    const created = await api.install({ name: "onto", source: install.source })
    const before = registryText(fixture, install.home)
    await expect(api.install({ name: "onto", source: "https://github.com/another/ontology" })).rejects.toMatchObject({
      code: "ONTOLOGY_SOURCE_CONFLICT",
    })
    expect(registryText(fixture, install.home)).toBe(before)
    expect(created.status).toBe("created")
  })

  test("rejects a target whose assembly is missing and leaves no registration", async () => {
    fixture = createCompatibilityFixture(parent)
    const install = createInstallHome(fixture, "origin")
    const empty = join(fixture.root, "empty-source")
    fixture.git(fixture.root, "init", "-q", "-b", "main", empty)
    fixture.write(empty, "README.md", "# not an ontology\n")
    fixture.git(empty, "add", ".")
    fixture.git(empty, "commit", "-qm", "empty")
    const bare = join(fixture.root, "empty.git")
    fixture.git(fixture.root, "clone", "--bare", empty, bare)
    await expect(
      service(install.home).install({ name: "broken", source: new URL("file://" + bare).href }),
    ).rejects.toMatchObject({ code: "ONTOLOGY_ASSEMBLY_INVALID" })
    expect(registryText(fixture, install.home)).not.toContain("broken")
  })

  test("rejects an existing repository whose history is unrelated to the requested source", async () => {
    fixture = createCompatibilityFixture(parent)
    const install = createInstallHome(fixture)
    const target = join(install.home, "ontologies", "onto")
    fixture.git(fixture.root, "init", "-q", "-b", "main", target)
    fixture.write(target, "assembly/archetypes/coding.yaml", "version: 1\n")

    fixture.git(target, "add", ".")
    fixture.git(target, "commit", "-qm", "unrelated history")
    fixture.git(target, "remote", "add", "origin", install.source)
    fixture.git(target, "fetch", "origin")
    const before = registryText(fixture, install.home)
    await expect(service(install.home).install({ name: "onto", source: install.source })).rejects.toMatchObject({
      code: "ONTOLOGY_HISTORY_CONFLICT",
    })
    expect(registryText(fixture, install.home)).toBe(before)
  })

  test("rejects malformed, traversal, absolute and symlinked names", async () => {
    fixture = createCompatibilityFixture(parent)
    const api = service()
    for (const name of ["../escape", "/absolute", "a/b", ".", ".."]) {
      await expect(api.inspect(name)).rejects.toMatchObject({ code: "ONTOLOGY_NAME_INVALID" })
    }
    await expect(api.inspect("../../test-onto")).rejects.toMatchObject({ code: "ONTOLOGY_NAME_INVALID" })
  })

  test("registry writes preserve comments and unknown settings", async () => {
    fixture = createCompatibilityFixture(parent)
    const home = mkdtempSync(join(fixture.root, "comment-home-"))
    const config = join(home, "config")
    const { mkdirSync, writeFileSync, readFileSync } = require("node:fs")
    mkdirSync(config, { recursive: true })
    writeFileSync(
      join(config, "settings.jsonc"),
      [
        "{",
        "  // preserve me",
        '  "wopal": { "dsh": { "web": { "enabled": true } } },',
        '  "ontologies": {}',
        "}",
      ].join("\n"),
    )
    const source = new URL("file://" + fixture.origin).href
    await service(home).install({ name: "onto", source })
    const text = readFileSync(join(config, "settings.jsonc"), "utf8")
    expect(text).toContain("// preserve me")
    expect(text).toContain('"wopal"')
    expect(text).toContain('"onto"')
  })
})

describe("Ontology capability.list reads the registered pool", () => {
  test("returns all five kinds with the existing description fallbacks", async () => {
    fixture = createCompatibilityFixture(parent)
    fixture.write(fixture.ontology, "agents/wopal.md", "---\ndescription: The wopal agent\n---\n# wopal\n")
    fixture.write(fixture.ontology, "agents/no-frontmatter.md", "# fae\n")
    fixture.write(fixture.ontology, "skills/demo/SKILL.md", "---\ndescription: Demo skill\n---\n# demo\n")
    fixture.write(fixture.ontology, "skills/sourced/.source.json", '{"description":"Browser automation"}\n')
    fixture.write(fixture.ontology, "skills/plain/README.md", "# Plain\nFirst paragraph.\n")
    fixture.write(fixture.ontology, "plugins/wopal-plugin/package.json", '{"description":"Runtime plugin"}\n')
    fixture.write(fixture.ontology, "rules/typescript.md", "---\ndescription: TypeScript conventions\n---\n")
    fixture.write(fixture.ontology, "commands/init.md", "---\ndescription: First-run bootstrap\n---\n")
    fixture.write(fixture.ontology, "commands/no-extension", "# plain\n")
    fixture.git(fixture.ontology, "add", ".")
    fixture.git(fixture.ontology, "commit", "-qm", "capabilities")
    const before = fixture.snapshot()
    const api = service()
    const result = await api.capabilityList("test-onto")
    expect(new Set(result.items.map((item) => item.kind))).toEqual(
      new Set(["agents", "skills", "rules", "commands", "plugins"]),
    )
    const find = (kind: string, name: string) => result.items.find((item) => item.kind === kind && item.name === name)!
    expect(find("agents", "wopal.md").description).toBe("The wopal agent")
    expect(find("agents", "no-frontmatter.md").description).toBe("")
    expect(find("skills", "demo").description).toBe("Demo skill")
    expect(find("skills", "sourced").description).toBe("Browser automation")
    expect(find("skills", "plain").description).toBe("First paragraph.")
    expect(find("rules", "typescript.md").description).toBe("TypeScript conventions")
    expect(find("commands", "init.md").description).toBe("First-run bootstrap")
    expect(find("commands", "no-extension.noext").name).toBe("no-extension.noext")
    expect(find("plugins", "wopal-plugin").description).toBe("Runtime plugin")
    expect(result.total).toBe(result.items.length)
    expect(fixture.snapshot()).toEqual(before)
  })

  test("filters to one kind and rejects an unknown kind", async () => {
    fixture = createCompatibilityFixture(parent)
    const api = service()
    const skills = await api.capabilityList("test-onto", { kind: "skills" })
    expect(skills.items.length).toBe(1)
    expect(skills.items.every((item) => item.kind === "skills")).toBe(true)
    await expect(api.capabilityList("test-onto", { kind: "nope" })).rejects.toMatchObject({
      code: "ONTOLOGY_CAPABILITY_KIND_INVALID",
    })
  })

  test("rejects a path-shaped name before reading the pool", async () => {
    fixture = createCompatibilityFixture(parent)
    await expect(service().capabilityList("../test-onto")).rejects.toMatchObject({ code: "ONTOLOGY_NAME_INVALID" })
  })
})
