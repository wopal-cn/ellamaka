// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// global/index.ts reads WOPAL_HOME at import time, so we must set it first
import os from "os"
import path from "path"
import { rmSync } from "node:fs"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll, afterEach } from "bun:test"
import { stripGitLocatorVars } from "./lib/git-env"
import { assertProcessStateClean, captureProcessState } from "./lib/process-state-guard"
import { defined, orphanedWorktrees, repositoryOf, resolveTempRoot } from "./lib/temp-root"

// Point TMPDIR at a directory outside every checkout before any fixture can
// read it. TMPDIR is frequently set to a path inside this workspace (agents are
// told to write scratch files under <space>/.wopal-space/.tmp), and a temp dir
// inside a repository makes fixtures resolve that repository instead of their
// own throwaway one: `git worktree add` then registers the worktree in the real
// checkout, where no temp-directory cleanup can ever remove it.
// Remember which checkout the ambient TMPDIR pointed into: that is the repository
// a leaking fixture would register its worktrees in, and it is not necessarily
// the checkout this test process runs from.
const ambientRepository = repositoryOf(os.tmpdir())
const tempRoot = resolveTempRoot()
process.env["TMPDIR"] = tempRoot

// SIGKILL cannot run an exit hook. Reclaim only Homes bearing this preload's
// exact ownership marker and a PID that no longer exists; similarly named
// directories or Homes belonging to running tests must be left untouched.
const homePrefix = "opencode-test-data-"
const homeMarker = ".opencode-test-owner"
async function reapAbandonedTestHomes() {
  for (const entry of await fs.readdir(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const match = /^opencode-test-data-([0-9]+)-[A-Za-z0-9]{6}$/.exec(entry.name)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") continue
    }
    const target = path.join(tempRoot, entry.name)
    if ((await fs.readFile(path.join(target, homeMarker), "utf8").catch(() => undefined)) !== entry.name) continue
    await fs.rm(target, { recursive: true, force: true })
  }
}
await reapAbandonedTestHomes()

// Set WOPAL_HOME FIRST, before any src/ imports
const dir = await fs.mkdtemp(path.join(os.tmpdir(), homePrefix + process.pid + "-"))
// afterAll is skipped by an explicit process.exit(). Keep a synchronous
// fallback for the test Home this process owns; after normal teardown the
// directory is already gone. SIGKILL cannot run any in-process cleanup.
process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
await fs.writeFile(path.join(dir, homeMarker), path.basename(dir))
afterAll(async () => {
  const { Database } = await import("../src/storage/db")
  Database.close()
  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1) throw error
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)

  // Backstop for the leak this suite is most likely to leave behind: a worktree
  // registered in a real checkout whose directory is already gone. Deleting the
  // temp tree removes the files, never the registration in .git/worktrees.
  const watched = [...new Set(defined([repositoryOf(process.cwd()), ambientRepository]))]
  const orphaned = watched.flatMap((repository) => orphanedWorktrees(repository))
  if (orphaned.length > 0)
    throw new Error(
      "test run registered git worktrees in a real checkout and left them behind: " +
        orphaned.join(", ") +
        " — fixtures must create worktrees inside a temp repository, not the current one",
    )
})

process.env["WOPAL_HOME"] = dir
// Isolate wopal-plugin logs to the test temp dir. When a test loads the real
// wopal-plugin, its wopalSpaceRoot resolves to the real space root and would
// otherwise write into <space>/.wopal-space/logs/wopal-plugin.log.
process.env["WOPAL_PLUGIN_LOG_FILE"] = path.join(dir, "wopal-plugin.log")
process.env["ELLAMAKA_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
process.env["OPENCODE_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
process.env["OPENCODE_EXPERIMENTAL_WORKSPACES"] = "true"

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["OPENCODE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "ellamaka", "cache")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["ELLAMAKA_SERVER_PASSWORD"]
delete process.env["ELLAMAKA_SERVER_USERNAME"]

// git exports its repository-locator variables (GIT_DIR, GIT_WORK_TREE, ...) to
// hook processes. A test run started from a git hook inherits them, and a test
// that runs bare `git` without the fixture would then resolve — and write — the
// real checkout instead of its own temporary directory. Strip them for the
// whole test process; the fixture re-pins them per temp directory when needed.
stripGitLocatorVars()

// Clear WopalSpace flags so tests run in standard opencode mode.
// WopalSpace-specific tests set these explicitly in their own setup.
delete process.env["WOPAL_SPACE"]
delete process.env["WOPAL_SPACE_ROOT"]
process.env["WOPAL_DEBUG_LOG_DIR"] = path.join(dir, "logs")

// Use in-memory sqlite
process.env["OPENCODE_DB"] = ":memory:"

// Global.ensure creates the runtime directories (data/config/state/log/...)
// explicitly since the module-load-time mkdir was removed from core global.
// The CLI entry calls it at startup; tests bypass that entry, so the isolated
// per-PID Home must ensure here or fixture writes into config/ hit ENOENT.
{
  const { Global } = await import("@wopal/ellamaka-core/global")
  await Global.ensure()
}

// Now safe to import from src/
const { Log } = await import("@wopal/ellamaka-core/util/log")
const { initProjectors } = await import("../src/server/projectors")

void Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

initProjectors()

// Capture after all process-wide test bootstrap has finished, but before the
// first test file can mutate process.env/cwd. Bun runs a preload afterEach only
// after the test file's own cleanup hooks, so this detects real leaks rather
// than temporary scoped mutations. Restore before throwing to prevent one bad
// test from contaminating every test that follows it.
const processStateBaseline = captureProcessState()
afterEach(() => assertProcessStateClean(processStateBaseline))
afterAll(() => assertProcessStateClean(processStateBaseline))
