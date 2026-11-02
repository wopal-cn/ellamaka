import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SETUP_ERROR,
  createSetupGithubPort,
  createSetupService,
  fileFoundation,
  setupStatePath,
  type SetupOntologyPort,
  type SetupSpacePort,
  type SetupSpaceInitResult,
} from "../../../src/setup"

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object")
  return Object.fromEntries(Object.entries(value))
}

function jsonField(value: unknown, key: string): unknown {
  return jsonObject(value)[key]
}

async function readStateJson(home: string): Promise<Record<string, unknown>> {
  return jsonObject(JSON.parse(await readFile(setupStatePath(home), "utf8")))
}

async function temporaryHome(prefix = "wopal-setup-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** A Space port backed by the real filesystem, like the eventual Space owner. */
function fileSpace(preparation: "ok" | "failed" = "ok"): SetupSpacePort {
  return {
    async list() {
      return { items: [], total: 0 }
    },
    async availableTypes() {
      return [{ type: "coding", description: "Coding workspace" }]
    },
    async init(input, signal): Promise<SetupSpaceInitResult> {
      const meta = join(input.root, ".wopal-space")
      mkdirSync(meta, { recursive: true })
      await writeFile(join(meta, "space-meta.json"), JSON.stringify({ name: input.name, type: input.type }))
      void signal
      return {
        name: input.name,
        path: input.root,
        materialized: true,
        preparation:
          preparation === "ok"
            ? { status: "ok" }
            : { status: "failed", error: { code: "PREPARE_FAILED", message: "bun install failed" } },
      }
    },
  }
}

function ontologyPort(home: string) {
  const path = join(home, "ontologies", "wopal-space-ontology")
  return {
    async list() {
      return existsSync(path)
        ? {
            items: [{ name: "wopal-space-ontology", path, mode: "clone" as const, available: true, readable: true }],
            total: 1,
          }
        : { items: [], total: 0 }
    },
    async install(input: { name?: string; source?: string; mode: "fork" | "clone" }) {
      const config = join(path, "config")
      mkdirSync(config, { recursive: true })
      await writeFile(
        join(config, "settings.jsonc"),
        JSON.stringify({
          ellamaka: {
            autoupdate: "notify",
            permission: { external_directory: "ask", bash: { "rm -rf *": "ask" } },
          },
        }),
      )
      return { name: input.name ?? "wopal-space-ontology", path, status: "created" as const }
    },
  }
}

/**
 * The GitHub API is an external boundary, so the integration tests supply a
 * verifier instead of calling the real service.
 */
function service(
  home: string,
  options: { space?: SetupSpacePort; ontology?: SetupOntologyPort; validToken?: boolean } = {},
) {
  const github = createSetupGithubPort(home, {
    runGhIdentity: async () => {
      throw new Error("gh unavailable in integration fixture")
    },
    fetcher: async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization")
      const valid = authorization === "Bearer placeholder" && options.validToken !== false
      return new Response(valid ? JSON.stringify({ login: "octocat" }) : "{}", {
        status: valid ? 200 : 401,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return createSetupService({
    host: { wopalHome: home },
    ontology: options.ontology ?? ontologyPort(home),
    space: options.space ?? fileSpace(),
    github,
  })
}

async function settle(runService: ReturnType<typeof service>, runId: string) {
  const events = []
  for await (const event of runService.progressEvents({ runId })) events.push(event)
  return { events, snapshot: await runService.progress(runId) }
}

describe("setup service on a real home", () => {
  test("inspect does not create any file or directory", async () => {
    const home = await temporaryHome()
    try {
      const result = await service(home).inspect()
      expect(result.home.foundation.ready).toBe(true)
      expect(await readdir(home)).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("foundation creates only the WOPAL_HOME root; setup state persists separately", async () => {
    const parent = await temporaryHome()
    const home = join(parent, "home")
    try {
      const setup = service(home)
      const plan = await setup.plan({ goals: ["foundation"] })
      const run = await setup.execute({ planId: plan.planId, actionId: "foundation" })
      const { snapshot } = await settle(setup, run.runId)
      expect(snapshot.status).toBe("completed")

      for (const dir of ["config", "bin", "ontologies", "ellamaka", "agents", "skills", "rules", "commands"]) {
        expect(existsSync(join(home, dir))).toBe(false)
      }
      const statePath = setupStatePath(home)
      const state = await readStateJson(home)
      expect(jsonField(jsonField(state, "steps"), "foundation")).toBe("done")

      const stateDir = await readdir(join(home, ".setup"))
      expect(stateDir).toEqual(["ellamaka.json"])
      if (process.platform !== "win32") {
        expect((await stat(statePath)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("Ontology progress stays outside the Ellamaka Runtime tree until install and Home seed complete", async () => {
    const home = await temporaryHome()
    const ontologyPath = join(home, "ontologies", "wopal-space-ontology")
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ontology: SetupOntologyPort = {
      async list() {
        return { items: [], total: 0 }
      },
      async install(input) {
        const config = join(ontologyPath, "config")
        mkdirSync(config, { recursive: true })
        await writeFile(join(config, "settings.jsonc"), JSON.stringify({ ellamaka: { autoupdate: "notify" } }))
        entered()
        await gate
        return { name: input.name ?? "wopal-space-ontology", path: ontologyPath, status: "created" as const }
      },
    }

    try {
      const setup = service(home, { ontology })
      const plan = await setup.plan({ goals: ["ontology"] })
      const run = await setup.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })
      await started

      expect(existsSync(setupStatePath(home))).toBe(true)
      expect(existsSync(join(home, "ellamaka"))).toBe(false)

      release()
      expect((await settle(setup, run.runId)).snapshot.status).toBe("completed")
      expect(existsSync(join(home, "ellamaka"))).toBe(false)
      for (const dir of ["agents", "skills", "rules", "commands"]) {
        expect(existsSync(join(home, dir))).toBe(true)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the foundation filesystem owner itself creates no child directory", async () => {
    const parent = await temporaryHome()
    const home = join(parent, "home")
    try {
      await fileFoundation(home).ensure()
      expect(await readdir(home)).toEqual([])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("Ontology success seeds the ellamaka block and four capability-root stubs without overwriting user keys", async () => {
    const home = await temporaryHome()
    try {
      mkdirSync(join(home, "config"), { recursive: true })
      await writeFile(
        join(home, "config", "settings.jsonc"),
        [
          "{",
          "  // keep user settings",
          '  "spaces": { "existing": { "path": "/keep" } },',
          '  "ellamaka": { "default_agent": "custom", "permission": { "bash": { "*": "allow" } } }',
          "}",
          "",
        ].join("\n"),
      )
      const setup = service(home)
      const plan = await setup.plan({ goals: ["ontology"] })
      const run = await setup.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })
      expect((await settle(setup, run.runId)).snapshot.status).toBe("completed")

      const settingsText = await readFile(join(home, "config", "settings.jsonc"), "utf8")
      expect(settingsText).toContain("// keep user settings")
      expect(settingsText).toContain('"default_agent": "custom"')
      expect(settingsText).toContain('"autoupdate": "notify"')
      expect(settingsText).toContain('"*": "allow"')
      expect(settingsText).toContain('"existing"')
      for (const dir of ["agents", "skills", "rules", "commands"]) {
        expect(existsSync(join(home, dir))).toBe(true)
        expect(await readdir(join(home, dir))).toEqual([])
      }
      const facts = await setup.inspect()
      expect(facts.home.settings.ellamaka).toEqual({ present: true, valid: true })
      expect(facts.home.capabilities).toEqual({ ready: true, missing: [] })
      expect(facts.goals).toContain("ontology")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a file occupying a capability-root name fails before Home config is changed", async () => {
    const home = await temporaryHome()
    try {
      await writeFile(join(home, "agents"), "user file\n")
      const setup = service(home)
      const plan = await setup.plan({ goals: ["ontology"] })
      const run = await setup.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })
      const { snapshot } = await settle(setup, run.runId)
      expect(snapshot.status).toBe("failed")
      expect(snapshot.error?.code).toBe(SETUP_ERROR.homeConfigFailed)
      expect(await readFile(join(home, "agents"), "utf8")).toBe("user file\n")
      expect(existsSync(join(home, "config", "settings.jsonc"))).toBe(false)
      expect((await setup.inspect()).home.capabilities).toMatchObject({ ready: false })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a corrupt state file is reported and left byte-identical", async () => {
    const home = await temporaryHome()
    try {
      const stateDir = join(home, ".setup")
      mkdirSync(stateDir, { recursive: true })
      const statePath = setupStatePath(home)
      const corrupt = "{ not valid json"
      await writeFile(statePath, corrupt)

      const result = await service(home).inspect()
      expect(result.state.status).toBe("corrupt")
      expect(result.state.diagnostic).toBeTruthy()
      expect(await readFile(statePath, "utf8")).toBe(corrupt)
      expect(await readdir(stateDir)).toEqual(["ellamaka.json"])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("legacy onboarding state remains readable without rewriting it during inspect", async () => {
    const home = await temporaryHome()
    const legacyDir = join(home, "ellamaka", "state")
    const legacyPath = join(legacyDir, "onboarding.json")
    try {
      mkdirSync(legacyDir, { recursive: true })
      const legacy = {
        version: 1,
        currentStep: "done",
        steps: { done: "done" },
        errors: {},
        completed: true,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }
      await writeFile(legacyPath, JSON.stringify(legacy, null, 2) + "\n")

      const result = await service(home).inspect()
      expect(result.state.completed).toBe(true)
      expect(result.state.path).toBe(legacyPath)
      expect(existsSync(setupStatePath(home))).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a github token is merged into .env without touching other variables", async () => {
    const home = await temporaryHome()
    try {
      await writeFile(join(home, ".env"), ["KEEP_ME=1", ""].join(String.fromCharCode(10)))
      const setup = service(home)
      const plan = await setup.plan({ goals: ["github"] })
      const token = "placeholder"
      const run = await setup.execute({ planId: plan.planId, actionId: "github", input: { token } })
      const { snapshot, events } = await settle(setup, run.runId)

      expect(snapshot.status).toBe("completed")
      const env = await readFile(join(home, ".env"), "utf8")
      expect(env).toContain("KEEP_ME=1")
      expect(env).toContain("GITHUB_TOKEN=" + token)
      expect(JSON.stringify(snapshot)).not.toContain(token)
      expect(JSON.stringify(events)).not.toContain(token)
      expect(await readFile(setupStatePath(home), "utf8")).not.toContain(token)
      if (process.platform !== "win32") {
        expect((await stat(join(home, ".env"))).mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("an explicit clone-only GitHub skip is persisted without creating credentials", async () => {
    const home = await temporaryHome()
    try {
      const setup = service(home)
      const plan = await setup.plan({ goals: ["github"] })
      const run = await setup.execute({ planId: plan.planId, actionId: "github", input: { skip: true } })
      const { snapshot } = await settle(setup, run.runId)

      expect(snapshot.status).toBe("completed")
      expect(snapshot.result).toEqual({ mode: "clone" })
      expect(existsSync(join(home, ".env"))).toBe(false)

      const state = await readStateJson(home)
      expect(jsonField(jsonField(state, "steps"), "github")).toBe("skipped")

      const reopened = await service(home).inspect()
      expect(reopened.credentials.github.configured).toBe(false)
      expect(reopened.state.steps.github).toBe("skipped")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a provider key merges into auth.json and preserves the other providers", async () => {
    const home = await temporaryHome()
    try {
      const dataDir = join(home, "ellamaka", "data")
      mkdirSync(dataDir, { recursive: true })
      // Unrelated content in auth.json must survive the provider merge; an
      // already-configured provider would satisfy the goal instead.
      await writeFile(join(dataDir, "auth.json"), JSON.stringify({ pluginOverrides: { note: "keep" } }))

      const setup = service(home)
      const plan = await setup.plan({ goals: ["provider"] })
      const run = await setup.execute({
        planId: plan.planId,
        actionId: "provider",
        input: { providerId: "opencode-go", apiKey: "sk-integration" },
      })
      expect((await settle(setup, run.runId)).snapshot.status).toBe("completed")

      const auth: unknown = JSON.parse(await readFile(join(dataDir, "auth.json"), "utf8"))
      expect(jsonField(jsonField(auth, "pluginOverrides"), "note")).toBe("keep")
      expect(JSON.stringify(jsonField(auth, "opencode-go"))).toContain("sk-integration")
      expect(await readFile(setupStatePath(home), "utf8")).not.toContain("sk-integration")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("an optional provider skip persists without creating Runtime credential storage", async () => {
    const home = await temporaryHome()
    try {
      const setup = service(home)
      const plan = await setup.plan({ goals: ["provider"] })
      const run = await setup.execute({ planId: plan.planId, actionId: "provider", input: { skip: true } })
      expect((await settle(setup, run.runId)).snapshot.status).toBe("completed")

      const state = await readStateJson(home)
      expect(jsonField(jsonField(state, "steps"), "provider")).toBe("skipped")
      expect(existsSync(join(home, "ellamaka", "data"))).toBe(false)
      expect((await setup.complete({ planId: plan.planId })).completed).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a materialized Space whose preparation failed keeps its files and reports the partial result", async () => {
    const home = await temporaryHome()
    const spaceRoot = join(home, "spaces", "demo")
    mkdirSync(spaceRoot, { recursive: true })
    try {
      const setup = service(home, { space: fileSpace("failed") })
      const plan = await setup.plan({ goals: ["space"] })
      const run = await setup.execute({
        planId: plan.planId,
        actionId: "space",
        input: { path: spaceRoot, type: "coding" },
      })
      const { snapshot } = await settle(setup, run.runId)

      expect(snapshot.status).toBe("failed")
      expect(snapshot.error?.code).toBe(SETUP_ERROR.preparationFailed)
      expect(snapshot.result?.materialized).toBe(true)
      expect(existsSync(join(spaceRoot, ".wopal-space", "space-meta.json"))).toBe(true)

      const state = await readStateJson(home)
      expect(jsonField(jsonField(state, "steps"), "space")).toBe("failed")
      expect(String(jsonField(jsonField(state, "errors"), "space"))).toContain("bun install failed")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("completion persists across a new service instance", async () => {
    const home = await temporaryHome()
    try {
      const setup = service(home)
      const plan = await setup.plan({ goals: ["foundation"] })
      expect(plan.actions).toEqual([])

      const result = await setup.complete({ planId: plan.planId })
      expect(result.completed).toBe(true)

      const reopened = service(home)
      expect((await reopened.inspect()).state.completed).toBe(true)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("a stored github token is visible to a later inspect and satisfies the goal", async () => {
    const home = await temporaryHome()
    try {
      const setup = service(home)
      const plan = await setup.plan({ goals: ["github"] })
      const run = await setup.execute({
        planId: plan.planId,
        actionId: "github",
        input: { token: "placeholder" },
      })
      expect((await settle(setup, run.runId)).snapshot.status).toBe("completed")

      const facts = await service(home).inspect()
      expect(facts.credentials.github.configured).toBe(true)
      expect(facts.goals).toContain("github")
      expect((await service(home).plan({ goals: ["github"] })).actions).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("a token line is not a GitHub identity until validation succeeds", async () => {
    const home = await temporaryHome()
    try {
      await writeFile(join(home, ".env"), "GITHUB_TOKEN=stale\n")
      const facts = await service(home, { validToken: false }).inspect()
      expect(facts.credentials.github).toEqual({ configured: false })
      expect(facts.goals).not.toContain("github")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a usable local gh identity satisfies GitHub without a Home token", async () => {
    const home = await temporaryHome()
    try {
      const github = createSetupGithubPort(home, {
        runGhIdentity: async () => "octocat\n",
        fetcher: async () => {
          throw new Error("stored-token validation should not run")
        },
      })
      expect(await github.inspect()).toEqual({ configured: true, source: "gh", account: "octocat" })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a verified shell GitHub token satisfies identity without writing it into Home", async () => {
    const home = await temporaryHome()
    try {
      const github = createSetupGithubPort(home, {
        environment: { GITHUB_TOKEN: "shell-token", PATH: process.env.PATH },
        runGhIdentity: async (environment) => {
          expect(environment.GITHUB_TOKEN).toBeUndefined()
          expect(environment.GH_TOKEN).toBeUndefined()
          throw new Error("no gh session")
        },
        fetcher: async (_input, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer shell-token")
          return new Response(JSON.stringify({ login: "shell-user" }), { status: 200 })
        },
      })
      expect(await github.inspect()).toEqual({ configured: true, source: "process-env", account: "shell-user" })
      expect(existsSync(join(home, ".env"))).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  test("a malformed settings.jsonc makes post-Ontology Home seeding fail closed without rewriting it", async () => {
    const home = await temporaryHome()
    try {
      const config = join(home, "config", "settings.jsonc")
      mkdirSync(join(home, "config"), { recursive: true })
      const broken = "{ this is not jsonc"
      await writeFile(config, broken)

      const setup = service(home)
      const plan = await setup.plan({ goals: ["ontology"] })
      const run = await setup.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })
      const { snapshot } = await settle(setup, run.runId)
      expect(snapshot.status).toBe("failed")
      expect(snapshot.error?.code).toBe(SETUP_ERROR.homeConfigFailed)
      expect((await setup.inspect()).home.settings).toEqual({
        present: true,
        valid: false,
        ellamaka: { present: false, valid: false },
      })
      expect(await readFile(config, "utf8")).toBe(broken)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
