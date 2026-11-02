import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

/** Real local Git remotes, Home, registry, and assembly. No process env or global config mutation. */
export function createOntologyFixture(mode: "clone" | "fork" = "clone") {
  const root = mkdtempSync(join(tmpdir(), "wopalspace-ontology-"))
  const home = join(root, "home")
  const seed = join(root, "seed")
  const upstream = join(root, "upstream.git")
  const origin = join(root, "origin.git")
  const gitConfig = join(root, "gitconfig")
  writeFileSync(gitConfig, "")
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_AUTHOR_NAME: "Ontology Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Ontology Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-27T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-10-27T00:00:00Z",
  }
  const git = (cwd: string, ...args: string[]) => {
    return execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    }).trim()
  }
  const write = (cwd: string, path: string, content: string) => {
    const file = join(cwd, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const commit = (cwd: string, path: string, content: string, message = `update ${path}`) => {
    write(cwd, path, content)
    git(cwd, "add", "--", path)
    git(cwd, "commit", "-qm", message)
    return git(cwd, "rev-parse", "HEAD")
  }
  try {
    mkdirSync(seed, { recursive: true })
    mkdirSync(home, { recursive: true })
    git(seed, "init", "-q")
    write(
      seed,
      "assembly/archetypes/coding.yaml",
      "version: 1\ntype: coding\nagents: []\nskills: []\nrules: []\ncommands: []\nplugins: {}\n",
    )
    write(
      seed,
      "assembly/schemas/coding-space-schema.yaml",
      "version: 1\nruntime:\n  path: .wopal-space\nspace:\n  files: []\n  dirs: []\n",
    )
    write(seed, "agents/wopal.md", "---\ndescription: Agent\n---\n# wopal\n")
    write(seed, "skills/demo/SKILL.md", "---\ndescription: Demo skill\n---\n# demo\n")
    write(seed, "rules/rule.md", "---\ndescription: Rule\n---\n")
    write(seed, "commands/cmd.md", "---\ndescription: Command\n---\n")
    write(seed, "plugins/plug/package.json", '{"name":"plug","description":"Plugin"}\n')
    write(seed, "README.md", "# ontology\n")
    git(seed, "add", ".")
    git(seed, "commit", "-qm", "assembly baseline")
    git(root, "clone", "--bare", seed, upstream)
    if (mode === "clone") git(root, "clone", "--bare", seed, origin)
    else git(root, "clone", "--bare", upstream, origin)
    const settings = {
      ontologies: {},
      spaces: {},
    }
    write(home, "config/settings.jsonc", JSON.stringify(settings, null, 2) + "\n")
    return {
      root,
      home,
      seed,
      upstream,
      origin,
      env,
      git,
      write,
      commit,
      dispose: () => rmSync(root, { recursive: true, force: true }),
      source: mode === "fork" ? origin : upstream,
      snapshot(repo: string) {
        const objects = join(repo, ".git/objects")
        const record: Record<string, string> = {}
        if (statSync(objects).isDirectory()) {
          for (const item of readdirSync(objects, { recursive: true, withFileTypes: true })) {
            if (item.isFile()) {
              const file = join(item.parentPath, item.name)
              record[file.slice(objects.length + 1)] = readFileSync(file).toString("base64")
            }
          }
        }
        return {
          refs: git(repo, "show-ref"),
          status: git(repo, "status", "--porcelain=v1"),
          head: git(repo, "rev-parse", "HEAD"),
          fetchHead: exists(join(repo, ".git/FETCH_HEAD")),
          objects: record,
        }
      },
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export type OntologyFixture = ReturnType<typeof createOntologyFixture>
