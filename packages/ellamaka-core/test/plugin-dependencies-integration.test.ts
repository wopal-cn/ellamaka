import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createInstanceDependencyContributor } from "../src/plugin-dependencies"

async function writePackage(dir: string, pkg: Record<string, unknown>) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg))
  await writeFile(path.join(dir, "index.js"), "module.exports = {}\n")
}

async function runWorker(wopalHome: string, space: string) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixture", "plugin-dependency-worker.ts"), wopalHome, space],
    { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("instance plugin dependency preparation across processes", () => {
  test("same directory performs one real install transaction and the waiter reuses its committed fingerprint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugin-deps-process-"))
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    const installDir = path.join(space, ".wopal")
    const sdk = path.join(root, "sdk")
    const dep = path.join(root, "dep-a")
    try {
      await writePackage(sdk, { name: "@wopal/ellamaka-plugin", version: "1.0.0", main: "index.js" })
      await writePackage(dep, { name: "dep-a", version: "1.0.0", main: "index.js" })
      await mkdir(path.join(installDir, "plugins", "sample"), { recursive: true })
      await writeFile(
        path.join(installDir, "plugins", "sample", "package.json"),
        JSON.stringify({ name: "sample", dependencies: { "dep-a": `file:${dep}` } }),
      )
      await writeFile(
        path.join(installDir, "package.json"),
        JSON.stringify({ dependencies: { "@wopal/ellamaka-plugin": `file:${sdk}` } }),
      )

      const spaceLink = path.join(root, "space-link")
      await symlink(space, spaceLink, "dir")
      const [first, second] = await Promise.all([runWorker(wopalHome, space), runWorker(wopalHome, spaceLink)])
      for (const worker of [first, second]) {
        expect(worker.exitCode, worker.stderr).toBe(0)
        expect(worker.stdout).toContain('"state":"READY"')
      }
      const combined = `${first.stdout}\n${second.stdout}`
      expect(combined.match(/"phase":"installing"/g)?.length ?? 0).toBe(1)

      expect(
        JSON.parse(await readFile(path.join(installDir, "node_modules", "dep-a", "package.json"), "utf8")).version,
      ).toBe("1.0.0")
      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "READY" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("re-reads declarations after waiting for the directory lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugin-deps-reread-"))
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    const installDir = path.join(space, ".wopal")
    const sdk = path.join(root, "sdk")
    const depV1 = path.join(root, "dep-v1")
    const depV2 = path.join(root, "dep-v2")
    const acquired = path.join(root, "lock-acquired")
    const release = path.join(root, "lock-release")
    try {
      await writePackage(sdk, { name: "@wopal/ellamaka-plugin", version: "1.0.0", main: "index.js" })
      await writePackage(depV1, { name: "dep-a", version: "1.0.0", main: "index.js" })
      await writePackage(depV2, { name: "dep-a", version: "2.0.0", main: "index.js" })
      await mkdir(path.join(installDir, "plugins", "sample"), { recursive: true })
      const declaration = path.join(installDir, "plugins", "sample", "package.json")
      await writeFile(declaration, JSON.stringify({ name: "sample", dependencies: { "dep-a": `file:${depV1}` } }))
      await writeFile(
        path.join(installDir, "package.json"),
        JSON.stringify({ dependencies: { "@wopal/ellamaka-plugin": `file:${sdk}` } }),
      )

      const holder = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "fixture", "plugin-dependency-lock-holder.ts"),
          wopalHome,
          installDir,
          acquired,
          release,
        ],
        { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
      )
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          await access(acquired).then(
            () => true,
            () => false,
          )
        )
          break
        await Bun.sleep(10)
      }
      expect(
        await access(acquired).then(
          () => true,
          () => false,
        ),
      ).toBe(true)

      const preparing = runWorker(wopalHome, space)
      await writeFile(declaration, JSON.stringify({ name: "sample", dependencies: { "dep-a": `file:${depV2}` } }))
      await writeFile(release, "release")

      const [worker, holderExit] = await Promise.all([preparing, holder.exited])
      expect(holderExit).toBe(0)
      expect(worker.exitCode, worker.stderr).toBe(0)
      expect(worker.stdout).toContain('"phase":"installing"')
      expect(
        JSON.parse(await readFile(path.join(installDir, "node_modules", "dep-a", "package.json"), "utf8")).version,
      ).toBe("2.0.0")
      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "READY" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("declaration changes replace the actual installed artifact before publishing the new fingerprint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugin-deps-upgrade-"))
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    const installDir = path.join(space, ".wopal")
    const sdk = path.join(root, "sdk")
    const depV1 = path.join(root, "dep-v1")
    const depV2 = path.join(root, "dep-v2")
    const declaration = path.join(installDir, "plugins", "sample", "package.json")
    try {
      await writePackage(sdk, { name: "@wopal/ellamaka-plugin", version: "1.0.0", main: "index.js" })
      await writePackage(depV1, { name: "dep-a", version: "1.0.0", main: "index.js" })
      await writePackage(depV2, { name: "dep-a", version: "2.0.0", main: "index.js" })
      await mkdir(path.dirname(declaration), { recursive: true })
      await writeFile(declaration, JSON.stringify({ name: "sample", dependencies: { "dep-a": `file:${depV1}` } }))
      await writeFile(
        path.join(installDir, "package.json"),
        JSON.stringify({ dependencies: { "@wopal/ellamaka-plugin": `file:${sdk}` } }),
      )

      const contributor = createInstanceDependencyContributor({ wopalHome })
      const context = { signal: new AbortController().signal, report() {} }
      expect(await contributor.prepare({ kind: "instance", directory: space }, context)).toEqual({ state: "READY" })
      expect(
        JSON.parse(await readFile(path.join(installDir, "node_modules", "dep-a", "package.json"), "utf8")).version,
      ).toBe("1.0.0")

      await writeFile(declaration, JSON.stringify({ name: "sample", dependencies: { "dep-a": `file:${depV2}` } }))
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "NEEDS_PREPARATION" })
      expect(await contributor.prepare({ kind: "instance", directory: space }, context)).toEqual({ state: "READY" })
      expect(
        JSON.parse(await readFile(path.join(installDir, "node_modules", "dep-a", "package.json"), "utf8")).version,
      ).toBe("2.0.0")
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "READY" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("different directories do not lose records when they commit the shared fingerprint cache concurrently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugin-deps-shared-process-"))
    const wopalHome = path.join(root, "home")
    const sdk = path.join(root, "sdk")
    const dep = path.join(root, "dep-a")
    const spaces = [path.join(root, "space-a"), path.join(root, "space-b")]
    try {
      await writePackage(sdk, { name: "@wopal/ellamaka-plugin", version: "1.0.0", main: "index.js" })
      await writePackage(dep, { name: "dep-a", version: "1.0.0", main: "index.js" })
      for (const space of spaces) {
        const installDir = path.join(space, ".wopal")
        await mkdir(path.join(installDir, "plugins", "sample"), { recursive: true })
        await writeFile(
          path.join(installDir, "plugins", "sample", "package.json"),
          JSON.stringify({ name: "sample", dependencies: { "dep-a": `file:${dep}` } }),
        )
        await writeFile(
          path.join(installDir, "package.json"),
          JSON.stringify({ dependencies: { "@wopal/ellamaka-plugin": `file:${sdk}` } }),
        )
      }

      const workers = await Promise.all(spaces.map((space) => runWorker(wopalHome, space)))
      for (const worker of workers) expect(worker.exitCode, worker.stderr).toBe(0)

      const state = JSON.parse(await readFile(path.join(wopalHome, "ellamaka", "state", "plugin-deps.json"), "utf8"))
      expect(Object.keys(state.dirs).sort()).toEqual(
        (await Promise.all(spaces.map((space) => realpath(path.join(space, ".wopal"))))).sort(),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
