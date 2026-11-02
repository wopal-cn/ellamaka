import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  githubLoginEnvironment,
  readHomeGithubToken,
  readProcessGithubToken,
  type GithubEnvironment,
} from "../github-credentials"
import type { SetupGithubPort } from "./types"

const execFileAsync = promisify(execFile)
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]*$/

type GhIdentityRunner = (environment: NodeJS.ProcessEnv) => Promise<string>

async function defaultGhIdentity(environment: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("gh", ["api", "user", "--jq", ".login"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: environment,
  })
  return stdout
}

export interface SetupGithubPortOptions {
  readonly runGhIdentity?: GhIdentityRunner
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>
  /** Host process environment seam; tests pass an isolated map. */
  readonly environment?: GithubEnvironment
}

/**
 * Setup's GitHub identity boundary. A token line is only storage; identity is
 * ready after either the local gh session or the stored token is verified.
 */
export function createSetupGithubPort(wopalHome: string, options: SetupGithubPortOptions = {}): SetupGithubPort {
  const runGhIdentity = options.runGhIdentity ?? defaultGhIdentity
  const fetcher = options.fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const environment = options.environment ?? process.env

  async function verify(token: string): Promise<{ readonly valid: boolean; readonly account: string | null }> {
    const response = await fetcher("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "wopal-setup",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { valid: false, account: null }
    const body: unknown = await response.json().catch(() => undefined)
    const account =
      body && typeof body === "object" && !Array.isArray(body) && "login" in body && typeof body.login === "string"
        ? body.login
        : null
    return { valid: account !== null && GITHUB_LOGIN.test(account), account }
  }

  return {
    async inspect() {
      try {
        const account = (await runGhIdentity(githubLoginEnvironment(environment))).trim()
        if (GITHUB_LOGIN.test(account)) return { configured: true, source: "gh", account }
      } catch {
        // gh is optional. Fall through to inherited/Home credentials without
        // turning an unavailable local CLI into an inspection failure.
      }

      const processToken = readProcessGithubToken(environment)
      if (processToken) {
        try {
          const result = await verify(processToken)
          if (result.valid && result.account) {
            return { configured: true, source: "process-env", account: result.account }
          }
        } catch {
          // An unusable inherited token must not suppress the Home fallback.
        }
      }

      const token = readHomeGithubToken(wopalHome)
      if (!token) return { configured: false }
      try {
        const result = await verify(token)
        return result.valid && result.account
          ? { configured: true, source: "home-env", account: result.account }
          : { configured: false }
      } catch {
        return { configured: false }
      }
    },
    verify,
  }
}
