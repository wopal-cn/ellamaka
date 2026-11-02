import { describe, expect, test } from "bun:test"
import { createFactSource, setupStatePath, type SetupHomeBindingFacts } from "../../../src/setup"

describe("Setup facts", () => {
  test("an unconfirmed Home returns bootstrap facts without reading candidate Home resources", async () => {
    const home = "/candidate/home"
    const binding: SetupHomeBindingFacts = {
      mode: "development",
      source: "default",
      path: home,
      locked: false,
      selectable: true,
      persisted: false,
    }
    const calls = {
      state: 0,
      ontology: 0,
      space: 0,
      types: 0,
      github: 0,
      providers: 0,
    }

    const source = createFactSource({
      wopalHome: home,
      homeBinding: () => binding,
      state: {
        async read() {
          calls.state += 1
          throw new Error("candidate state must not be read")
        },
        async write() {
          throw new Error("candidate state must not be written")
        },
        async update() {
          throw new Error("candidate state must not be updated")
        },
      },
      ontology: {
        async list() {
          calls.ontology += 1
          throw new Error("candidate Ontology must not be read")
        },
        async install() {
          throw new Error("candidate Ontology must not be installed")
        },
      },
      space: {
        async list() {
          calls.space += 1
          throw new Error("candidate Space must not be read")
        },
        async availableTypes() {
          calls.types += 1
          throw new Error("candidate archetypes must not be read")
        },
        async init() {
          throw new Error("candidate Space must not be initialized")
        },
      },
      github: {
        async inspect() {
          calls.github += 1
          throw new Error("GitHub identity must not be probed before Home confirmation")
        },
        async verify() {
          throw new Error("GitHub token must not be verified during inspect")
        },
      },
      credentials: {
        async setGithubToken() {
          throw new Error("credentials must not be written during inspect")
        },
        async providerIds() {
          calls.providers += 1
          throw new Error("candidate provider credentials must not be read")
        },
        async setProviderKey() {
          throw new Error("credentials must not be written during inspect")
        },
      },
    })

    const facts = await source.read()

    expect(calls).toEqual({ state: 0, ontology: 0, space: 0, types: 0, github: 0, providers: 0 })
    expect(facts.home.binding).toEqual(binding)
    expect(facts.home.path).toBe(home)
    expect(facts.home.writable).toBe(false)
    expect(facts.home.foundation).toEqual({ ready: false, missing: ["."] })
    expect(facts.ontology).toEqual({ status: "missing", items: [] })
    expect(facts.space).toEqual({ status: "missing", items: [], availableTypes: [] })
    expect(facts.credentials).toEqual({ github: { configured: false }, providers: [] })
    expect(facts.state).toEqual({
      status: "absent",
      path: setupStatePath(home),
      completed: false,
      currentStep: "foundation",
      steps: {},
    })
  })
})
