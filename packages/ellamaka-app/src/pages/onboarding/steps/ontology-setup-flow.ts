import type { OnboardingStepResult } from "@/lib/onboarding-client"

export type OntologyMode = "fork" | "clone"

export type GithubCredentialSource =
  | "github-token-env"
  | "gh-token-env"
  | "github-token-shell"
  | "gh-token-shell"
  | "gh-cli"
  | "wopal-github-token"
  | "wopal-gh-token"

export interface GithubAuthProbe {
  detected: boolean
  source: GithubCredentialSource | null
  account: string | null
  ghCliInstalled: boolean
  ghCliAuthenticated: boolean
  tokenConfigured: boolean
  tokenSource: GithubCredentialSource | null
}

export interface OntologyProbe {
  status: "missing" | "ready" | "broken"
  installed: boolean
  mode: OntologyMode | null
  path: string
  availableTypes: Array<{ type: string; branch: string }>
  error?: string
}

export interface OntologyInitialState {
  mode: OntologyMode
  modeLocked: boolean
  reuseExisting: boolean
  showGithubSetup: boolean
}

export interface OntologySetupInput {
  mode: OntologyMode
  source?: string
  hasGithubAuth: boolean
  githubToken: string
  reuseExisting?: boolean
}

type OntologyExecuteStep = (
  step: "github-auth" | "ontology-setup",
  input?: unknown,
) => Promise<OnboardingStepResult>

const GITHUB_SOURCES = new Set<GithubCredentialSource>([
  "github-token-env",
  "gh-token-env",
  "github-token-shell",
  "gh-token-shell",
  "gh-cli",
  "wopal-github-token",
  "wopal-gh-token",
])

export function normalizeGithubAuthProbe(raw: Record<string, unknown> | null | undefined): GithubAuthProbe {
  const source = GITHUB_SOURCES.has(raw?.source as GithubCredentialSource)
    ? raw?.source as GithubCredentialSource
    : null
  const tokenSource = GITHUB_SOURCES.has(raw?.tokenSource as GithubCredentialSource)
    ? raw?.tokenSource as GithubCredentialSource
    : null
  return {
    detected: Boolean(raw?.detected),
    source,
    account: typeof raw?.account === "string" && raw.account.trim() ? raw.account.trim() : null,
    ghCliInstalled: Boolean(raw?.ghCliInstalled),
    ghCliAuthenticated: Boolean(raw?.ghCliAuthenticated),
    tokenConfigured: Boolean(raw?.tokenConfigured),
    tokenSource,
  }
}

export function normalizeOntologyProbe(raw: Record<string, unknown> | null | undefined): OntologyProbe {
  const installed = Boolean(raw?.ontologyInstalled)
  const rawStatus = raw?.status
  const status: OntologyProbe["status"] = rawStatus === "ready" || rawStatus === "broken" || rawStatus === "missing"
    ? rawStatus
    : installed
      ? "ready"
      : typeof raw?.error === "string"
        ? "broken"
        : "missing"
  const rawMode = raw?.ontologyMode
  const mode = rawMode === "fork" || rawMode === "clone" ? rawMode : null
  const rawTypes = Array.isArray(raw?.availableTypes) ? raw.availableTypes : []
  const availableTypes = rawTypes.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const entry = item as Record<string, unknown>
    if (typeof entry.type !== "string" || typeof entry.branch !== "string") return []
    return [{ type: entry.type, branch: entry.branch }]
  })

  return {
    status,
    installed: status === "ready" && installed,
    mode,
    path: typeof raw?.ontologyPath === "string" ? raw.ontologyPath : "",
    availableTypes,
    error: typeof raw?.error === "string" ? raw.error : undefined,
  }
}

export function buildOntologyInitialState(
  auth: GithubAuthProbe,
  ontology: OntologyProbe,
): OntologyInitialState {
  if (ontology.status === "ready" && ontology.mode) {
    return {
      mode: ontology.mode,
      modeLocked: true,
      reuseExisting: true,
      showGithubSetup: false,
    }
  }

  if (ontology.status === "broken") {
    return {
      mode: ontology.mode ?? "clone",
      modeLocked: true,
      reuseExisting: false,
      showGithubSetup: false,
    }
  }

  return {
    mode: "fork",
    modeLocked: false,
    reuseExisting: false,
    showGithubSetup: !auth.detected,
  }
}

export async function executeOntologySetup(
  input: OntologySetupInput,
  executeStep: OntologyExecuteStep,
): Promise<OnboardingStepResult> {
  const token = input.githubToken.trim()

  if (token) {
    const authResult = await executeStep("github-auth", { token })
    if (authResult.status === "failed") return authResult
    if (authResult.status === "skipped") {
      return {
        status: "failed",
        error: {
          code: "GITHUB_AUTH_REQUIRED",
          message: "GitHub 认证未完成。",
        },
      }
    }
  } else if (input.mode === "fork" && !input.hasGithubAuth && !input.reuseExisting) {
    return {
      status: "failed",
      error: {
        code: "GITHUB_AUTH_REQUIRED",
        message: "Fork 模式需要先连接 GitHub。",
      },
    }
  }

  const ontologyInput: Record<string, unknown> = { mode: input.mode }
  const source = input.source?.trim()
  if (source) ontologyInput.source = source
  return executeStep("ontology-setup", ontologyInput)
}
