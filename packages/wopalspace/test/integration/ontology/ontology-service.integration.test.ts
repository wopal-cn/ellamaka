import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as wopalspace from "../../../src"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { ontologyGit } from "../../fixtures/compatibility/ontology"

let parent: string
let fixture: CompatibilityFixture
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "wopalspace-ontology-boundary-"))
})
afterEach(() => {
  fixture?.dispose()
  rmSync(parent, { recursive: true, force: true })
})

describe("Ontology package boundary", () => {
  test("the package exports the domain service and capability kinds only", () => {
    expect(typeof wopalspace.createOntologyService).toBe("function")
    expect(wopalspace.CAPABILITY_KINDS).toEqual(["agents", "skills", "rules", "commands", "plugins"])
    const surface = Object.keys(wopalspace)
    for (const forbidden of ["systemGit", "updateSettingsEntry", "normalizeOntologySource", "githubPullRequestQuery"]) {
      expect(surface).not.toContain(forbidden)
    }
  })

  test("the service composes through the package export against a real local repository", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    const api = wopalspace.createOntologyService({
      host: { wopalHome: fixture.home },
      git: ontologyGit(fixture),
    })
    const listed = await api.list()
    expect(listed.items[0]).toMatchObject({ name: "test-onto", mode: "fork", available: true })
    const inspected = await api.inspect("test-onto")
    expect(inspected.downstream.map((segment) => segment.label)).toEqual([
      "origin/main → local/main",
      "upstream/main → local/main",
    ])
    const capabilities = await api.capabilityList("test-onto")
    expect(capabilities.items).toContainEqual({ kind: "skills", name: "dev-flow", description: "" })
  })

  test("unregistered names, including object prototype keys, fail as NOT_FOUND without touching Git or the filesystem", async () => {
    fixture = createCompatibilityFixture(parent)
    const home = mkdtempSync(join(fixture.root, "empty-home-"))
    const api = wopalspace.createOntologyService({ host: { wopalHome: home }, git: ontologyGit(fixture) })
    for (const name of ["missing", "constructor", "toString", "hasOwnProperty"]) {
      for (const operation of [() => api.inspect(name), () => api.refresh(name), () => api.capabilityList(name)]) {
        await expect(operation()).rejects.toMatchObject({ code: "ONTOLOGY_NOT_FOUND" })
      }
      await expect(api.sync(name, { confirm: false })).rejects.toMatchObject({ code: "ONTOLOGY_NOT_FOUND" })
    }
    expect(existsSync(join(home, "ontologies"))).toBe(false)
  })

  test("a registered path that resolves through a symlink outside the Home is refused", async () => {
    fixture = createCompatibilityFixture(parent)
    const outside = join(fixture.root, "outside-ontology")
    fixture.git(fixture.root, "clone", fixture.upstream, outside)
    rmSync(fixture.ontology, { recursive: true, force: true })
    symlinkSync(outside, fixture.ontology)
    const api = wopalspace.createOntologyService({ host: { wopalHome: fixture.home }, git: ontologyGit(fixture) })
    await expect(api.inspect("test-onto")).rejects.toMatchObject({ code: "ONTOLOGY_PATH_ESCAPE" })
    await expect(api.capabilityList("test-onto")).rejects.toMatchObject({ code: "ONTOLOGY_PATH_ESCAPE" })
    await expect(api.sync("test-onto", { confirm: false })).rejects.toMatchObject({ code: "ONTOLOGY_PATH_ESCAPE" })
  })
})
