import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import assemblyFiles from "./assembly-files.json"

/** Inputs copied from Wopal CLI d90b7a99 tests/helpers/{capability,space-sync}-fixture.ts.
 * All repositories/remotes are local. No environment or real Home is mutated.
 */
export function createCompatibilityFixture(parent: string, mode: "clone" | "fork" = "clone") {
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "wopalspace-compatibility-"))
  const home = join(root, "home")
  const ontology = join(home, "ontologies", "test-onto")
  const space = join(root, "space")
  const worktree = join(space, ".wopal")
  const origin = join(root, "origin.git")
  const upstream = mode === "fork" ? join(root, "upstream.git") : origin
  const env = {
    ...process.env,
    WOPAL_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "Compatibility Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Compatibility Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-27T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-27T00:00:00Z",
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    }).trim()
  const write = (cwd: string, path: string, text: string) => {
    const file = join(cwd, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const commit = (cwd: string, path: string, text: string, message = `update ${path}`) => {
    write(cwd, path, text)
    git(cwd, "add", "--sparse", "--", path)
    git(cwd, "commit", "-m", message)
    return git(cwd, "rev-parse", "HEAD")
  }
  const dispose = () => rmSync(root, { recursive: true, force: true })
  try {
    writeFileSync(join(root, "gitconfig"), "")
    mkdirSync(ontology, { recursive: true })
    mkdirSync(space, { recursive: true })
    git(ontology, "init", "-q", "-b", "main")
    for (const [path, text] of Object.entries(assemblyFiles)) write(ontology, path, text)
    git(ontology, "add", ".")
    git(ontology, "commit", "-qm", "add assembly baseline")
    git(root, "clone", "--bare", ontology, origin)
    git(ontology, "remote", "add", "origin", origin)
    git(ontology, "fetch", "origin")
    if (mode === "fork") {
      git(root, "clone", "--bare", ontology, upstream)
      git(ontology, "remote", "add", "upstream", upstream)
      git(ontology, "fetch", "upstream")
    }
    git(space, "init", "-q", "-b", "main")
    write(
      space,
      ".wopal-space/space-meta.json",
      JSON.stringify(
        {
          version: 2,
          type: "coding",
          schema: "coding-space-schema.yaml",
          source: { ontology: "test-onto" },
          include: [],
          exclude: [],
          private: [],
        },
        null,
        2,
      ) + "\n",
    )
    git(ontology, "branch", "space/demo-space")
    git(ontology, "worktree", "add", "--no-checkout", worktree, "space/demo-space")
    const settings = {
      ontologies: { "test-onto": { path: ontology, upstream, fork: mode === "fork" } },
      spaces: {
        "demo-space": {
          name: "demo-space",
          path: space,
          ontology: "test-onto",
          branch: "space/demo-space",
          type: "coding",
        },
      },
    }
    write(home, "config/settings.jsonc", JSON.stringify(settings, null, 2) + "\n")
    return {
      root,
      home,
      ontology,
      space,
      worktree,
      origin,
      upstream,
      env,
      git,
      write,
      commit,
      dispose,
      applySparse(patterns: readonly string[]) {
        git(worktree, "sparse-checkout", "init", "--no-cone")
        const path = git(worktree, "rev-parse", "--git-path", "info/sparse-checkout")
        writeFileSync(path, patterns.join("\n") + "\n")
        git(worktree, "read-tree", "-mu", "HEAD")
      },
      snapshot() {
        const sparse = git(worktree, "rev-parse", "--git-path", "info/sparse-checkout")
        const common = resolve(ontology, git(ontology, "rev-parse", "--git-common-dir"))
        const objectRoot = join(common, "objects")
        const objects: Record<string, string> = {}
        for (const path of readdirSync(objectRoot, { recursive: true, withFileTypes: true })) {
          if (!path.isFile()) continue
          const file = join(path.parentPath, path.name)
          objects[file.slice(objectRoot.length + 1)] = createHash("sha256").update(readFileSync(file)).digest("hex")
        }
        const files: Record<string, string | null> = {}
        for (const path of git(worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
          .split("\0")
          .filter(Boolean)) {
          const file = join(worktree, path)
          files[path] = existsSync(file) ? readFileSync(file).toString("base64") : null
        }
        return {
          refs: git(ontology, "show-ref"),
          hostStatus: git(ontology, "status", "--porcelain=v1"),
          spaceStatus: git(worktree, "status", "--porcelain=v1"),
          index: git(worktree, "ls-files", "--stage"),
          sparse: existsSync(sparse) ? readFileSync(sparse, "utf8") : null,
          meta: readFileSync(join(space, ".wopal-space/space-meta.json"), "utf8"),
          registry: readFileSync(join(home, "config/settings.jsonc"), "utf8"),
          fetchHead: existsSync(join(common, "FETCH_HEAD")) ? readFileSync(join(common, "FETCH_HEAD"), "utf8") : null,
          objects,
          files,
        }
      },
    }
  } catch (error) {
    dispose()
    throw error
  }
}

export type CompatibilityFixture = ReturnType<typeof createCompatibilityFixture>
