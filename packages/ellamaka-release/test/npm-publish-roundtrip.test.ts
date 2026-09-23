import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { gunzipSync } from "node:zlib"
import { tarballContentDigest } from "../src/npm/content"
import { isJsonObject, parseJsonObject } from "../src/npm/json"
import { createBunRuntime, packLocalTarball } from "../src/npm/execute"
import type { PublishPlanEntry } from "../src/npm/plan"

// The skip guard only works if both sides of the comparison agree on what "the
// same package" means: the registry side is whatever bytes a published tarball
// holds, the local side is whatever `bun pm pack` produces. This test wires the
// real primitives end to end - build, pack, publish through the real
// `npm publish`, download it back the way `verify.ts` does - and requires the
// digests to match. It is the only place the seam between the two packers is
// exercised for real; everything else mocks it.
//
// No network and no real publish: `npm publish` targets a throwaway registry
// served in-process by `Bun.serve`.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

interface StoredPackage {
  /** The packument npm PUTs: served back verbatim on GET. */
  document: Record<string, unknown>
  tarballName: string
  data: Buffer
}

/** A minimal npm registry: stores what npm publishes and serves it back. */
function startRegistry() {
  const stored = new Map<string, StoredPackage>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = decodeURIComponent(url.pathname)

      if (req.method === "PUT") {
        // npm PUTs a whole packument (name, dist-tags, versions, _attachments),
        // and gzips the JSON body - detect that by magic bytes rather than
        // trusting the header.
        const raw = Buffer.from(await req.arrayBuffer())
        const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString("utf8") : raw.toString("utf8")
        const document = parseJsonObject(text, "registry PUT body")
        if (!isJsonObject(document._attachments)) {
          return new Response(JSON.stringify({ error: "malformed publish" }), { status: 400 })
        }
        const tarballName = Object.keys(document._attachments)[0]
        const attachment = tarballName ? document._attachments[tarballName] : undefined
        if (
          typeof document.name !== "string" ||
          !tarballName ||
          !isJsonObject(attachment) ||
          typeof attachment.data !== "string"
        ) {
          return new Response(JSON.stringify({ error: "malformed publish" }), { status: 400 })
        }
        stored.set(document.name, {
          document,
          tarballName,
          data: Buffer.from(attachment.data, "base64"),
        })
        return Response.json({ ok: true })
      }

      // Tarball download: the packument's `dist.tarball` points here.
      if (path.includes("/-/")) {
        const held = [...stored.values()].find((candidate) => path.endsWith(`/${candidate.tarballName}`))
        if (!held) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
        return new Response(held.data, { headers: { "content-type": "application/octet-stream" } })
      }

      // The packument npm asks for during `npm pack <name>@<version>`.
      const held = stored.get(path.replace(/^\//, "").replace(/%2f/gi, "/"))
      if (!held) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
      return Response.json(held.document, { headers: { "content-type": "application/json" } })
    },
  })
  return { server, registry: `http://127.0.0.1:${server.port}/` }
}

/** A throwaway package with a stable build, packed with the real build script. */
function fixturePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), "ellamaka-publish-e2e-pkg-"))
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, "src/index.ts"), "export const x = 1\n")
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "@wopal/ellamaka-plugin",
        version: "2.0.5",
        type: "module",
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": "./src/index.ts" },
        files: ["dist"],
        publishConfig: { access: "public" },
        scripts: { build: "bun ./build.mjs" },
      },
      null,
      2,
    )}\n`,
  )
  // A copy rather than a real tsc: the digest is over file contents, so what
  // matters is that the build produces a dist tree the packer then ships.
  writeFileSync(
    join(dir, "build.mjs"),
    'import { mkdirSync, writeFileSync } from "node:fs"\n' +
      'mkdirSync("dist", { recursive: true })\n' +
      'writeFileSync("dist/index.js", "export const x = 1\\n")\n' +
      'writeFileSync("dist/index.d.ts", "export declare const x: number\\n")\n',
  )
  return dir
}

const ENTRY: PublishPlanEntry = {
  name: "@wopal/ellamaka-plugin",
  version: "2.0.5",
  dir: ".",
  tarball: "wopal-ellamaka-plugin-2.0.5.tgz",
  decision: "publish",
  reason: "not published yet",
}

describe("publish round trip", () => {
  test("a published tarball downloads back identical to the build that produced it", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ellamaka-publish-e2e-"))
    const packageDir = fixturePackage()
    const npmrcDir = mkdtempSync(join(tmpdir(), "ellamaka-publish-e2e-npmrc-"))
    const stagingDir = join(scratch, "staging")
    mkdirSync(stagingDir, { recursive: true })
    const { server, registry } = startRegistry()
    writeFileSync(join(npmrcDir, ".npmrc"), `//127.0.0.1:${server.port}/:_authToken=fake-token\n`)

    // The publish runs in a child process: `Bun.spawnSync` (the production
    // runtime) inherits the environment as of process start, so pointing npm
    // at the throwaway registry means launching a process that already has
    // the userconfig. The child is spawned asynchronously - the registry
    // lives on this process's event loop, so a blocking spawn would deadlock
    // the requests the child makes.
    const script = join(scratch, "child.ts")
    writeFileSync(
      script,
      [
        `import { writeFileSync } from "node:fs"`,
        `import { join } from "node:path"`,
        `import { createBunRuntime, createRegistryTarballFetcher, packLocalTarball, publishPackage } from ${JSON.stringify(join(REPO_ROOT, "packages/ellamaka-release/src/npm/execute.ts"))}`,
        `const [repoRoot, stagingDir, registry] = process.argv.slice(2)`,
        `const entry = JSON.parse(process.env.FAE_ENTRY)`,
        `const runtime = createBunRuntime()`,
        `const local = packLocalTarball(entry, { repoRoot, stagingDir, runtime, log: () => {} })`,
        `writeFileSync(join(stagingDir, "local.tgz"), local)`,
        `publishPackage(entry, { repoRoot, stagingDir, registry, runtime, log: () => {} })`,
        `const fetched = createRegistryTarballFetcher({ stagingDir: join(stagingDir, "fetch"), runtime })(entry.name, entry.version, registry)`,
        `writeFileSync(join(stagingDir, "fetched.tgz"), fetched)`,
      ].join("\n"),
    )

    try {
      const proc = Bun.spawn(["bun", script, packageDir, stagingDir, registry], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, npm_config_userconfig: join(npmrcDir, ".npmrc"), FAE_ENTRY: JSON.stringify(ENTRY) },
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      if (exitCode !== 0) throw new Error(`child failed (${exitCode}):\n${stdout}\n${stderr}`)

      const localDigest = tarballContentDigest(readFileSync(join(stagingDir, "local.tgz")))
      const fetchedDigest = tarballContentDigest(readFileSync(join(stagingDir, "fetched.tgz")))
      expect(fetchedDigest).toBe(localDigest)
    } finally {
      void server.stop(true)
      for (const dir of [scratch, packageDir, npmrcDir]) rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe("round trip fixture", () => {
  test("the local pack ships the built dist tree and restores the manifest", () => {
    // Guards the fixture itself: a wrong `files`/`exports` would let the round
    // trip pass while shipping nothing, and a leaked rewrite would corrupt the
    // checkout the comparison is based on.
    const packageDir = fixturePackage()
    const stagingDir = mkdtempSync(join(tmpdir(), "ellamaka-publish-e2e-"))
    const manifestPath = join(packageDir, "package.json")
    const original = readFileSync(manifestPath, "utf8")

    try {
      const bytes = packLocalTarball(ENTRY, {
        repoRoot: packageDir,
        stagingDir,
        runtime: createBunRuntime(),
        log: () => {},
      })
      writeFileSync(join(stagingDir, ENTRY.tarball), bytes)

      expect(tarballContentDigest(bytes)).toBe(tarballContentDigest(readFileSync(join(stagingDir, ENTRY.tarball))))
      expect(readFileSync(manifestPath, "utf8")).toBe(original)
    } finally {
      rmSync(packageDir, { recursive: true, force: true })
      rmSync(stagingDir, { recursive: true, force: true })
    }
  })

  test("the pack is reproducible, so the digest can compare two builds", () => {
    const packageDir = fixturePackage()
    const first = mkdtempSync(join(tmpdir(), "ellamaka-publish-e2e-"))
    const second = mkdtempSync(join(tmpdir(), "ellamaka-publish-e2e-"))
    try {
      const a = packLocalTarball(ENTRY, {
        repoRoot: packageDir,
        stagingDir: first,
        runtime: createBunRuntime(),
        log: () => {},
      })
      const b = packLocalTarball(ENTRY, {
        repoRoot: packageDir,
        stagingDir: second,
        runtime: createBunRuntime(),
        log: () => {},
      })
      expect(tarballContentDigest(a)).toBe(tarballContentDigest(b))
    } finally {
      rmSync(packageDir, { recursive: true, force: true })
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })
})
