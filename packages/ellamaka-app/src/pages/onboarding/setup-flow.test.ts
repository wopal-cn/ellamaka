import { describe, expect, test } from "bun:test"
import type { WopalSpaceSetupInspectResponse } from "@wopal/ellamaka-sdk/v2/client"
import {
  goalsForSetup,
  githubForkReady,
  resolveSetupStep,
  setupErrorView,
  setupFailureRecovery,
  setupActionLabel,
} from "./setup-flow"

type FactsOverrides = Omit<Partial<WopalSpaceSetupInspectResponse>, "home"> & {
  home?: Partial<WopalSpaceSetupInspectResponse["home"]>
}

function facts(overrides: FactsOverrides = {}): WopalSpaceSetupInspectResponse {
  const home: WopalSpaceSetupInspectResponse["home"] = {
    path: "/home/.wopal",
    binding: {
      mode: "normal",
      source: "shell",
      path: "/home/.wopal",
      locked: true,
      selectable: false,
      persisted: true,
    },
    writable: true,
    foundation: { ready: false, missing: [] },
    settings: { present: true, valid: true, ellamaka: { present: false, valid: false } },
    capabilities: { ready: false, missing: ["agents", "skills", "rules", "commands"] },
    ...overrides.home,
  }
  const { home: _home, ...rest } = overrides
  return {
    home,
    ontology: { status: "missing", items: [] },
    space: { status: "missing", items: [], availableTypes: [] },
    credentials: { github: { configured: false }, providers: [] },
    state: {
      status: "absent",
      path: "/home/.wopal/.setup/ellamaka.json",
      completed: false,
      currentStep: "foundation",
      steps: {},
    },
    goals: [],
    fingerprint: "abc",
    ...rest,
  } as WopalSpaceSetupInspectResponse
}

describe("setup flow projection", () => {
  test("always returns to the Home/Foundation step while the Host Home is still selectable", () => {
    const value = facts({
      home: {
        path: "/home/.wopal",
        binding: {
          mode: "development",
          source: "shell",
          path: "/home/.wopal",
          locked: false,
          selectable: true,
          persisted: false,
        },
        writable: true,
        foundation: { ready: true, missing: [] },
        settings: { present: true, valid: true, ellamaka: { present: true, valid: true } },
        capabilities: { ready: true, missing: [] },
      },
      state: {
        status: "ok",
        path: "/home/.wopal/.setup/ellamaka.json",
        completed: true,
        currentStep: "done",
        steps: {},
      },
    })

    expect(resolveSetupStep(value)).toBe("foundation")
  })

  test("derives the first unsatisfied application step without product or DSH gates", () => {
    expect(resolveSetupStep(facts())).toBe("foundation")
    expect(
      resolveSetupStep(
        facts({
          home: {
            path: "/home",
            writable: true,
            foundation: { ready: true, missing: [] },
            settings: { present: true, valid: true, ellamaka: { present: false, valid: false } },
            capabilities: { ready: false, missing: ["agents", "skills", "rules", "commands"] },
          },
        }),
      ),
    ).toBe("github")
  })

  test("restores an actionable server step after a reconnect", () => {
    const value = facts({
      home: {
        path: "/home",
        writable: true,
        foundation: { ready: true, missing: [] },
        settings: { present: true, valid: true, ellamaka: { present: true, valid: true } },
        capabilities: { ready: true, missing: [] },
      },
      ontology: {
        status: "ready",
        items: [{ name: "wopal-space-ontology", path: "/home/ontology", mode: "clone" }],
      },
      state: {
        status: "ok",
        path: "/home/state",
        completed: false,
        currentStep: "space",
        steps: { foundation: "done" },
      },
    })
    expect(resolveSetupStep(value)).toBe("space")
  })

  test("requests GitHub before Ontology only when fork needs identity", () => {
    expect(goalsForSetup(facts(), { ontologyMode: "fork", provider: false })).toEqual([
      "foundation",
      "github",
      "ontology",
      "space",
    ])
    expect(
      goalsForSetup(facts({ credentials: { github: { configured: true, source: "gh" }, providers: [] } }), {
        ontologyMode: "fork",
        provider: false,
      }),
    ).toEqual(["foundation", "ontology", "space"])
    expect(goalsForSetup(facts(), { ontologyMode: "clone", provider: true })).toEqual([
      "foundation",
      "ontology",
      "space",
      "provider",
    ])
  })

  test("Fork readiness requires a local gh login rather than only an inherited token", () => {
    const gh = facts({ credentials: { github: { configured: true, source: "gh", account: "octocat" }, providers: [] } })
    const env = facts({
      credentials: { github: { configured: true, source: "process-env", account: "octocat" }, providers: [] },
      home: { foundation: { ready: true, missing: [] }, writable: true },
    })
    expect(githubForkReady(gh)).toBe(true)
    expect(githubForkReady(env)).toBe(false)
    expect(resolveSetupStep(env)).toBe("github")
  })

  test("keeps a live GitHub identity satisfied even when an old fork failure is persisted", () => {
    expect(
      goalsForSetup(
        facts({
          credentials: { github: { configured: true, source: "gh", account: "octocat" }, providers: [] },
          state: {
            status: "ok",
            path: "/home/state",
            completed: false,
            currentStep: "github",
            steps: { github: "failed", ontology: "failed" },
          },
        }),
        { ontologyMode: "fork", provider: false },
      ),
    ).toEqual(["foundation", "ontology", "space"])
  })

  test("an existing clone Ontology with missing Home base artifacts resumes at Ontology, not GitHub", () => {
    expect(
      resolveSetupStep(
        facts({
          home: {
            path: "/home",
            writable: true,
            foundation: { ready: true, missing: [] },
            settings: { present: true, valid: true, ellamaka: { present: false, valid: false } },
            capabilities: { ready: false, missing: ["agents"] },
          },
          ontology: {
            status: "ready",
            items: [{ name: "wopal-space-ontology", path: "/home/ontology", mode: "clone" }],
          },
        }),
      ),
    ).toBe("ontology")
  })

  test("a user who explicitly continued with clone resumes at Ontology after reconnect", () => {
    expect(
      resolveSetupStep(
        facts({
          home: {
            path: "/home",
            writable: true,
            foundation: { ready: true, missing: [] },
            settings: { present: false, valid: true, ellamaka: { present: false, valid: false } },
            capabilities: { ready: false, missing: ["agents", "skills", "rules", "commands"] },
          },
          state: {
            status: "ok",
            path: "/home/state",
            completed: false,
            currentStep: "github",
            steps: { foundation: "done", github: "skipped" },
          },
        }),
      ),
    ).toBe("ontology")
  })

  test("labels optional skips as skips instead of configuration work", () => {
    expect(setupActionLabel("provider", { skip: true }, "配置 OpenCode Go")).toBe("跳过 Provider 配置")
    expect(setupActionLabel("github", { skip: true }, "连接 GitHub")).toBe("跳过 GitHub 配置，使用 Clone")
    expect(setupActionLabel("provider", { providerId: "opencode-go" }, "配置 OpenCode Go")).toBe("配置 OpenCode Go")
  })

  test("an explicitly skipped provider stays optional after reconnect", () => {
    const value = facts({
      home: {
        path: "/home",
        writable: true,
        foundation: { ready: true, missing: [] },
        settings: { present: true, valid: true, ellamaka: { present: true, valid: true } },
        capabilities: { ready: true, missing: [] },
      },
      ontology: {
        status: "ready",
        items: [{ name: "wopal-space-ontology", path: "/home/ontology", mode: "clone" }],
      },
      space: {
        status: "ready",
        items: [{ name: "demo", path: "/home/space", verified: true }],
        availableTypes: [{ type: "coding", description: "Coding workspace" }],
      },
      state: {
        status: "ok",
        path: "/home/state",
        completed: false,
        currentStep: "provider",
        steps: { foundation: "done", github: "skipped", ontology: "done", space: "done", provider: "skipped" },
      },
    })

    expect(resolveSetupStep(value)).toBe("done")
    expect(goalsForSetup(value, { ontologyMode: "clone", provider: false })).toEqual([
      "foundation",
      "ontology",
      "space",
    ])
  })

  test("surfaces stable Setup errors without ever including submitted input", () => {
    const error = Object.assign(new Error("GitHub rejected the token"), {
      cause: {
        body: { code: "SETUP_GITHUB_TOKEN_INVALID", message: "GitHub rejected the token.", suggestion: "Retry." },
      },
    })
    expect(setupErrorView(error)).toEqual({
      code: "SETUP_GITHUB_TOKEN_INVALID",
      message: "GitHub rejected the token.",
      suggestion: "Retry.",
    })
  })

  test("refreshes live facts after any Ontology failure so identity loss can be re-derived", () => {
    expect(
      setupFailureRecovery("ontology", {
        code: "SETUP_ONTOLOGY_FAILED",
        message: "GitHub fork provisioning failed.",
      }),
    ).toEqual({ refreshFacts: true, deriveStepFromFacts: true })
  })

  test("a persisted fork failure resumes at Ontology when gh still reports an identity", () => {
    expect(
      resolveSetupStep(
        facts({
          home: {
            path: "/home",
            writable: true,
            foundation: { ready: true, missing: [] },
            settings: { present: false, valid: true, ellamaka: { present: false, valid: false } },
            capabilities: { ready: false, missing: ["agents", "skills", "rules", "commands"] },
          },
          credentials: { github: { configured: true, source: "gh", account: "octocat" }, providers: [] },
          state: {
            status: "ok",
            path: "/home/state",
            completed: false,
            currentStep: "github",
            steps: { foundation: "done", github: "failed", ontology: "failed" },
          },
        }),
      ),
    ).toBe("ontology")
  })

  test("an Ontology retry returns to GitHub only when live identity is actually unavailable", () => {
    expect(
      resolveSetupStep(
        facts({
          home: {
            path: "/home",
            writable: true,
            foundation: { ready: true, missing: [] },
          },
          credentials: { github: { configured: false }, providers: [] },
          state: {
            status: "ok",
            path: "/home/state",
            completed: false,
            currentStep: "ontology",
            steps: { ontology: "failed" },
          },
        }),
      ),
    ).toBe("github")
  })
})
