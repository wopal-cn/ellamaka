import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOntologyService } from "../../../src/ontology"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { createInstallHome, ontologyGit, useGithubShapedFork } from "../../fixtures/compatibility/ontology"

const FAKE_USER = "fake-redaction-user"
const FAKE_PASSWORD = "fake-redaction-password-not-a-real-token"
const FAKE_BEARER = "fake-redaction-bearer-not-a-real-token"
const FAKE_KEY = "fake-redaction-api-key-not-a-real-token"

let parent: string
let fixture: CompatibilityFixture

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "wopalspace-ontology-redaction-"))
})

describe("Ontology fork upgrade validates the existing repository before mutation", () => {
  for (const scenario of ["unrelated-history", "invalid-assembly"] as const) {
    test(scenario + " is rejected without invoking the fork provisioner or changing remotes or registry", async () => {
      fixture = createCompatibilityFixture(parent)
      const install = createInstallHome(fixture)
      const target = join(install.home, "ontologies", "onto")
      fixture.git(fixture.root, "init", "-q", "-b", "main", target)
      fixture.write(
        target,
        scenario === "invalid-assembly" ? "README.md" : "assembly/archetypes/coding.yaml",
        scenario === "invalid-assembly" ? "# missing assembly\n" : "version: 1\n",
      )
      fixture.git(target, "add", ".")
      fixture.git(target, "commit", "-qm", scenario)
      fixture.git(target, "remote", "add", "origin", install.source)
      fixture.git(target, "fetch", "origin")
      fixture.write(
        install.home,
        "config/settings.jsonc",
        JSON.stringify(
          {
            ontologies: {
              onto: { path: target, upstream: install.source, origin: install.source, fork: false },
            },
            spaces: {},
          },
          null,
          2,
        ) + "\n",
      )
      const remoteConfig = readFileSync(join(target, ".git/config"))
      const registry = registryBytes(install.home)
      let provisioned = 0
      const api = createOntologyService({
        host: { wopalHome: install.home },
        git: ontologyGit(fixture),
        fork: {
          ensure: async () => {
            provisioned += 1
            return install.source
          },
        },
      })
      await expect(api.install({ name: "onto", source: install.source, mode: "fork" })).rejects.toMatchObject({
        code: scenario === "invalid-assembly" ? "ONTOLOGY_ASSEMBLY_INVALID" : "ONTOLOGY_HISTORY_CONFLICT",
      })
      expect(provisioned).toBe(0)
      expect(readFileSync(join(target, ".git/config"))).toEqual(remoteConfig)
      expect(registryBytes(install.home)).toEqual(registry)
    })
  }
})

afterEach(() => {
  fixture?.dispose()
  rmSync(parent, { recursive: true, force: true })
})

function withCredentials(host: string, secret = FAKE_PASSWORD): string {
  return "https://" + FAKE_USER + ":" + secret + "@" + host
}

function expectNoFakeCredential(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(FAKE_USER)
  expect(serialized).not.toContain(FAKE_PASSWORD)
  expect(serialized).not.toContain(FAKE_BEARER)
  expect(serialized).not.toContain(FAKE_KEY)
}

function registryBytes(home: string): Buffer {
  return readFileSync(join(home, "config/settings.jsonc"))
}

describe("Ontology public results redact legacy credentials", () => {
  test("list removes credentials from registry remotes while keeping ordinary URL identity", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    const forkUrl = withCredentials("github.com/fork-owner/wopal-space-ontology.git")
    const upstreamUrl = withCredentials("github.com/wopal-cn/wopal-space-ontology.git", FAKE_BEARER)
    // Leave the registered origin as the only source of the fork URL for this read.
    fixture.git(fixture.ontology, "remote", "remove", "origin")
    fixture.write(
      fixture.home,
      "config/settings.jsonc",
      JSON.stringify(
        {
          ontologies: {
            "test-onto": {
              path: fixture.ontology,
              upstream: upstreamUrl,
              origin: forkUrl,
              fork: true,
            },
          },
          spaces: {},
        },
        null,
        2,
      ) + "\n",
    )
    const before = registryBytes(fixture.home)
    const result = await createOntologyService({
      host: { wopalHome: fixture.home },
      git: ontologyGit(fixture),
    }).list()
    expectNoFakeCredential(result)
    expect(result.items[0]).toMatchObject({
      name: "test-onto",
      mode: "fork",
      remote: "https://github.com/fork-owner/wopal-space-ontology.git",
      upstream: "https://github.com/wopal-cn/wopal-space-ontology.git",
      available: true,
    })
    expect(registryBytes(fixture.home)).toEqual(before)
  })

  test("inspect removes credentials from all remote slots without changing the registry", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    const forkUrl = withCredentials("github.com/fork-owner/wopal-space-ontology.git")
    const upstreamUrl = withCredentials("github.com/wopal-cn/wopal-space-ontology.git", FAKE_KEY)
    // Keep the fixture's local remotes so inspect performs no network I/O.
    fixture.git(fixture.ontology, "remote", "set-url", "origin", forkUrl)
    fixture.git(fixture.ontology, "remote", "set-url", "upstream", upstreamUrl)
    fixture.git(fixture.ontology, "config", "url." + fixture.origin + ".insteadOf", forkUrl)
    fixture.git(fixture.ontology, "config", "url." + fixture.upstream + ".insteadOf", upstreamUrl)
    fixture.write(
      fixture.home,
      "config/settings.jsonc",
      JSON.stringify(
        {
          ontologies: {
            "test-onto": {
              path: fixture.ontology,
              upstream: upstreamUrl,
              origin: forkUrl,
              fork: true,
            },
          },
          spaces: {},
        },
        null,
        2,
      ) + "\n",
    )
    const before = registryBytes(fixture.home)
    const result = await createOntologyService({
      host: { wopalHome: fixture.home },
      git: ontologyGit(fixture),
    }).inspect("test-onto")
    expectNoFakeCredential(result)
    expect(result).toMatchObject({
      remote: "https://github.com/fork-owner/wopal-space-ontology.git",
      remoteRepo: "https://github.com/fork-owner/wopal-space-ontology.git",
      upstreamRepo: "https://github.com/wopal-cn/wopal-space-ontology.git",
    })
    expect(registryBytes(fixture.home)).toEqual(before)
  })

  test("a failed list item does not expose a credential-bearing registry remote", async () => {
    fixture = createCompatibilityFixture(parent)
    const forkUrl = withCredentials("github.com/fork-owner/wopal-space-ontology.git")
    const upstreamUrl = withCredentials("github.com/wopal-cn/wopal-space-ontology.git")
    fixture.write(
      fixture.home,
      "config/settings.jsonc",
      JSON.stringify(
        {
          ontologies: {
            "test-onto": {
              path: join(fixture.root, "outside-ontology"),
              upstream: upstreamUrl,
              origin: forkUrl,
              fork: true,
            },
          },
          spaces: {},
        },
        null,
        2,
      ) + "\n",
    )
    const before = registryBytes(fixture.home)
    const result = await createOntologyService({
      host: { wopalHome: fixture.home },
      git: ontologyGit(fixture),
    }).list()
    expectNoFakeCredential(result)
    expect(result.items[0]).toMatchObject({
      name: "test-onto",
      mode: "fork",
      available: false,
      remote: "https://github.com/fork-owner/wopal-space-ontology.git",
      upstream: "https://github.com/wopal-cn/wopal-space-ontology.git",
      repo: { diagnostic: expect.stringContaining("outside the ontology root") },
    })
    expect(registryBytes(fixture.home)).toEqual(before)
  })

  test("refresh redacts fetch error metadata from diagnostics, remote errors and public error", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    useGithubShapedFork(fixture, "fork-owner/wopal-space-ontology")
    fixture.git(
      fixture.ontology,
      "remote",
      "set-url",
      "upstream",
      "https://github.com/wopal-cn/wopal-space-ontology.git",
    )
    fixture.write(
      fixture.home,
      "config/settings.jsonc",
      JSON.stringify(
        {
          ontologies: {
            "test-onto": {
              path: fixture.ontology,
              upstream: withCredentials("github.com/wopal-cn/wopal-space-ontology.git"),
              origin: withCredentials("github.com/fork-owner/wopal-space-ontology.git"),
              fork: true,
            },
          },
          spaces: {},
        },
        null,
        2,
      ) + "\n",
    )
    const before = registryBytes(fixture.home)
    const realGit = ontologyGit(fixture)
    const cause = new Error("connect failed with Bearer " + FAKE_BEARER)
    const git = (cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv) => {
      if (args[0] === "fetch" && args.at(-1) === "upstream") {
        const error = new Error(
          "fatal: unable to access 'https://" +
            FAKE_USER +
            ":" +
            FAKE_PASSWORD +
            "@github.invalid/upstream.git': request failed (api key=" +
            FAKE_KEY +
            ")",
          { cause },
        )
        throw error
      }
      return realGit(cwd, args, env)
    }
    const result = await createOntologyService({
      host: { wopalHome: fixture.home },
      git,
      pr: { query: async () => [] },
    }).refresh("test-onto")
    expect(result.git).toMatchObject({ status: "failed", ok: false })
    expect(result.git.remotes.upstream).toMatchObject({ status: "failed" })
    expectNoFakeCredential(result)
    expect(result.git.remotes.upstream?.error).toContain("github.invalid/upstream.git")
    expect(result.git.remotes.upstream?.error).toContain("request failed")
    expect(result.git.error?.message).toBe("Remote Git refresh failed for 1 remote(s); local facts are shown.")
    expect(registryBytes(fixture.home)).toEqual(before)
  })
})
