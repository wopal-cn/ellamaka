import type {
  SetupCredentialStore,
  SetupFacts,
  SetupFoundationPort,
  SetupGithubPort,
  SetupHomeSeedPort,
  SetupOntologyPort,
  SetupSpaceInitResult,
  SetupSpacePort,
  SetupState,
  SetupStateRead,
  SetupStateStore,
} from "../../../src/setup"

export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A complete fact snapshot with every goal unsatisfied unless overridden. */
export function facts(
  input: {
    home?: Partial<SetupFacts["home"]>
    ontology?: Partial<SetupFacts["ontology"]>
    space?: Partial<SetupFacts["space"]>
    github?: Partial<SetupFacts["credentials"]["github"]>
    providers?: readonly string[]
    state?: Partial<SetupFacts["state"]>
  } = {},
): SetupFacts {
  return {
    home: {
      path: "/memory/home",
      binding: {
        mode: "normal",
        source: "shell",
        path: "/memory/home",
        locked: true,
        selectable: false,
        persisted: true,
      },
      writable: true,
      foundation: { ready: false, missing: ["."] },
      settings: { present: false, valid: true, ellamaka: { present: false, valid: false } },
      capabilities: { ready: false, missing: ["agents", "skills", "rules", "commands"] },
      ...input.home,
    },
    ontology: { status: "missing", items: [], ...input.ontology },
    space: { status: "missing", items: [], availableTypes: [], ...input.space },
    credentials: {
      github: { configured: false, ...input.github },
      providers: input.providers ?? [],
    },
    state: {
      status: "absent",
      path: "/memory/home/.setup/ellamaka.json",
      completed: false,
      currentStep: "foundation",
      steps: {},
      ...input.state,
    },
  }
}

export interface MemoryStateStore extends SetupStateStore {
  readonly writes: SetupState[]
  readonly deleted: string[]
  reads: number
}

export function memoryState(initial?: SetupState | "corrupt" | "absent"): MemoryStateStore {
  let current: SetupStateRead =
    initial === "corrupt"
      ? { status: "corrupt", path: "/memory/home/.setup/ellamaka.json", diagnostic: "Setup state is not valid JSON" }
      : initial && initial !== "absent"
        ? { status: "ok", path: "/memory/home/.setup/ellamaka.json", state: initial }
        : { status: "absent", path: "/memory/home/.setup/ellamaka.json" }
  const writes: SetupState[] = []
  return {
    writes,
    deleted: [],
    reads: 0,
    async read() {
      this.reads += 1
      return current
    },
    async write(state: SetupState) {
      writes.push(state)
      current = { status: "ok", path: "/memory/home/.setup/ellamaka.json", state }
      return { ok: true as const }
    },
    async update(change: (read: SetupStateRead) => SetupState | { error: string }) {
      const next = change(current)
      if ("error" in next) return { ok: false as const, reason: next.error }
      writes.push(next)
      current = { status: "ok", path: "/memory/home/.setup/ellamaka.json", state: next }
      return { ok: true as const, state: next }
    },
  }
}

export interface MemoryCredentials extends SetupCredentialStore {
  readonly tokens: string[]
  readonly keys: { providerId: string; apiKey: string }[]
}

export function memoryCredentials(
  input: { providers?: readonly string[]; failWrite?: boolean } = {},
): MemoryCredentials {
  const providers = new Set(input.providers ?? [])
  const tokens: string[] = []
  const keys: { providerId: string; apiKey: string }[] = []
  return {
    tokens,
    keys,
    async setGithubToken(token: string) {
      if (input.failWrite) return { ok: false as const, reason: "env is read-only" }
      tokens.push(token)
      return { ok: true as const, created: true, path: "/memory/home/.env" }
    },
    async providerIds() {
      return [...providers]
    },
    async setProviderKey(entry: { providerId: string; apiKey: string }) {
      if (input.failWrite) return { ok: false as const, reason: "auth.json is read-only" }
      keys.push(entry)
      providers.add(entry.providerId)
      return { ok: true as const, created: true, path: "/memory/home/ellamaka/data/auth.json" }
    },
  }
}

export function memoryGithub(
  input: { configured?: boolean; source?: string; account?: string; validToken?: boolean } = {},
): SetupGithubPort {
  return {
    async inspect() {
      return input.configured
        ? { configured: true, source: input.source ?? "gh", account: input.account ?? "octocat" }
        : { configured: false }
    },
    async verify(token: string) {
      return token === "placeholder" && input.validToken !== false
        ? { valid: true, account: input.account ?? "octocat" }
        : { valid: false, account: null }
    },
  }
}

export interface MemoryHomeSeed extends SetupHomeSeedPort {
  readonly calls: string[]
}

export function memoryHomeSeed(): MemoryHomeSeed {
  const calls: string[] = []
  return {
    calls,
    async seed(ontologyPath: string) {
      calls.push(ontologyPath)
      return {
        settings: { path: "/memory/home/config/settings.jsonc", changed: true },
        capabilities: { created: ["agents", "skills", "rules", "commands"] },
      }
    },
  }
}

export interface MemoryOntology extends SetupOntologyPort {
  readonly installs: { name?: string; source?: string; mode: "fork" | "clone" }[]
}

export function memoryOntology(
  existing?: { name?: string; path?: string; mode: "fork" | "clone" },
  install?: (input: { name?: string; source?: string; mode: "fork" | "clone" }) => Promise<{
    name: string
    path: string
    status: "created" | "reused" | "upgraded"
  }>,
): MemoryOntology {
  const installs: { name?: string; source?: string; mode: "fork" | "clone" }[] = []
  return {
    installs,
    async list() {
      return existing
        ? {
            items: [
              {
                name: existing.name ?? "wopal-space-ontology",
                path: existing.path ?? "/memory/ontology",
                mode: existing.mode,
                available: true,
                readable: true,
              },
            ],
            total: 1,
          }
        : { items: [], total: 0 }
    },
    async install(input) {
      installs.push(input)
      if (install) return install(input)
      return { name: input.name ?? "wopal-space-ontology", path: "/memory/ontology", status: "created" as const }
    },
  }
}

export interface MemorySpace extends SetupSpacePort {
  readonly inits: { name: string; root: string; type: string }[]
}

export function memorySpace(
  init?: (input: { name: string; root: string; type: string }, signal?: AbortSignal) => Promise<SetupSpaceInitResult>,
): MemorySpace {
  const inits: { name: string; root: string; type: string }[] = []
  return {
    inits,
    async list() {
      return { items: [], total: 0 }
    },
    async availableTypes() {
      return [{ type: "coding", description: "Coding workspace" }]
    },
    async init(input, signal) {
      inits.push(input)
      if (init) return init(input, signal)
      return {
        name: input.name,
        path: input.root,
        materialized: true,
        preparation: { status: "ok" as const },
      }
    },
  }
}

export interface MemoryFoundation extends SetupFoundationPort {
  calls: number
}

export function memoryFoundation(): MemoryFoundation {
  const port: MemoryFoundation = {
    calls: 0,
    async ensure() {
      port.calls += 1
      return { path: "/memory/home", created: ["."] }
    },
  }
  return port
}
