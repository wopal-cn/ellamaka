import { describe, expect, test } from "bun:test"
import {
  buildOntologyInitialState,
  executeOntologySetup,
  normalizeGithubAuthProbe,
  normalizeOntologyProbe,
  type GithubAuthProbe,
} from "./ontology-setup-flow"

function githubProbe(overrides: Partial<GithubAuthProbe> = {}): GithubAuthProbe {
  return {
    detected: false,
    source: null,
    account: null,
    ghCliInstalled: false,
    ghCliAuthenticated: false,
    tokenConfigured: false,
    tokenSource: null,
    ...overrides,
  }
}

describe("ontology-setup-flow | probe normalization", () => {
  test("normalizes a detected GitHub CLI credential", () => {
    expect(normalizeGithubAuthProbe({ detected: true, source: "gh-cli" })).toEqual({
      detected: true,
      source: "gh-cli",
      account: null,
      ghCliInstalled: false,
      ghCliAuthenticated: false,
      tokenConfigured: false,
      tokenSource: null,
    })
  })

  test("preserves complete GitHub environment details", () => {
    expect(normalizeGithubAuthProbe({
      detected: true,
      source: "gh-cli",
      account: "sam",
      ghCliInstalled: true,
      ghCliAuthenticated: true,
      tokenConfigured: true,
      tokenSource: "github-token-env",
    })).toEqual({
      detected: true,
      source: "gh-cli",
      account: "sam",
      ghCliInstalled: true,
      ghCliAuthenticated: true,
      tokenConfigured: true,
      tokenSource: "github-token-env",
    })
  })

  test("treats an existing clone as ready and preserves its mode", () => {
    const probe = normalizeOntologyProbe({
      status: "ready",
      ontologyInstalled: true,
      ontologyMode: "clone",
      ontologyPath: "/tmp/ontology",
      availableTypes: [{ type: "common", branch: "main" }],
    })

    expect(probe.status).toBe("ready")
    expect(probe.mode).toBe("clone")
    expect(probe.path).toBe("/tmp/ontology")
  })

  test("does not report a broken ontology directory as installed", () => {
    const probe = normalizeOntologyProbe({
      status: "broken",
      ontologyInstalled: false,
      ontologyPath: "/tmp/ontology",
      error: "不是有效的 Git 仓库",
    })

    expect(probe.status).toBe("broken")
    expect(probe.installed).toBe(false)
    expect(probe.error).toBe("不是有效的 Git 仓库")
  })
})

describe("ontology-setup-flow | initial selection", () => {
  test("defaults a fresh authenticated environment to fork", () => {
    const state = buildOntologyInitialState(
      githubProbe({ detected: true, source: "github-token-env" }),
      { status: "missing", installed: false, mode: null, path: "", availableTypes: [] },
    )

    expect(state.mode).toBe("fork")
    expect(state.modeLocked).toBe(false)
    expect(state.showGithubSetup).toBe(false)
  })

  test("keeps fork selected and exposes setup when GitHub is not configured", () => {
    const state = buildOntologyInitialState(
      githubProbe(),
      { status: "missing", installed: false, mode: null, path: "", availableTypes: [] },
    )

    expect(state.mode).toBe("fork")
    expect(state.modeLocked).toBe(false)
    expect(state.showGithubSetup).toBe(true)
  })

  test("locks an existing clone without attempting automatic migration", () => {
    const state = buildOntologyInitialState(
      githubProbe({ detected: true, source: "gh-cli" }),
      { status: "ready", installed: true, mode: "clone", path: "/tmp/ontology", availableTypes: [] },
    )

    expect(state.mode).toBe("clone")
    expect(state.modeLocked).toBe(true)
    expect(state.reuseExisting).toBe(true)
  })
})

describe("ontology-setup-flow | execution", () => {
  test("configures a supplied token before preparing a fork", async () => {
    const calls: Array<{ step: string; input: unknown }> = []
    const result = await executeOntologySetup(
      {
        mode: "fork",
        source: undefined,
        hasGithubAuth: false,
        githubToken: "ghp_test",
      },
      async (step, input) => {
        calls.push({ step, input })
        return step === "github-auth"
          ? { status: "completed", result: { envPath: "/tmp/.env" } }
          : { status: "completed", result: { mode: "fork" } }
      },
    )

    expect(calls).toEqual([
      { step: "github-auth", input: { token: "ghp_test" } },
      { step: "ontology-setup", input: { mode: "fork" } },
    ])
    expect(result.status).toBe("completed")
  })

  test("uses detected authentication without rewriting credentials", async () => {
    const calls: string[] = []
    await executeOntologySetup(
      {
        mode: "fork",
        source: "https://github.com/example/ontology.git",
        hasGithubAuth: true,
        githubToken: "",
      },
      async (step) => {
        calls.push(step)
        return { status: "completed", result: {} }
      },
    )

    expect(calls).toEqual(["ontology-setup"])
  })

  test("uses an explicitly supplied token to replace detected credentials", async () => {
    const calls: Array<{ step: string; input: unknown }> = []
    await executeOntologySetup(
      {
        mode: "fork",
        source: undefined,
        hasGithubAuth: true,
        githubToken: "replacement_token",
      },
      async (step, input) => {
        calls.push({ step, input })
        return { status: "completed", result: {} }
      },
    )

    expect(calls).toEqual([
      { step: "github-auth", input: { token: "replacement_token" } },
      { step: "ontology-setup", input: { mode: "fork" } },
    ])
  })

  test("reuses an existing fork without requiring a new credential", async () => {
    const calls: Array<{ step: string; input: unknown }> = []
    const result = await executeOntologySetup(
      {
        mode: "fork",
        source: undefined,
        hasGithubAuth: false,
        githubToken: "",
        reuseExisting: true,
      },
      async (step, input) => {
        calls.push({ step, input })
        return { status: "reused", result: { mode: "fork" } }
      },
    )

    expect(calls).toEqual([{ step: "ontology-setup", input: { mode: "fork" } }])
    expect(result.status).toBe("reused")
  })

  test("rejects fork before IPC when no authentication is available", async () => {
    let called = false
    const result = await executeOntologySetup(
      {
        mode: "fork",
        source: undefined,
        hasGithubAuth: false,
        githubToken: "",
      },
      async () => {
        called = true
        return { status: "completed", result: {} }
      },
    )

    expect(called).toBe(false)
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "GITHUB_AUTH_REQUIRED" },
    })
  })
})
