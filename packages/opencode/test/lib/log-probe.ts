// Shared probes for entry-level logging behavior (directory routing and level
// resolution). Each helper spawns the REAL CLI entry (`src/index.ts`) inside a
// throwaway WopalSpace (a temp dir with the `.wopal/.git` marker) and a temp
// `WOPAL_HOME`, so nothing touches the caller's real home.
//
// Isolation: WOPAL_HOME points at a temp home, external plugins and DSH are
// off, and the level is pinned by each probe's own env/argv.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const opencodeRoot = resolve(import.meta.dir, "../..")
const cliEntry = join(opencodeRoot, "src/index.ts")

const tempDirs: string[] = []

/** Remove every temp dir a probe created (call from `afterAll`). */
export function cleanupProbes() {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** A temp WopalSpace root (with the `.wopal/.git` worktree marker) + global home. */
export function makeProbe() {
  const root = mkdtempSync(join(tmpdir(), "ellamaka-log-probe-"))
  tempDirs.push(root)
  mkdirSync(join(root, ".wopal"), { recursive: true })
  writeFileSync(join(root, ".wopal", ".git"), "")
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  return { root, home }
}

/** A deterministic, side-effect-free environment for the spawned CLI. */
export function probeEnv(wopalHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    WOPAL_HOME: wopalHome,
    OPENCODE_PURE: "1",
    ELLAMAKA_DSH: "0",
    ELLAMAKA_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    ...extra,
  }
}

/** Run the real CLI entry to completion and return its captured output. */
export function runCli(args: string[], opts: { cwd: string; env: Record<string, string> }) {
  const result = Bun.spawnSync({
    cmd: ["bun", "run", "--conditions=browser", cliEntry, ...args],
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/** Spawn `serve --port 0`, wait for the listening URL, then return the handle. */
export async function startServe(cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", cliEntry, "serve", "--port", "0"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let url: string | undefined
  const deadline = Date.now() + 45_000
  while (!url && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    output += decoder.decode(value, { stream: true })
    const match = output.match(/listening on (http:\/\/[^\s]+)/)
    if (match) url = match[1]
  }
  if (!url) {
    proc.kill()
    throw new Error(`serve did not become ready in time:\n${output.slice(-1000)}`)
  }
  return { proc, url }
}
