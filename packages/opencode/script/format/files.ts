#!/usr/bin/env bun
/**
 * Formatting scope: the single file list both `bun run format` and
 * `bun run format:check` hand to Prettier.
 *
 * Usage:
 *   bun run packages/opencode/script/format/files.ts                 # NUL-separated paths on stdout
 *   bun run packages/opencode/script/format/files.ts --contains <path>...
 *   bun run packages/opencode/script/format/files.ts --intersect     # filter NUL-separated stdin
 *
 * The list starts from `git ls-files` instead of a directory walk: a walk
 * inherits ancestor `.gitignore` rules and silently produces a different set
 * locally than in CI.
 *
 * Every exclusion has exactly one home:
 * - `.prettierignore` is the scope source of truth. It drops the two
 *   upstream-inherited packages (`packages/opencode/`, `packages/ui/`, which
 *   also covers lint-only `src/wopal/` and `src/workbench/`), generated code
 *   (`**\/gen/`, `**\/*.gen.ts`), the `poc/` experiment directory, and build
 *   output plus generated manifests.
 * - The extension allowlist below admits only formats Prettier parses. It is an
 *   explicit allowlist, not content sniffing: binary assets, images and Shell
 *   scripts (`*.sh`) never enter because they are not listed, so the scope stays
 *   deterministic without reading every candidate's bytes.
 * - `lstat` drops tracked symlinks and non-regular files. A symlinked asset (for
 *   example `packages/ellamaka-app/public/*.png`) points at a file this
 *   repository does not own, and Prettier would follow the link and rewrite it.
 * - `prettier.getFileInfo` resolves the survivors, so ignore matching stays
 *   Prettier's own semantics rather than a re-implemented glob matcher.
 */

import { lstatSync } from "node:fs"
import path from "node:path"
import * as prettier from "prettier"
import { findRepoRoot } from "../lint-gate/check"

/** The extensions Prettier can parse that this repository tracks. */
export const FORMAT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".css",
  ".scss",
  ".yml",
  ".yaml",
  ".html",
]

const USAGE = [
  "usage:",
  "  bun run packages/opencode/script/format/files.ts                # print NUL-separated paths",
  "  bun run packages/opencode/script/format/files.ts --contains <path>...",
  "  bun run packages/opencode/script/format/files.ts --intersect    # filter NUL-separated stdin",
].join("\n")

/** Whether the extension is one Prettier can parse and this repository formats. */
export function isFormatExtension(file: string) {
  return FORMAT_EXTENSIONS.includes(path.extname(file).toLowerCase())
}

/**
 * Tracked paths with a formattable extension, relative to the repository root.
 *
 * `-z` plus NUL splitting keeps names containing spaces whole.
 */
export async function collectTrackedFiles(root: string): Promise<string[]> {
  const pathspecs = FORMAT_EXTENSIONS.map((extension) => "*" + extension)
  const proc = Bun.spawn(["git", "ls-files", "-z", "--", ...pathspecs], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error("git ls-files failed: " + stderr.trim())
  return stdout.split("\0").filter((file) => file.length > 0)
}

/**
 * Repository-relative files Prettier should read: tracked, regular, inside the
 * `.prettierignore` scope, and parseable by Prettier.
 *
 * Returns repository-relative POSIX paths in `git ls-files` order.
 */
export async function listFormatFiles(root: string): Promise<string[]> {
  const ignorePath = path.join(root, ".prettierignore")
  const selected: string[] = []
  for (const file of await collectTrackedFiles(root)) {
    if (!isFormatExtension(file)) continue
    // A tracked path may be absent from the working tree (deleted but not
    // staged) or be a symlink; neither is a file this repository formats.
    const stat = lstatSync(path.join(root, file), { throwIfNoEntry: false })
    if (!stat?.isFile()) continue
    const info = await prettier.getFileInfo(path.join(root, file), { ignorePath })
    if (info.ignored || info.inferredParser === null) continue
    selected.push(file)
  }
  return selected
}

/**
 * A candidate path expressed as a repository-relative POSIX path, or
 * `undefined` when it resolves outside the repository.
 */
function toScopePath(root: string, raw: string) {
  const relative = path.relative(root, path.resolve(root, raw)).split(path.sep).join("/")
  if (relative === "" || relative === ".." || relative.startsWith("../")) return undefined
  return relative
}

function reportContains(root: string, files: ReadonlySet<string>, wanted: string[]) {
  const lines: string[] = []
  let missing = 0
  for (const raw of wanted) {
    const relative = toScopePath(root, raw) ?? raw
    const inside = files.has(relative)
    if (!inside) missing += 1
    lines.push((inside ? "in     " : "not in ") + relative)
  }
  lines.push(`${wanted.length - missing}/${wanted.length} paths in the format scope (${files.size} files)`)
  process.stdout.write(lines.join("\n") + "\n")
  return missing === 0
}

/**
 * The subset of `candidates` that the format scope already contains.
 *
 * Membership is decided against the `listFormatFiles` result, never by
 * re-deriving the scope: the commit hook must agree with `bun run format` by
 * construction, not by a second copy of the ignore and extension rules.
 */
export function intersectFormatFiles(root: string, scope: ReadonlySet<string>, candidates: Iterable<string>) {
  const selected: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const relative = toScopePath(root, candidate)
    if (!relative || !scope.has(relative) || seen.has(relative)) continue
    seen.add(relative)
    selected.push(relative)
  }
  return selected
}

async function main(argv: string[]) {
  const root = findRepoRoot(import.meta.dir)
  const files = await listFormatFiles(root)

  if (argv[0] === "--contains") {
    const wanted = argv.slice(1)
    if (wanted.length === 0) {
      process.stderr.write("--contains needs at least one path\n" + USAGE + "\n")
      process.exit(2)
    }
    if (!reportContains(root, new Set(files), wanted)) process.exit(1)
    return
  }
  if (argv[0] === "--intersect") {
    if (argv.length > 1) {
      process.stderr.write("--intersect takes no paths; pipe them on stdin\n" + USAGE + "\n")
      process.exit(2)
    }
    if (process.stdin.isTTY) {
      process.stderr.write("--intersect reads NUL-separated paths from stdin\n" + USAGE + "\n")
      process.exit(2)
    }
    const candidates = (await Bun.stdin.text()).split("\0").filter((file) => file.length > 0)
    process.stdout.write(intersectFormatFiles(root, new Set(files), candidates).map((file) => file + "\0").join(""))
    return
  }
  if (argv.length > 0) {
    process.stderr.write("unknown argument: " + argv[0] + "\n" + USAGE + "\n")
    process.exit(2)
  }
  // NUL-terminate every entry so `xargs -0` keeps paths containing spaces whole
  // and an empty list produces no argument at all.
  process.stdout.write(files.map((file) => file + "\0").join(""))
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write("format scope: " + (error instanceof Error ? error.message : String(error)) + "\n")
    process.exit(1)
  })
}
