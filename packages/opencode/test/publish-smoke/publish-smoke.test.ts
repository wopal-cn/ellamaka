import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

// Publish-shape smoke test: build -> pack -> install into a throwaway project
// -> import every published entrypoint.
//
// The static contract test (`test/plugin-sdk-branding.test.ts`) only reads
// manifests, so it cannot see a package that installs but fails to resolve at
// runtime — the sdk shipped a runtime import of the private
// `@wopal/ellamaka-brand` and every manifest assertion stayed green. This test
// exercises the real artifact instead: the tarball is installed as a copy (not
// a workspace link), so anything missing from `dependencies` fails here.
//
// Isolation: all build/pack/install work happens in the system temp dir. The
// only repository writes are the packages' own gitignored `dist/` output.

// test/publish-smoke -> test -> packages/opencode -> packages -> repo root
const root = path.join(import.meta.dir, "../../../..")

interface PublishTarget {
  dir: string
  name: string
  subpaths: string[]
}

const TARGETS: PublishTarget[] = [
  {
    dir: "packages/sdk/js",
    name: "@wopal/ellamaka-sdk",
    subpaths: [".", "./client", "./server", "./v2", "./v2/client", "./v2/gen/client", "./v2/server"],
  },
  {
    dir: "packages/plugin",
    name: "@wopal/ellamaka-plugin",
    subpaths: [".", "./tool", "./tui"],
  },
]

const TIMEOUT = 300_000

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function mustRun(cmd: string[], cwd: string, what: string) {
  const result = await run(cmd, cwd)
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (${cmd.join(" ")}):\n${result.stderr || result.stdout}`)
  }
  return result
}

interface RootManifest {
  workspaces?: { catalog?: Record<string, string> }
}

interface PackedManifest {
  exports: Record<string, unknown>
  [key: string]: unknown
}

// Reads a workspace manifest we control into its expected shape. Callers still
// validate every field they consume (see `catalogVersion`, `publishExports`).
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function catalogVersion(name: string): Promise<string> {
  const rootPkg = await readJson<RootManifest>(path.join(root, "package.json"))
  const version = rootPkg.workspaces?.catalog?.[name]
  if (typeof version !== "string") throw new Error(`no workspace catalog entry for ${name}`)
  return version
}

// The publish step rewrites the dev `exports` (`./src/*.ts`) into the shipped
// dist entrypoints. Use the real implementation the release flow runs, so a
// broken transform fails here instead of only in the publish job.
import { rewriteExports } from "../../../ellamaka-release/src/npm/exports"

async function only(dir: string, extension: string): Promise<string> {
  const matches = (await fs.readdir(dir)).filter((name) => name.endsWith(extension))
  if (matches.length !== 1) throw new Error(`expected exactly one ${extension} in ${dir}, got ${matches.join(", ")}`)
  return path.join(dir, matches[0])
}

async function publishTarball(target: PublishTarget, tmp: string): Promise<string> {
  const pkgDir = path.join(root, target.dir)
  const slug = target.name.replace(/[@/]/g, "_")

  await mustRun(["bun", "run", "build"], pkgDir, `build ${target.name}`)

  // Pack once in place: bun rewrites `workspace:*` and `catalog:` specs into
  // concrete versions, exactly as a real publish would.
  const first = path.join(tmp, "pack", slug)
  await fs.mkdir(first, { recursive: true })
  await mustRun(["bun", "pm", "pack", "--destination", first], pkgDir, `pack ${target.name}`)

  // Extract, apply the publish-time exports rewrite, and repack so the tarball
  // under test has the shape npm consumers actually receive.
  const stage = path.join(tmp, "stage", slug)
  await fs.mkdir(stage, { recursive: true })
  await mustRun(["tar", "-xzf", await only(first, ".tgz"), "-C", stage], tmp, `extract ${target.name}`)

  const pkgRoot = path.join(stage, "package")
  const manifestPath = path.join(pkgRoot, "package.json")
  const manifest = await readJson<PackedManifest>(manifestPath)
  const publishedExports = rewriteExports(manifest.exports)
  await fs.writeFile(manifestPath, `${JSON.stringify({ ...manifest, exports: publishedExports }, null, 2)}\n`)

  const second = path.join(tmp, "publish", slug)
  await fs.mkdir(second, { recursive: true })
  await mustRun(["bun", "pm", "pack", "--destination", second], pkgRoot, `repack ${target.name}`)

  const tarball = await only(second, ".tgz")

  // Every subpath must ship its dist file, not a dangling source path.
  const listing = (await mustRun(["tar", "-tzf", tarball], tmp, `list ${target.name}`)).stdout
  for (const entry of Object.values(publishedExports)) {
    const importTarget = `package/${entry.import.replace(/^\.\//, "")}`
    expect(listing).toContain(importTarget)
  }

  return tarball
}

describe("published plugin/sdk packages install and import", () => {
  let tmp: string
  let consumer: string
  const tarballs = new Map<string, string>()

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ellamaka-publish-smoke-"))
    // sdk first: the plugin depends on it.
    for (const target of TARGETS) tarballs.set(target.name, await publishTarball(target, tmp))

    consumer = path.join(tmp, "consumer")
    await fs.mkdir(consumer, { recursive: true })
    const sdkTarball = tarballs.get("@wopal/ellamaka-sdk")!
    await fs.writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "ellamaka-publish-smoke",
          private: true,
          type: "module",
          dependencies: {
            ...Object.fromEntries([...tarballs].map(([name, file]) => [name, `file:${file}`])),
            // `@wopal/ellamaka-plugin/tui` imports `@opentui/keymap/extras` at
            // runtime. The plugin declares the opentui packages as optional
            // peers, so a consumer of the TUI surface must provide them.
            "@opentui/keymap": await catalogVersion("@opentui/keymap"),
          },
          // The plugin depends on `@wopal/ellamaka-sdk@2.0.5` by version, which
          // only exists on npm once the sdk is published. Point that range at
          // the freshly packed sdk so the pair can be installed pre-publish —
          // the plugin artifact itself stays untouched.
          overrides: { "@wopal/ellamaka-sdk": `file:${sdkTarball}` },
        },
        null,
        2,
      )}\n`,
    )
    await mustRun(["bun", "install"], consumer, "install published tarballs")
  }, TIMEOUT)

  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  for (const target of TARGETS) {
    test(
      `${target.name} imports its root entrypoint and every export subpath`,
      async () => {
        const script = `
          const failures = []
          for (const subpath of ${JSON.stringify(target.subpaths)}) {
            const spec = subpath === "." ? ${JSON.stringify(target.name)} : ${JSON.stringify(target.name)} + subpath.slice(1)
            try {
              await import(spec)
            } catch (error) {
              failures.push(spec + " -> " + (error && error.message ? error.message : String(error)))
            }
          }
          if (failures.length > 0) {
            console.error(failures.join("\\n"))
            process.exit(1)
          }
          console.log("imported " + ${JSON.stringify(target.subpaths.length)} + " subpaths")
        `
        const result = await run(["bun", "-e", script], consumer)
        if (result.exitCode !== 0) {
          throw new Error(`import failed for ${target.name}:\n${result.stderr || result.stdout}`)
        }
        expect(result.exitCode).toBe(0)
      },
      TIMEOUT,
    )
  }
})
