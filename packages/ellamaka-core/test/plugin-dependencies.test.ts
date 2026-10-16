import { describe, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { collectPluginDependencies, createInstanceDependencyContributor } from "../src/plugin-dependencies"

async function tempRoot(prefix: string) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writePlugin(root: string, version = "1.0.0") {
  const dir = path.join(root, ".wopal", "plugins", "sample")
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "sample", dependencies: { "dep-a": version } }, null, 2),
  )
}

async function seedResolvedDependencies(root: string) {
  const installDir = path.join(root, ".wopal")
  const depDir = path.join(installDir, "node_modules", "dep-a")
  const sdkDir = path.join(installDir, "node_modules", "@wopal", "ellamaka-plugin")
  await mkdir(depDir, { recursive: true })
  await mkdir(sdkDir, { recursive: true })
  await writeFile(
    path.join(depDir, "package.json"),
    JSON.stringify({ name: "dep-a", version: "1.0.0", main: "index.js" }),
  )
  await writeFile(path.join(depDir, "index.js"), "module.exports = {}")
  await writeFile(
    path.join(sdkDir, "package.json"),
    JSON.stringify({ name: "@wopal/ellamaka-plugin", version: "1.0.0", main: "index.js" }),
  )
  await writeFile(path.join(sdkDir, "index.js"), "module.exports = {}")
  const dependencies = { "@wopal/ellamaka-plugin": "latest", "dep-a": "1.0.0" }
  await writeFile(path.join(installDir, "package.json"), JSON.stringify({ dependencies }, null, 2))
  await writeFile(
    path.join(installDir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }, null, 2),
  )
}

describe("createInstanceDependencyContributor", () => {
  test("factory performs no writes and exposes the approved instance step", async () => {
    const root = await tempRoot("plugin-deps-factory-")
    try {
      const wopalHome = path.join(root, "home-does-not-exist")
      const before = await readdir(root)
      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(contributor.step).toBe("instance.plugin-dependencies")
      expect(contributor.target).toBe("instance")
      expect(await readdir(root)).toEqual(before)
      expect(existsSync(wopalHome)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("host-owned plugin contract dependency is excluded from flattened plugin dependencies", async () => {
    const root = await tempRoot("plugin-deps-contract-pin-")
    const installDir = path.join(root, ".wopal")
    const pluginDir = path.join(installDir, "plugins", "sample")
    try {
      await mkdir(pluginDir, { recursive: true })
      await writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify(
          {
            name: "sample",
            dependencies: {
              "@wopal/ellamaka-plugin": "0.0.1-stale",
              "dep-a": "1.0.0",
            },
          },
          null,
          2,
        ),
      )

      const collected = await collectPluginDependencies(installDir)
      expect(collected.deps).toEqual([{ name: "dep-a", version: "1.0.0" }])
      expect(collected.plugins.sample?.deps["@wopal/ellamaka-plugin"]).toBe("0.0.1-stale")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a plugin that only declares the host contract still requires preparation", async () => {
    const root = await tempRoot("plugin-deps-contract-only-")
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    const pluginDir = path.join(space, ".wopal", "plugins", "sample")
    try {
      await mkdir(pluginDir, { recursive: true })
      await writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "sample",
          dependencies: { "@wopal/ellamaka-plugin": "0.0.1-stale" },
        }),
      )
      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "NEEDS_PREPARATION" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("inspect is read-only and reports missing installed dependencies as needing preparation", async () => {
    const root = await tempRoot("plugin-deps-inspect-")
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    try {
      await writePlugin(space)
      const beforePackage = await readFile(path.join(space, ".wopal", "plugins", "sample", "package.json"), "utf8")
      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "NEEDS_PREPARATION" })
      expect(await readFile(path.join(space, ".wopal", "plugins", "sample", "package.json"), "utf8")).toBe(
        beforePackage,
      )
      expect(existsSync(path.join(space, ".wopal", ".gitignore"))).toBe(false)
      expect(existsSync(path.join(space, ".wopal", "package.json"))).toBe(false)
      expect(existsSync(path.join(wopalHome, "ellamaka", "state", "plugin-deps.json"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("inspect reports a corrupt fingerprint cache without moving, deleting, or repairing it", async () => {
    const root = await tempRoot("plugin-deps-corrupt-")
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    const stateDir = path.join(wopalHome, "ellamaka", "state")
    const stateFile = path.join(stateDir, "plugin-deps.json")
    try {
      await writePlugin(space)
      await mkdir(stateDir, { recursive: true })
      const corrupt = '{"version":1,"dirs":{BROKEN'
      await writeFile(stateFile, corrupt)
      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({
        state: "DEGRADED",
        code: "PLUGIN_DEPENDENCY_STATE_CORRUPT",
      })
      expect(await readFile(stateFile, "utf8")).toBe(corrupt)
      expect((await readdir(stateDir)).filter((name) => name.startsWith("plugin-deps.json.bak."))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("publishes readiness only after artifacts resolve, then declaration changes invalidate it", async () => {
    const root = await tempRoot("plugin-deps-ready-")
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    try {
      await writePlugin(space)
      await seedResolvedDependencies(space)
      const contributor = createInstanceDependencyContributor({ wopalHome })
      const prepared = await contributor.prepare(
        { kind: "instance", directory: space },
        { signal: new AbortController().signal, report() {} },
      )
      expect(prepared).toEqual({ state: "READY" })
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "READY" })

      await writePlugin(space, "2.0.0")
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "NEEDS_PREPARATION" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("concurrent spaces preserve every successful fingerprint in the shared cache", async () => {
    const root = await tempRoot("plugin-deps-shared-")
    const wopalHome = path.join(root, "home")
    const spaceA = path.join(root, "space-a")
    const spaceB = path.join(root, "space-b")
    try {
      for (const space of [spaceA, spaceB]) {
        await writePlugin(space)
        await seedResolvedDependencies(space)
      }
      const contributor = createInstanceDependencyContributor({ wopalHome })
      const context = { signal: new AbortController().signal, report() {} }
      const [a, b] = await Promise.all([
        contributor.prepare({ kind: "instance", directory: spaceA }, context),
        contributor.prepare({ kind: "instance", directory: spaceB }, context),
      ])
      expect(a).toEqual({ state: "READY" })
      expect(b).toEqual({ state: "READY" })

      const state = JSON.parse(await readFile(path.join(wopalHome, "ellamaka", "state", "plugin-deps.json"), "utf8"))
      expect(Object.keys(state.dirs).sort()).toEqual(
        (
          await Promise.all([path.join(spaceA, ".wopal"), path.join(spaceB, ".wopal")].map((item) => realpath(item)))
        ).sort(),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("prepare repairs a corrupt cache while preserving the corrupt bytes as a backup", async () => {
    const root = await tempRoot("plugin-deps-repair-")
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    const stateDir = path.join(wopalHome, "ellamaka", "state")
    const stateFile = path.join(stateDir, "plugin-deps.json")
    try {
      await writePlugin(space)
      await seedResolvedDependencies(space)
      await mkdir(stateDir, { recursive: true })
      const corrupt = "{ definitely-not-json"
      await writeFile(stateFile, corrupt)

      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(
        await contributor.prepare(
          { kind: "instance", directory: space },
          { signal: new AbortController().signal, report() {} },
        ),
      ).toEqual({ state: "READY" })

      const backups = (await readdir(stateDir)).filter((name) => name.startsWith("plugin-deps.json.bak."))
      expect(backups).toHaveLength(1)
      expect(await readFile(path.join(stateDir, backups[0]), "utf8")).toBe(corrupt)
      expect(() => JSON.parse(readFileSync(stateFile, "utf8"))).not.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a missing resolved artifact invalidates an installed fingerprint", async () => {
    const root = await tempRoot("plugin-deps-preflight-")
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    try {
      await writePlugin(space)
      await seedResolvedDependencies(space)
      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(
        await contributor.prepare(
          { kind: "instance", directory: space },
          { signal: new AbortController().signal, report() {} },
        ),
      ).toEqual({ state: "READY" })

      await rm(path.join(space, ".wopal", "node_modules", "dep-a", "index.js"))
      expect(await contributor.inspect({ kind: "instance", directory: space })).toEqual({ state: "NEEDS_PREPARATION" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("one space preparation failure does not downgrade another space", async () => {
    if (process.platform === "win32") return
    const root = await tempRoot("plugin-deps-isolation-")
    const wopalHome = path.join(root, "home")
    const good = path.join(root, "good")
    const bad = path.join(root, "bad")
    const badInstallDir = path.join(bad, ".wopal")
    try {
      await writePlugin(good)
      await seedResolvedDependencies(good)
      await writePlugin(bad)
      await chmod(badInstallDir, 0o555)

      const contributor = createInstanceDependencyContributor({ wopalHome })
      const context = { signal: new AbortController().signal, report() {} }
      const [badResult, goodResult] = await Promise.all([
        contributor.prepare({ kind: "instance", directory: bad }, context),
        contributor.prepare({ kind: "instance", directory: good }, context),
      ])
      expect(badResult.state).toBe("DEGRADED")
      expect(goodResult).toEqual({ state: "READY" })
      expect(await contributor.inspect({ kind: "instance", directory: good })).toEqual({ state: "READY" })
    } finally {
      await chmod(badInstallDir, 0o755).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })
  test("treats an import-only package export as resolvable during preflight", async () => {
    const root = await tempRoot("plugin-deps-esm-")
    const wopalHome = path.join(root, "home")
    const space = path.join(root, "space")
    const installDir = path.join(space, ".wopal")
    try {
      await writePlugin(space)
      const depDir = path.join(installDir, "node_modules", "dep-a")
      const sdkDir = path.join(installDir, "node_modules", "@wopal", "ellamaka-plugin")
      for (const [dir, name] of [
        [depDir, "dep-a"],
        [sdkDir, "@wopal/ellamaka-plugin"],
      ] as const) {
        await mkdir(path.join(dir, "dist"), { recursive: true })
        await writeFile(
          path.join(dir, "package.json"),
          JSON.stringify({ name, version: "1.0.0", type: "module", exports: { ".": { import: "./dist/index.js" } } }),
        )
        await writeFile(path.join(dir, "dist", "index.js"), "export default {}\n")
      }
      const dependencies = { "@wopal/ellamaka-plugin": "latest", "dep-a": "1.0.0" }
      await writeFile(path.join(installDir, "package.json"), JSON.stringify({ dependencies }, null, 2))
      await writeFile(
        path.join(installDir, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies } } }, null, 2),
      )

      const contributor = createInstanceDependencyContributor({ wopalHome })
      expect(
        await contributor.prepare(
          { kind: "instance", directory: space },
          { signal: new AbortController().signal, report() {} },
        ),
      ).toEqual({ state: "READY" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
