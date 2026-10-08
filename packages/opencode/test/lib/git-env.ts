// Repository-locator environment variables, kept in one place so the test
// preload, the fixtures, and the isolation tests can never drift apart.
//
// This module must stay import-free apart from Node built-ins: test/preload.ts
// has to load it before anything from src/, because global/index.ts reads
// WOPAL_HOME at import time.
import path from "node:path"

// git exports these to hook processes so the hook's git commands resolve the
// repository that invoked it. A test process started from a hook inherits them,
// and an unhardened `git init` / `git config` / `git commit` would then operate
// on the real checkout instead of the throwaway directory it was given.
export const GIT_LOCATOR_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const

/**
 * Delete every repository-locator variable from `env` in place (default
 * `process.env`). Unrelated variables are left alone.
 */
export function stripGitLocatorVars(env: Record<string, string | undefined> = process.env): void {
  for (const key of GIT_LOCATOR_VARS) delete env[key]
}

/**
 * Environment for a git command run inside `dir`: every inherited locator
 * variable is stripped and the repository is pinned to `dir`, so the command
 * can only ever touch that directory. `process.env` is spread explicitly
 * because both Bun Shell's `.env()` and Effect's `ChildProcess` replace the
 * child environment wholesale.
 */
export function gitEnv(dir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  stripGitLocatorVars(env)
  env.GIT_DIR = path.join(dir, ".git")
  env.GIT_WORK_TREE = dir
  return env
}
