import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { tmpdir, tmpdirScoped } from "./fixture"
import { GIT_LOCATOR_VARS, stripGitLocatorVars } from "../lib/git-env"

// git exports the repository-locator variables to hook processes (GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE, ...). A test process started from a hook
// therefore inherits them, and an unhardened fixture would run its own
// `git init` / `git config` / `git commit` against the real checkout instead of
// the throwaway directory it just created. These tests pin that behavior with a
// decoy repository as the leaked target, so no real repository is ever at risk.

/** Inherited environment with every repository-locator variable stripped. */
function cleanGitEnv(): Record<string, string | undefined> {
  // `stripGitLocatorVars` mutates in place and returns void, so build the copy
  // first: passing its return value to `.env()` would yield `undefined` and let
  // the leaked variables through.
  const env: Record<string, string | undefined> = { ...process.env }
  stripGitLocatorVars(env)
  return env
}

/**
 * Point every repository-locator variable at `decoy`, simulating the leak a git
 * hook performs, and return a function that restores the previous values.
 */
function leakGitEnv(decoy: string) {
  const saved: Record<string, string | undefined> = {}
  for (const key of GIT_LOCATOR_VARS) saved[key] = process.env[key]
  process.env.GIT_DIR = path.join(decoy, ".git")
  process.env.GIT_WORK_TREE = decoy
  process.env.GIT_INDEX_FILE = path.join(decoy, ".git", "index")
  return () => {
    for (const key of GIT_LOCATOR_VARS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A real, throwaway repository built with a clean environment. */
async function createDecoy() {
  const decoy = path.join(os.tmpdir(), "opencode-test-decoy-" + Math.random().toString(36).slice(2))
  await fs.mkdir(decoy, { recursive: true })
  await $`git init`.cwd(decoy).quiet().env(cleanGitEnv())
  await $`git config user.email "decoy@opencode.test"`.cwd(decoy).quiet().env(cleanGitEnv())
  await $`git config user.name "Decoy"`.cwd(decoy).quiet().env(cleanGitEnv())
  await $`git commit --allow-empty -m "decoy root commit"`.cwd(decoy).quiet().env(cleanGitEnv())
  return decoy
}

describe("fixture git isolation", () => {
  test("tmpdir({git:true}) ignores a leaked GIT_DIR and never writes the leaked repository", async () => {
    const decoy = await createDecoy()
    try {
      const configBefore = await fs.readFile(path.join(decoy, ".git", "config"))
      const headBefore = await fs.readFile(path.join(decoy, ".git", "HEAD"))
      const restore = leakGitEnv(decoy)
      try {
        await using tmp = await tmpdir({ git: true })

        // (b) The leaked target is byte-identical: the fixture wrote nothing to it.
        expect(await fs.readFile(path.join(decoy, ".git", "config"))).toEqual(configBefore)
        expect(await fs.readFile(path.join(decoy, ".git", "HEAD"))).toEqual(headBefore)

        // (a) The repository the fixture produced is its own temporary directory.
        const toplevel = (await $`git rev-parse --show-toplevel`.cwd(tmp.path).quiet().env(cleanGitEnv())).text().trim()
        expect(toplevel).toBe(tmp.path)
        const gitDir = (await $`git rev-parse --absolute-git-dir`.cwd(tmp.path).quiet().env(cleanGitEnv()))
          .text()
          .trim()
        expect(gitDir).toBe(path.join(tmp.path, ".git"))
      } finally {
        restore()
      }

      // Disposal issues its own git command; the decoy must still be untouched.
      expect(await fs.readFile(path.join(decoy, ".git", "config"))).toEqual(configBefore)
      expect(await fs.readFile(path.join(decoy, ".git", "HEAD"))).toEqual(headBefore)
    } finally {
      await fs.rm(decoy, { recursive: true, force: true })
    }
  })

  test("tmpdirScoped({git:true}) ignores a leaked GIT_DIR and never writes the leaked repository", async () => {
    const decoy = await createDecoy()
    try {
      const configBefore = await fs.readFile(path.join(decoy, ".git", "config"))
      const headBefore = await fs.readFile(path.join(decoy, ".git", "HEAD"))
      const restore = leakGitEnv(decoy)
      try {
        const probe = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const dir = yield* tmpdirScoped({ git: true })
              const toplevel = yield* Effect.promise(() =>
                $`git rev-parse --show-toplevel`.cwd(dir).quiet().env(cleanGitEnv()).text(),
              )
              return { dir, toplevel: toplevel.trim() }
            }),
          ).pipe(Effect.provide(CrossSpawnSpawner.defaultLayer)),
        )
        expect(probe.toplevel).toBe(probe.dir)
        expect(await fs.readFile(path.join(decoy, ".git", "config"))).toEqual(configBefore)
        expect(await fs.readFile(path.join(decoy, ".git", "HEAD"))).toEqual(headBefore)
      } finally {
        restore()
      }

      expect(await fs.readFile(path.join(decoy, ".git", "config"))).toEqual(configBefore)
      expect(await fs.readFile(path.join(decoy, ".git", "HEAD"))).toEqual(headBefore)
    } finally {
      await fs.rm(decoy, { recursive: true, force: true })
    }
  })
})
