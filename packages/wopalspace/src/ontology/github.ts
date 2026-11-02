import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { githubLoginEnvironment } from "../github-credentials"
import { githubIdentity } from "./contributions"
import { OntologyServiceError, type ForkProvisioner, type PullRequestQuery, type PullRequestSnapshot } from "./types"

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 16 * 1024 * 1024

interface GitHubPull {
  readonly number?: unknown
  readonly html_url?: unknown
  readonly state?: unknown
  readonly merged?: unknown
  readonly merged_at?: unknown
  readonly base?: { readonly ref?: unknown }
  readonly head?: {
    readonly ref?: unknown
    readonly sha?: unknown
    readonly repo?: { readonly full_name?: unknown } | null
  }
}

export function parsePullRequest(value: GitHubPull): PullRequestSnapshot | undefined {
  if (typeof value.number !== "number" || typeof value.html_url !== "string") return undefined
  const baseBranch = value.base?.ref
  const headBranch = value.head?.ref
  const headFork = value.head?.repo?.full_name
  if (typeof baseBranch !== "string" || typeof headBranch !== "string" || typeof headFork !== "string") return undefined
  const state = value.merged === true || value.merged_at ? "merged" : value.state === "open" ? "open" : "closed"
  return {
    number: value.number,
    url: value.html_url,
    state,
    baseBranch,
    headBranch,
    headFork,
    ...(typeof value.head?.sha === "string" ? { headSha: value.head.sha } : {}),
  }
}

function ownerOf(fullName: string): string {
  return fullName.split("/")[0] ?? fullName
}

/**
 * Real GitHub adapter. The query is scoped to the upstream repository and
 * the caller still filters the returned identities exactly. A missing `gh`
 * CLI or failed request surfaces as an error so refresh can report
 * `unavailable` instead of pretending an empty result is authoritative.
 */
export function createGitHubPullRequestQuery(
  run: (args: readonly string[], cwd: string) => Promise<string> = async (args, cwd) => {
    const { stdout } = await execFileAsync("gh", [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
    })
    return stdout
  },
): PullRequestQuery {
  return {
    async query(input) {
      const params = new URLSearchParams({
        state: "all",
        head: ownerOf(input.headFork) + ":" + input.headBranch,
        base: input.baseBranch,
        per_page: "100",
      })
      const endpoint = "repos/" + input.upstreamRepo + "/pulls?" + params.toString()
      let output: string
      try {
        output = await run(["api", endpoint, "--paginate", "--slurp"], input.repo)
      } catch (error) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_PR_UNAVAILABLE",
          message: "GitHub pull request lookup is unavailable",
          suggestion: "Check `gh auth status` and network access, then retry refresh.",
          cause: error,
        })
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(output)
      } catch {
        throw new OntologyServiceError({
          code: "ONTOLOGY_PR_INVALID",
          message: "GitHub returned an unreadable pull request response",
        })
      }
      const pages = Array.isArray(parsed) ? parsed : [parsed]
      const entries = pages.flatMap((page) => (Array.isArray(page) ? page : [page]))
      const expectedFork = input.headFork.toLowerCase()
      return entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
        const parsedEntry = parsePullRequest(entry)
        if (!parsedEntry) return []
        // Defense in depth: the service filters again, but a mis-scoped API
        // response must never be reported as this contribution.
        if (parsedEntry.headFork.toLowerCase() !== expectedFork) return []
        if (parsedEntry.headBranch !== input.headBranch || parsedEntry.baseBranch !== input.baseBranch) return []
        return [parsedEntry]
      })
    },
  }
}

export const githubPullRequestQuery = createGitHubPullRequestQuery()

/** One `gh` invocation boundary; tests inject this instead of running GitHub. */
export type GhRunner = (args: readonly string[], cwd: string) => Promise<string>

const runGh: GhRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("gh", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: MAX_BUFFER,
    env: githubLoginEnvironment(),
  })
  return stdout
}

interface GitHubParentView {
  readonly full_name?: unknown
  readonly name?: unknown
  readonly owner?: GitHubOwnerView
}

interface GitHubOwnerView {
  readonly login?: unknown
}

interface GitHubRepositoryView {
  readonly parent?: GitHubParentView
}

const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/

function unreadableRepository(error?: unknown): OntologyServiceError {
  return new OntologyServiceError({
    code: "ONTOLOGY_FORK_UNAVAILABLE",
    message: "GitHub returned an unreadable repository description",
    ...(error === undefined ? {} : { cause: error }),
  })
}

function parseRepositoryView(output: string): GitHubRepositoryView {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error) {
    throw unreadableRepository(error)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unreadableRepository()
  return parsed
}

function parentIdentity(parent: GitHubParentView | undefined): string | undefined {
  if (!parent) return undefined
  if (typeof parent.full_name === "string") return parent.full_name
  if (typeof parent.name === "string" && typeof parent.owner?.login === "string") {
    return parent.owner.login + "/" + parent.name
  }
  return undefined
}

function sameIdentity(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase()
}

function cloneUrl(fullName: string): string {
  return "https://github.com/" + fullName + ".git"
}

export interface GitHubForkProvisionerOptions {
  readonly run?: GhRunner
  /** Token fallbacks when the local gh session is unavailable. */
  readonly tokens?: () => readonly string[]
  /** @deprecated Single-token compatibility seam; prefer tokens. */
  readonly token?: () => string | undefined
  /** HTTP seam for token-authenticated GitHub API calls. */
  readonly fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  /** Working directory for `gh`; defaults to the process directory. */
  readonly cwd?: string
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** How many times to check that a created fork is visible on GitHub. */
  readonly attempts?: number
  readonly retryDelayMs?: number
}

/**
 * GitHub fork boundary for `ontology.install` fork mode.
 *
 * Mirrors the previous owner's semantics: the current GitHub identity is
 * required, an existing repository with the fork's name is reused only when its
 * parent is the requested upstream, and a new fork is created and then verified
 * before it is reported. A missing `gh` CLI, missing authentication, a network
 * failure or an unverifiable fork surfaces as an error; fork mode never reports
 * a fork it could not confirm.
 */
export function createGitHubForkProvisioner(options: GitHubForkProvisionerOptions = {}): ForkProvisioner {
  const run = options.run ?? runGh
  const fetcher = options.fetcher ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const cwd = options.cwd ?? process.cwd()
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const attempts = Math.max(1, options.attempts ?? 10)
  const retryDelayMs = options.retryDelayMs ?? 2_000

  async function ghLogin(): Promise<string> {
    const output = await run(["api", "user", "--jq", ".login"], cwd)
    const login = output.trim()
    if (!GITHUB_LOGIN.test(login)) throw new Error("GitHub returned an invalid login")
    return login
  }

  async function ghView(fullName: string): Promise<GitHubRepositoryView | undefined> {
    try {
      return parseRepositoryView(await run(["api", "repos/" + fullName], cwd))
    } catch (error) {
      // A repository that cannot be read is treated as absent; creating the
      // fork below surfaces authentication and network problems explicitly.
      if (error instanceof OntologyServiceError && error.code === "ONTOLOGY_FORK_UNAVAILABLE") throw error
      return undefined
    }
  }

  function tokenHeaders(token: string): Record<string, string> {
    return {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "User-Agent": "wopal-ontology",
    }
  }

  async function httpLogin(token: string): Promise<string> {
    const response = await fetcher("https://api.github.com/user", { headers: tokenHeaders(token) })
    if (!response.ok) throw new Error("GitHub rejected the stored credential")
    const body: unknown = await response.json().catch(() => undefined)
    const login =
      body && typeof body === "object" && !Array.isArray(body) && "login" in body && typeof body.login === "string"
        ? body.login
        : ""
    if (!GITHUB_LOGIN.test(login)) throw new Error("GitHub returned an invalid login")
    return login
  }

  async function httpView(fullName: string, token: string): Promise<GitHubRepositoryView | undefined> {
    const response = await fetcher("https://api.github.com/repos/" + fullName, { headers: tokenHeaders(token) })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error("GitHub repository lookup failed")
    return parseRepositoryView(await response.text())
  }

  async function httpCreateFork(upstream: string, token: string): Promise<void> {
    const response = await fetcher("https://api.github.com/repos/" + upstream + "/forks", {
      method: "POST",
      headers: tokenHeaders(token),
    })
    if (!response.ok) throw new Error("GitHub fork creation failed")
  }

  return {
    async ensure(source) {
      const upstream = githubIdentity(source)
      if (!upstream) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_FORK_UNAVAILABLE",
          message: "Fork mode requires a GitHub repository source",
          suggestion: "Install the ontology from its GitHub URL, or use clone mode.",
        })
      }
      const repoName = upstream.slice(upstream.indexOf("/") + 1)
      let login: string | undefined
      let token: string | undefined
      try {
        login = await ghLogin()
      } catch (ghError) {
        const single = options.token?.()
        const candidates = options.tokens?.() ?? (single ? [single] : [])
        let tokenError: unknown = ghError
        for (const candidate of candidates) {
          try {
            login = await httpLogin(candidate)
            token = candidate
            break
          } catch (error) {
            tokenError = error
          }
        }
        if (!login || !token) throw authenticationUnavailable(tokenError)
      }
      const forkFullName = login + "/" + repoName

      const view = () => (token ? httpView(forkFullName, token) : ghView(forkFullName))
      const existing = await view()
      if (existing) {
        const parent = parentIdentity(existing.parent)
        if (!sameIdentity(parent, upstream)) {
          throw new OntologyServiceError({
            code: "ONTOLOGY_FORK_UNAVAILABLE",
            message: "Existing GitHub repository " + forkFullName + " is not a fork of " + upstream,
            suggestion: "Remove the conflicting repository or use another GitHub account, then retry.",
          })
        }
        return cloneUrl(forkFullName)
      }

      try {
        if (token) await httpCreateFork(upstream, token)
        else await run(["api", "--method", "POST", "repos/" + upstream + "/forks"], cwd)
      } catch (error) {
        throw new OntologyServiceError({
          code: "ONTOLOGY_FORK_UNAVAILABLE",
          message: "Failed to create the GitHub fork " + forkFullName,
          suggestion: "Check `gh auth status` and network access, then retry.",
          cause: error,
        })
      }

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const created = await view()
        if (created && sameIdentity(parentIdentity(created.parent), upstream)) return cloneUrl(forkFullName)
        if (attempt < attempts - 1) await sleep(retryDelayMs)
      }
      throw new OntologyServiceError({
        code: "ONTOLOGY_FORK_UNAVAILABLE",
        message: "GitHub did not report the fork " + forkFullName + " after creation",
        suggestion: "Check the fork list of the authenticated GitHub account, then retry.",
      })
    },
  }
}

function authenticationUnavailable(error?: unknown): OntologyServiceError {
  return new OntologyServiceError({
    code: "ONTOLOGY_FORK_UNAVAILABLE",
    message: "GitHub authentication is unavailable for fork mode",
    suggestion: "Run `gh auth login`, verify network access, then retry fork mode.",
    ...(error === undefined ? {} : { cause: error }),
  })
}
