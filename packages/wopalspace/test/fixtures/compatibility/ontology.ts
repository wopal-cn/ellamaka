import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { GitRunner } from "../../../src/ontology/types"
import type { CompatibilityFixture } from "./git-space"

/**
 * Real Git boundary for the service under test. It reuses the shared
 * fixture environment so commits the service creates (merge commits) never
 * depend on the developer's global Git configuration, and local bare
 * remotes keep working through file:// transport.
 */
export function ontologyGit(fixture: CompatibilityFixture): GitRunner {
  return (cwd, args, env) =>
    execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
      env: env ?? fixture.env,
    }).trim()
}

/**
 * Local-only ontology scenarios layered on the shared compatibility
 * fixture: no second Git/Home environment is constructed here.
 */
export function prepareOntologyScenario(
  fixture: CompatibilityFixture,
  scenario: "synced" | "dirty" | "behind" | "conflict",
) {
  fixture.git(fixture.ontology, "branch", "contribute/topic")
  if (scenario === "dirty") {
    fixture.write(fixture.ontology, "rules/typescript.md", "# local dirty edit\n")
  }
  if (scenario === "behind" || scenario === "conflict") {
    fixture.commit(fixture.ontology, "rules/typescript.md", "# " + scenario + " incoming\n", "feat: " + scenario)
    fixture.git(fixture.ontology, "push", "origin", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
  }
  if (scenario === "conflict") {
    fixture.commit(fixture.ontology, "rules/typescript.md", "# local conflict\n", "feat: local conflict")
  }
  return { ontologyPath: fixture.ontology, name: "test-onto" }
}

export interface InstallHome {
  readonly home: string
  readonly source: string
}

/** A fresh registered Home plus a file:// source that resolves to the shared fixture remote. */
export function createInstallHome(
  fixture: CompatibilityFixture,
  remote: "origin" | "upstream" = "origin",
): InstallHome {
  const home = mkdtempSync(join(fixture.root, "install-home-"))
  mkdirSync(join(home, "config"), { recursive: true })
  writeFileSync(join(home, "config", "settings.jsonc"), '{ "ontologies": {} }\n')
  return { home, source: pathToFileURL(join(fixture.root, remote + ".git")).href }
}

/** Give the fork fixture a GitHub-shaped origin that still fetches from the local bare remote. */
export function useGithubShapedFork(fixture: CompatibilityFixture, fork: string): void {
  fixture.git(fixture.ontology, "config", "url." + fixture.origin + ".insteadOf", "https://github.com/" + fork + ".git")
  fixture.git(fixture.ontology, "remote", "set-url", "origin", "https://github.com/" + fork + ".git")
}

export function registryText(fixture: CompatibilityFixture, home = fixture.home): string {
  const file = join(home, "config", "settings.jsonc")
  return existsSync(file) ? readFileSync(file, "utf8") : ""
}
