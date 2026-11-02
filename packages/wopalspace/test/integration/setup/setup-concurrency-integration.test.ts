import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileCredentials, fileStateStore, parseSetupState, setupStatePath } from "../../../src/setup"

/**
 * Real multi-process checks. Each child is a separate OS process with its own
 * service instance, which is the actual shape of a Server plus a local
 * transport worker, or of a restarting host.
 */
const SETUP_MODULE = JSON.stringify(join(import.meta.dir, "..", "..", "..", "src", "setup"))

function temporaryHome(prefix = "wopal-setup-concurrency-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function startChild(home: string, body: string, args: readonly string[] = []) {
  const script = [
    "const setup = await import(" + SETUP_MODULE + ")",
    "const home = process.env.WOPAL_SETUP_TEST_HOME",
    body,
  ].join(String.fromCharCode(10))
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", script, ...args],
    env: { ...process.env, WOPAL_SETUP_TEST_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  return child.exited
}

const PROVIDER_BODY = [
  "const written = await setup.fileCredentials(home).setProviderKey({",
  "  providerId: process.argv[1],",
  "  apiKey: process.argv[2],",
  "})",
  "if (!written.ok) throw new Error(written.reason)",
].join("\n")

const STATE_BODY = [
  "const step = process.argv[1]",
  "const store = setup.fileStateStore(home)",
  "const written = await store.update((read) => {",
  '  const base = read.status === "ok"',
  "    ? read.state",
  "    : { version: 1, currentStep: step, steps: {}, errors: {}, completed: false, startedAt: null, updatedAt: null }",
  '  return { ...base, currentStep: step, steps: { ...base.steps, [step]: "done" }, updatedAt: new Date().toISOString() }',
  "})",
  "if (!written.ok) throw new Error(written.reason)",
].join("\n")

describe("setup credentials and state across processes", () => {
  test("eight parallel processes writing different providers keep every key", async () => {
    const home = temporaryHome()
    const providers = Array.from({ length: 8 }, (_, index) => ({
      providerId: "provider-" + index,
      apiKey: "sk-key-" + index,
    }))
    try {
      mkdirSync(join(home, "ellamaka", "data"), { recursive: true })
      const exits = await Promise.all(
        providers.map((entry) => startChild(home, PROVIDER_BODY, [entry.providerId, entry.apiKey])),
      )
      expect(exits).toEqual(providers.map(() => 0))

      const auth: unknown = JSON.parse(readFileSync(join(home, "ellamaka", "data", "auth.json"), "utf8"))
      const record = Object.fromEntries(Object.entries(auth && typeof auth === "object" ? auth : {}))
      expect(Object.keys(record).sort()).toEqual(providers.map((entry) => entry.providerId).sort())
      for (const entry of providers) {
        expect(JSON.stringify(record[entry.providerId])).toContain(entry.apiKey)
      }
      expect(existsSync(join(home, "ellamaka", "data", "auth.json.lock"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("parallel processes merging GITHUB_TOKEN leave one token and the other variables", async () => {
    const home = temporaryHome()
    try {
      writeFileSync(join(home, ".env"), ["KEEP_ME=1", ""].join(String.fromCharCode(10)))
      const body = [
        "const written = await setup.fileCredentials(home).setGithubToken(process.argv[1])",
        "if (!written.ok) throw new Error(written.reason)",
      ].join("\n")
      const exits = await Promise.all([0, 1, 2, 3].map((index) => startChild(home, body, ["placeholder" + index])))
      expect(exits).toEqual([0, 0, 0, 0])

      const env = readFileSync(join(home, ".env"), "utf8")
      expect(env).toContain("KEEP_ME=1")
      expect(env.split(String.fromCharCode(10)).filter((line) => line.startsWith("GITHUB_TOKEN="))).toHaveLength(1)
      expect(existsSync(join(home, ".env.lock"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("parallel state updates keep every step instead of overwriting each other", async () => {
    const home = temporaryHome()
    const steps = ["foundation", "ontology", "space", "github", "provider"]
    try {
      mkdirSync(join(home, ".setup"), { recursive: true })
      const exits = await Promise.all(steps.map((step) => startChild(home, STATE_BODY, [step])))
      expect(exits).toEqual(steps.map(() => 0))

      const statePath = setupStatePath(home)
      const text = readFileSync(statePath, "utf8")
      const state = parseSetupState(JSON.parse(text))
      expect(state).toBeDefined()
      for (const step of steps) expect(state?.steps[step]).toBe("done")
      expect(existsSync(statePath + ".lock")).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a lock left by a crashed holder fails closed and preserves both the lock and the data", async () => {
    const home = temporaryHome()
    try {
      const dataDir = join(home, "ellamaka", "data")
      mkdirSync(dataDir, { recursive: true })
      const authPath = join(dataDir, "auth.json")
      const lock = authPath + ".lock"
      const originalAuth = JSON.stringify({ existing: { type: "api", key: "keep" } })
      writeFileSync(authPath, originalAuth)
      // A holder that died long ago: old enough for any age-based policy.
      const abandoned = JSON.stringify({ token: "crashed-owner", acquiredAt: 0 })
      writeFileSync(lock, abandoned)
      const old = new Date(Date.now() - 3_600_000)
      utimesSync(lock, old, old)

      // The bound is injected so the test never waits on a fixed delay.
      const written = await fileCredentials(home, { lockTimeoutMs: 40 }).setProviderKey({
        providerId: "p",
        apiKey: "sk-x",
      })

      expect(written.ok).toBe(false)
      expect(!written.ok && written.reason).toContain("SETUP_LOCK_BUSY")
      expect(readFileSync(authPath, "utf8")).toBe(originalAuth)
      expect(readFileSync(lock, "utf8")).toBe(abandoned)

      // The state file has its own lock; hold it too so the update must fail.
      const stateDir = join(home, ".setup")
      mkdirSync(stateDir, { recursive: true })
      const statePath = setupStatePath(home)
      const stateLock = statePath + ".lock"
      writeFileSync(stateLock, abandoned)

      const stateWritten = await fileStateStore(home, { lockTimeoutMs: 40 }).update(() => ({
        version: 1,
        currentStep: "done",
        steps: { done: "done" },
        errors: {},
        completed: true,
        startedAt: null,
        updatedAt: null,
      }))
      expect(stateWritten.ok).toBe(false)
      expect(!stateWritten.ok && stateWritten.reason).toContain("SETUP_LOCK_BUSY")
      expect(existsSync(statePath)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
