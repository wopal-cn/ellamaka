import { readFileSync } from "node:fs"
import { join } from "node:path"

export type GithubEnvironment = Readonly<Record<string, string | undefined>>

function parseGithubToken(text: string): string | undefined {
  const match = text.match(/^[ \t]*(?:GITHUB_TOKEN|GH_TOKEN)[ \t]*=[ \t]*([^\s#][^\r\n]*)$/m)
  if (!match?.[1]) return undefined
  const raw = match[1].trim()
  if (!raw) return undefined
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

/** Read the GitHub credential stored for one WOPAL_HOME without mutating process.env. */
export function readHomeGithubToken(wopalHome: string): string | undefined {
  try {
    return parseGithubToken(readFileSync(join(wopalHome, ".env"), "utf8"))
  } catch {
    return undefined
  }
}

/** Read a GitHub token inherited by the current host process. */
export function readProcessGithubToken(environment: GithubEnvironment = process.env): string | undefined {
  const github = environment.GITHUB_TOKEN?.trim()
  if (github) return github
  const gh = environment.GH_TOKEN?.trim()
  return gh || undefined
}

/** Candidate tokens in host-preference order, without duplicates. */
export function githubTokenCandidates(
  wopalHome: string,
  environment: GithubEnvironment = process.env,
): readonly string[] {
  const candidates = [readProcessGithubToken(environment), readHomeGithubToken(wopalHome)].filter(
    (token): token is string => token !== undefined,
  )
  return candidates.filter((token, index) => candidates.indexOf(token) === index)
}

/**
 * Probe the local `gh` login independently from token environment overrides.
 * GitHub CLI gives GITHUB_TOKEN/GH_TOKEN precedence over its stored login, so
 * leaving them inherited would make an invalid shell token hide a valid login.
 */
export function githubLoginEnvironment(environment: GithubEnvironment = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment }
  delete result.GITHUB_TOKEN
  delete result.GH_TOKEN
  return result
}
