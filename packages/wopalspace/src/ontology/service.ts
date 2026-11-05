import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { HostContext } from "../contract"
import { githubTokenCandidates } from "../github-credentials"
import { capabilityKind, readCapabilities } from "./capabilities"
import { inspectContributions } from "./contributions"
import { createGitHubForkProvisioner, githubPullRequestQuery } from "./github"
import {
  analyzeContributionFlow,
  analyzeFlow,
  assertRepositoryRoot,
  commitsAhead,
  fetch,
  hasCommonBase,
  isGitRepository,
  isPathInside,
  normalizeRemote,
  refExists,
  configuredRemoteUrl,
  remoteUrl,
  repositoryFacts,
  sanitizeRemoteUrl,
  systemGit,
  topology,
  type RemoteTopology,
} from "./git"
import {
  DEFAULT_UPSTREAM,
  normalizeOntologyName,
  normalizeOntologySource,
  ontologyMode,
  ontologyRoot,
  readRegistry,
  registryEntry,
  spacesForOntology,
  writeRegistryEntry,
  type OntologyRegistry,
} from "./registry"
import { previewSync, syncOntology } from "./sync"
import {
  OntologyServiceError,
  toPublicError,
  type GitRunner,
  type InstallResult,
  type OntologyInspectResult,
  type OntologyInstallInput,
  type OntologyListResult,
  type OntologyRegistryEntry,
  type OntologyMode,
  type OntologyService,
  type OntologyServiceOptions,
  type OntologySummary,
  type RefreshResult,
  type RepositoryFacts,
  sanitizeMessage,
} from "./types"

const ORIGIN = "origin/main"
const UPSTREAM = "upstream/main"

interface Resolved {
  readonly name: string
  readonly path: string
  readonly mode: OntologyMode
  readonly topology: RemoteTopology
}

/**
 * Resolve a registered path inside the ontology root. The root is
 * realpath-resolved first because the platform temp directory can itself be
 * a symlink (/var -> /private/var); an absolute registration is checked
 * against that real root so aliasing cannot widen access.
 */
function confine(root: string, candidate: string): string {
  const resolved = isAbsolute(candidate) ? candidate : join(root, candidate)
  const realRoot = existsSync(root) ? realpathSync(root) : root
  if (!existsSync(resolved)) {
    if (!isPathInside(root, resolved) && !isPathInside(realRoot, resolved)) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_PATH_ESCAPE",
        message: "Ontology path is outside the ontology root: " + candidate,
      })
    }
    return resolved
  }
  const real = realpathSync(resolved)
  if (!isPathInside(realRoot, real)) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_PATH_ESCAPE",
      message: "Ontology path resolves outside the ontology root: " + candidate,
    })
  }
  return real
}

function emptyFacts(diagnostic?: string): RepositoryFacts {
  return {
    available: false,
    readable: false,
    dirty: false,
    changes: [],
    branches: [],
    ...(diagnostic ? { diagnostic } : {}),
  }
}

function modeOf(entryFork: boolean | undefined, actual: RemoteTopology): OntologyMode {
  if (actual.fork) return "fork"
  if (entryFork === true) return "fork"
  return "clone"
}

function publicRemote(value: string): string {
  return sanitizeMessage(value)
}

function publicFacts(facts: RepositoryFacts): RepositoryFacts {
  return facts.diagnostic === undefined ? facts : { ...facts, diagnostic: sanitizeMessage(facts.diagnostic) }
}

export function createOntologyService(options: OntologyServiceOptions): OntologyService {
  const host: HostContext = options.host
  const git: GitRunner = options.git ?? systemGit
  const pr = options.pr ?? githubPullRequestQuery
  const fork =
    options.fork ??
    createGitHubForkProvisioner({
      tokens: () => githubTokenCandidates(host.wopalHome),
    })
  const tempRoot = options.tempRoot
  const root = ontologyRoot(host.wopalHome)

  function registry(): OntologyRegistry {
    return readRegistry(host.wopalHome)
  }

  function resolve(nameValue: string): Resolved {
    const name = normalizeOntologyName(nameValue)
    const entry = registryEntry(name, registry())
    const path = confine(join(host.wopalHome, "ontologies"), entry.path)
    const actual = isGitRepository(path, git) ? topology(path, git) : { fork: false }
    return { name, path, mode: modeOf(entry.fork, actual), topology: actual }
  }

  function summary(name: string, entry: OntologyRegistryEntry, path: string): OntologySummary {
    const actual = isGitRepository(path, git) ? topology(path, git) : { fork: false }
    const mode = modeOf(entry.fork, actual)
    const facts = repositoryFacts(path, git)
    return {
      name,
      mode,
      path: entry.path,
      remote: publicRemote(mode === "fork" ? (actual.origin ?? entry.origin ?? entry.upstream) : entry.upstream),
      ...(mode === "fork" ? { upstream: publicRemote(entry.upstream) } : {}),
      available: facts.available,
      repo: publicFacts(facts),
      spaces: spacesForOntology(registry(), name),
    }
  }

  function inspectResolved(resolved: Resolved): OntologyInspectResult {
    const entry = registryEntry(resolved.name, registry())
    const displayPath = entry.path
    const readable = isGitRepository(resolved.path, git)
    if (!readable) {
      const facts = emptyFacts("Ontology repository is not readable")
      return {
        name: resolved.name,
        mode: resolved.mode,
        path: displayPath,
        remote: "",
        localRepo: displayPath,
        remoteRepo: "",
        available: false,
        repo: facts,
        repository: facts,
        spaces: spacesForOntology(registry(), resolved.name),
        downstream: [],
        upstream: [],
      }
    }
    const actual = topology(resolved.path, git)
    const mode = modeOf(undefined, actual)
    const facts = repositoryFacts(resolved.path, git)
    const downstream =
      mode === "fork"
        ? [
            analyzeFlow(resolved.path, ORIGIN, "main", "origin/main → local/main", git, "merge", tempRoot),
            analyzeFlow(resolved.path, UPSTREAM, "main", "upstream/main → local/main", git, "merge", tempRoot),
          ]
        : [analyzeFlow(resolved.path, ORIGIN, "main", "origin/main → local/main", git, "merge", tempRoot)]
    const upstream =
      mode === "fork"
        ? [
            analyzeFlow(resolved.path, "main", ORIGIN, "local/main → origin/main", git, "push", tempRoot),
            analyzeContributionFlow(resolved.path, "main", UPSTREAM, "local/main → upstream/main", git),
          ]
        : []
    const publicRepo = publicFacts(facts)
    return {
      name: resolved.name,
      mode,
      path: displayPath,
      remote: publicRemote(mode === "fork" ? (actual.origin ?? entry.origin ?? entry.upstream) : entry.upstream),
      ...(mode === "fork" ? { upstream: publicRemote(entry.upstream) } : {}),
      localRepo: displayPath,
      remoteRepo: publicRemote(mode === "fork" ? (actual.origin ?? entry.origin ?? entry.upstream) : entry.upstream),
      ...(mode === "fork" ? { upstreamRepo: publicRemote(actual.upstream ?? entry.upstream) } : {}),
      repository: publicRepo,
      repo: publicRepo,
      spaces: spacesForOntology(registry(), resolved.name),
      available: true,
      downstream,
      upstream,
    }
  }

  function validateAssembly(repo: string): void {
    try {
      git(repo, ["cat-file", "-e", "HEAD:assembly/archetypes"])
    } catch {
      throw new OntologyServiceError({
        code: "ONTOLOGY_ASSEMBLY_INVALID",
        message: "Ontology repository does not contain assembly/archetypes",
        suggestion: "Install a WopalSpace ontology source that provides assembly/archetypes.",
      })
    }
  }

  function validateHistory(repo: string): void {
    if (!existsSync(repo)) return
    if (!isGitRepository(repo, git)) return
    // A missing ref is not a history conflict: install does not require a
    // fetch, and the ref may simply not be cached yet.
    if (!refExists(repo, "main", git) || !refExists(repo, ORIGIN, git)) return
    if (!hasCommonBase(repo, "main", ORIGIN, git)) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_HISTORY_CONFLICT",
        message: "The existing repository has no common history with its origin/main",
        suggestion: "Choose another name or resolve the repository history before installing.",
      })
    }
  }

  function cloneSource(source: string, target: string): void {
    const parent = join(target, "..")
    mkdirSync(parent, { recursive: true })
    git(parent, ["clone", "--no-tags", source, target])
  }

  async function ensureForkTopology(repo: string, source: string, entryName: string): Promise<"created" | "upgraded"> {
    let forkUrl: string
    try {
      forkUrl = await fork.ensure(source)
    } catch (error) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_UPGRADE_FAILED",
        message: "Failed to create or verify the fork for " + entryName,
        suggestion: "Check your GitHub authentication (gh auth login or GITHUB_TOKEN) and retry.",
        cause: error,
      })
    }
    try {
      if (modeOf(undefined, topology(repo, git)) === "fork") return "created"
      git(repo, ["remote", "set-url", "origin", forkUrl])
      if (!remoteUrl(repo, "upstream", git)) git(repo, ["remote", "add", "upstream", source])
      try {
        fetch(repo, "origin", git)
      } catch {
        // The fork may be empty until its first push; topology is still valid.
      }
      try {
        fetch(repo, "upstream", git)
      } catch {
        // Assembly validation below uses the local checkout.
      }
    } catch (error) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_UPGRADE_FAILED",
        message: "Failed to switch the existing clone to fork mode",
        suggestion: "Check local git configuration, then retry.",
        cause: error,
      })
    }
    return "upgraded"
  }

  async function install(raw: OntologyInstallInput): Promise<InstallResult> {
    const name = normalizeOntologyName(raw.name)
    const source = normalizeOntologySource(raw.source ?? DEFAULT_UPSTREAM)
    const mode = ontologyMode(raw)
    mkdirSync(root, { recursive: true })
    const realRoot = realpathSync(root)
    const registered = registry()
    const existing = Object.hasOwn(registered.entries, name) ? registryEntry(name, registered) : undefined

    if (existing) {
      if (normalizeRemote(existing.upstream) !== normalizeRemote(source)) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_SOURCE_CONFLICT",
          message: "Ontology " + name + " is already registered from " + sanitizeRemoteUrl(existing.upstream),
          suggestion: "Reuse the registered source or choose another ontology name.",
        })
      }
      const repo = confine(realRoot, existing.path)
      if (!isGitRepository(repo, git)) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_NOT_FOUND",
          message: "Registered ontology repository is missing: " + existing.path,
        })
      }
      assertRepositoryRoot(repo, git, realpathSync)
      // Reject known local conflicts before the fork provisioner or remote mutation.
      validateAssembly(repo)
      validateHistory(repo)
      let status: InstallResult["status"] = "reused"
      if (mode === "fork" && !topology(repo, git).fork) {
        status = await ensureForkTopology(repo, source, name)
      }
      const actual = topology(repo, git)
      if (
        mode === "clone" &&
        !actual.fork &&
        actual.origin &&
        normalizeRemote(actual.origin) !== normalizeRemote(source)
      ) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_TOPOLOGY_CONFLICT",
          message: "Registered repository origin does not match the requested source",
        })
      }
      validateAssembly(repo)
      validateHistory(repo)
      writeRegistryEntry(host.wopalHome, name, {
        path: repo,
        upstream: source,
        ...(actual.origin ? { origin: actual.origin } : {}),
        fork: actual.fork,
      })
      return {
        name,
        mode: actual.fork ? "fork" : "clone",
        path: repo,
        remote: actual.origin ?? source,
        upstream: source,
        status,
      }
    }

    const target = join(realRoot, name)
    const exists = existsSync(target)
    const repo = exists ? confine(realRoot, target) : target
    if (exists && !isGitRepository(repo, git)) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_TARGET_CONFLICT",
        message: "Ontology target exists and is not a git repository: " + target,
        suggestion: "Move the existing directory aside or choose another name.",
      })
    }

    let created = false
    try {
      if (!exists) {
        if (mode === "fork") {
          let forkUrl: string
          try {
            forkUrl = await fork.ensure(source)
          } catch (error) {
            throw new OntologyServiceError({
              code: "ONTOLOGY_UPGRADE_FAILED",
              message: "Failed to create or verify the fork for " + name,
              suggestion: "Check your GitHub authentication (gh auth login or GITHUB_TOKEN) and retry.",
              cause: error,
            })
          }
          cloneSource(forkUrl, repo)
          git(repo, ["remote", "add", "upstream", source])
          try {
            fetch(repo, "upstream", git)
          } catch {
            // Local checkout still carries the assembly.
          }
        } else {
          cloneSource(source, repo)
        }
        created = true
      }
      assertRepositoryRoot(repo, git, realpathSync)
      let status: InstallResult["status"] = created ? "created" : "reused"
      if (mode === "fork" && !topology(repo, git).fork) {
        status = await ensureForkTopology(repo, source, name)
      }
      const actual = topology(repo, git)
      if (!actual.origin) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_TOPOLOGY_CONFLICT",
          message: "Ontology repository has no origin remote",
        })
      }
      if (!actual.fork && normalizeRemote(actual.origin) !== normalizeRemote(source)) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_TOPOLOGY_CONFLICT",
          message: "Origin does not match the requested ontology source",
        })
      }
      validateAssembly(repo)
      validateHistory(repo)
      writeRegistryEntry(host.wopalHome, name, {
        path: repo,
        upstream: source,
        origin: actual.origin,
        fork: actual.fork,
      })
      return {
        name,
        mode: actual.fork ? "fork" : "clone",
        path: repo,
        remote: actual.origin,
        upstream: source,
        status,
      }
    } catch (error) {
      if (created) rmSync(repo, { recursive: true, force: true })
      throw error
    }
  }

  async function list(): Promise<OntologyListResult> {
    const registered = registry()
    const items = Object.entries(registered.entries).map(([name, entry]) => {
      try {
        const validName = normalizeOntologyName(name)
        const path = confine(join(host.wopalHome, "ontologies"), entry.path)
        return summary(validName, entry, path)
      } catch (error) {
        return {
          name,
          mode: entry.fork ? "fork" : "clone",
          path: entry.path,
          remote: publicRemote(entry.origin ?? entry.upstream),
          ...(entry.fork ? { upstream: publicRemote(entry.upstream) } : {}),
          available: false,
          repo: emptyFacts(toPublicError(error).message),
          spaces: [],
        } satisfies OntologySummary
      }
    })
    return { items, total: items.length }
  }

  async function inspect(name: string): Promise<OntologyInspectResult> {
    return inspectResolved(resolve(name))
  }

  async function refresh(name: string): Promise<RefreshResult> {
    const resolved = resolve(name)
    const inspection = inspectResolved(resolved)
    if (!inspection.available) {
      return {
        git: {
          status: "failed",
          ok: false,
          remotes: {},
          diagnostics: ["The ontology repository is not readable."],
          error: { code: "ONTOLOGY_REPOSITORY_INVALID", message: "Ontology repository is not readable" },
        },
        pr: {
          status: "unavailable",
          ok: false,
          diagnostics: ["The ontology repository is not readable."],
        },
        contributions: [],
        inspection,
      }
    }
    const remotes = inspection.mode === "fork" ? ["origin", "upstream"] : ["origin"]
    const results: Record<string, { status: "ok" | "failed"; error?: string }> = {}
    for (const remote of remotes) {
      try {
        fetch(resolved.path, remote, git)
        results[remote] = { status: "ok" }
      } catch (error) {
        results[remote] = {
          status: "failed",
          error: sanitizeMessage(error instanceof Error ? error.message : String(error)),
        }
      }
    }
    const failed = Object.entries(results).filter(([, result]) => result.status === "failed")
    const gitDiagnostics = failed.map(([remote, result]) => remote + ": " + (result.error ?? "fetch failed"))
    // The inspection below happens after the fetch, so a successful refresh
    // never reports stale refs.
    const gitPhase =
      failed.length === 0
        ? { status: "ok" as const, ok: true, remotes: results, diagnostics: [] }
        : {
            status: "failed" as const,
            ok: false,
            remotes: results,
            diagnostics: gitDiagnostics,
            error: {
              code: "ONTOLOGY_REFRESH_FAILED",
              message: "Remote Git refresh failed for " + failed.length + " remote(s); local facts are shown.",
            },
          }
    const after = inspectResolved(resolved)
    const contributions = await inspectContributions(resolved.path, after, git, {
      query: pr,
      urlFor: (repo, remote) => configuredRemoteUrl(repo, remote, git),
    })
    const prDiagnostics = contributions.diagnostic ? [contributions.diagnostic] : []
    const prPhase =
      contributions.status === "ok"
        ? { status: "ok" as const, ok: true, diagnostics: [] }
        : {
            status: contributions.status,
            ok: false,
            diagnostics: prDiagnostics,
            error: {
              code: contributions.status === "unavailable" ? "ONTOLOGY_PR_UNAVAILABLE" : "ONTOLOGY_PR_QUERY_FAILED",
              message: contributions.diagnostic ?? "Contribution pull request lookup did not complete.",
            },
          }
    return {
      git: gitPhase,
      pr: prPhase,
      contributions: contributions.entries,
      inspection: after,
    }
  }

  async function sync(name: string, input: { readonly confirm: boolean }) {
    const resolved = resolve(name)
    if (!isGitRepository(resolved.path, git)) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_REPOSITORY_INVALID",
        message: "Ontology repository is not readable",
      })
    }
    assertRepositoryRoot(resolved.path, git, realpathSync)
    const mode = modeOf(undefined, topology(resolved.path, git))
    return syncOntology({
      repo: resolved.path,
      mode,
      confirm: input.confirm,
      git,
      scratchRoot: host.wopalHome,
      revalidate: () => {
        let current
        try {
          current = registryEntry(resolved.name, registry()).path
        } catch {
          current = undefined
        }
        if (!current || !existsSync(current) || realpathSync(current) !== realpathSync(resolved.path)) {
          throw new OntologyServiceError({
            code: "ONTOLOGY_REGISTRY_CHANGED",
            message: "The ontology registration changed while sync was being prepared",
            suggestion: "Retry the sync.",
          })
        }
      },
    })
  }

  async function capabilityList(name: string, input?: { readonly kind?: string }) {
    const resolved = resolve(name)
    if (!isGitRepository(resolved.path, git)) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_REPOSITORY_INVALID",
        message: "Ontology repository is not readable",
      })
    }
    const kind = input?.kind === undefined ? undefined : capabilityKind(input.kind)
    return readCapabilities(resolved.path, kind)
  }

  async function repositoryPath(name: string): Promise<string> {
    return resolve(name).path
  }

  return { install, list, inspect, refresh, sync, capabilityList, repositoryPath }
}

export function ontologyPreview(repo: string, mode: OntologyMode, git: GitRunner = systemGit) {
  return previewSync({ repo, mode, git, scratchRoot: repo })
}

/** Exposed for callers that already hold verified local facts. */
export function ontologyAhead(repo: string, from: string, to: string, git: GitRunner = systemGit): number {
  return commitsAhead(repo, from, to, git)
}
