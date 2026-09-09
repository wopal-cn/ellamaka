import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PLUGINS_LOCK_FILENAME,
  appendBundle,
  dropPlugin,
  pluginsLockFile,
  readProfileManifest,
  setDependency,
  withProfileManifestWrite,
  withPluginsLock,
} from "../src/plugins/profile-manifest"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-profile-manifest-"))
}

/** Seed a profile manifest with official shape (2-space JSON + newline). */
function seedManifest(root: string, manifest: Record<string, unknown>): string {
  const profileDir = join(root, "home", "profiles", "web")
  mkdirSync(profileDir, { recursive: true })
  const file = join(profileDir, "package.json")
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8")
  return file
}

function readManifestFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>
}

describe("readProfileManifest", () => {
  test("reads dependencies and dsh.profile.bundles from a present manifest", () => {
    const root = tempRoot()
    const file = seedManifest(root, {
      name: "web",
      dependencies: { dshmarket: "^1.42.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dshmarket"] } },
    })
    const manifest = readProfileManifest(join(root, "home", "profiles", "web"))
    expect(manifest.dependencies).toEqual({ dshmarket: "^1.42.0" })
    expect(manifest.bundles).toEqual(["@deepseek-ai/dsh-base", "dshmarket"])
    expect(existsSync(file)).toBe(true)
  })

  test("a missing manifest reads as empty dependencies and bundles", () => {
    const root = tempRoot()
    const manifest = readProfileManifest(join(root, "home", "profiles", "web"))
    expect(manifest.dependencies).toEqual({})
    expect(manifest.bundles).toEqual([])
  })

  test("a manifest without the dsh field reads as empty bundles", () => {
    const root = tempRoot()
    seedManifest(root, { name: "web", dependencies: { a: "1.0.0" } })
    const manifest = readProfileManifest(join(root, "home", "profiles", "web"))
    expect(manifest.dependencies).toEqual({ a: "1.0.0" })
    expect(manifest.bundles).toEqual([])
  })

  test("a non-object dependencies field fails loud", () => {
    const root = tempRoot()
    seedManifest(root, { dependencies: ["not", "an", "object"] })
    expect(() => readProfileManifest(join(root, "home", "profiles", "web"))).toThrow(/dependencies/)
  })

  test("a non-array bundles field fails loud", () => {
    const root = tempRoot()
    seedManifest(root, { dsh: { profile: { bundles: "dshmarket" } } })
    expect(() => readProfileManifest(join(root, "home", "profiles", "web"))).toThrow(/bundles/)
  })

  test("malformed JSON fails loud naming the file", () => {
    const root = tempRoot()
    const profileDir = join(root, "home", "profiles", "web")
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, "package.json"), "{not json")
    expect(() => readProfileManifest(profileDir)).toThrow(/package\.json/)
  })
})

describe("withProfileManifestWrite", () => {
  test("applies the mutator and persists atomically without tmp leftovers", async () => {
    const root = tempRoot()
    const file = seedManifest(root, { name: "web" })
    const result = await withProfileManifestWrite(join(root, "home", "profiles", "web"), (manifest) => {
      setDependency(manifest, "dshmarket", "^1.42.0")
      appendBundle(manifest, "dshmarket")
      return "ok"
    })
    expect(result).toBe("ok")
    const raw = readManifestFile(file)
    expect(raw.dependencies).toEqual({ dshmarket: "^1.42.0" })
    expect((raw.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual(["dshmarket"])
    // Atomic write: no tmp siblings left behind.
    const leftovers = readdirSync(join(root, "home", "profiles", "web")).filter((f) => f !== "package.json")
    expect(leftovers).toEqual([])
  })

  test("a throwing mutator leaves the manifest on disk untouched", async () => {
    const root = tempRoot()
    const file = seedManifest(root, { name: "web", dependencies: { keep: "1.0.0" } })
    await expect(
      withProfileManifestWrite(join(root, "home", "profiles", "web"), () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(readManifestFile(file).dependencies).toEqual({ keep: "1.0.0" })
  })

  test("missing parent profile directory is created on write", async () => {
    const root = tempRoot()
    const profileDir = join(root, "home", "profiles", "web")
    await withProfileManifestWrite(profileDir, (manifest) => {
      setDependency(manifest, "pkg", "1.0.0")
    })
    expect(existsSync(join(profileDir, "package.json"))).toBe(true)
  })

  test("official fields outside dsh.profile are preserved", async () => {
    const root = tempRoot()
    const file = seedManifest(root, {
      name: "web",
      private: true,
      dependencies: { existing: "2.0.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "live" } },
    })
    await withProfileManifestWrite(join(root, "home", "profiles", "web"), (manifest) => {
      setDependency(manifest, "dshmarket", "^1.42.0")
      appendBundle(manifest, "dshmarket")
    })
    const raw = readManifestFile(file)
    expect(raw.name).toBe("web")
    expect(raw.private).toBe(true)
    expect(raw.dependencies).toEqual({ existing: "2.0.0", dshmarket: "^1.42.0" })
    const profile = (raw.dsh as { profile: Record<string, unknown> }).profile
    expect(profile.bundles).toEqual(["@deepseek-ai/dsh-base", "dshmarket"])
    expect(profile.patchReload).toBe("live")
  })

  test("concurrent writers serialise and every mutation survives", async () => {
    const root = tempRoot()
    seedManifest(root, { name: "web" })
    const profileDir = join(root, "home", "profiles", "web")
    await Promise.all(
      ["p1", "p2", "p3", "p4", "p5"].map((name) =>
        withProfileManifestWrite(profileDir, (manifest) => {
          setDependency(manifest, name, "1.0.0")
        }),
      ),
    )
    const manifest = readProfileManifest(profileDir)
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["p1", "p2", "p3", "p4", "p5"])
  })

  test("writes queue behind a held plugins.lock and persist after it releases", async () => {
    const root = tempRoot()
    const profileDir = join(root, "home", "profiles", "web")
    mkdirSync(profileDir, { recursive: true })
    const lockGuard = pluginsLockFile(root)
    const events: string[] = []
    const release = Promise.withResolvers<void>()
    const holder = withPluginsLock(root, async () => {
      events.push("holder-entered")
      await release.promise
      events.push("holder-left")
    })
    const writer = withProfileManifestWrite(profileDir, () => {
      // The writer can only run after the holder left: serialisation proof.
      events.push("writer-entered")
    })
    // Give the holder a tick to enter before releasing.
    await new Promise((resolve) => setTimeout(resolve, 20))
    release.resolve()
    await Promise.all([holder, writer])
    expect(events).toEqual(["holder-entered", "holder-left", "writer-entered"])
    // The guard is gone after release (ownership-safe removal).
    expect(existsSync(lockGuard)).toBe(false)
    expect(PLUGINS_LOCK_FILENAME).toBe("plugins.lock")
  })
})

describe("appendBundle / setDependency / dropPlugin (pure mutators)", () => {
  test("appendBundle appends to the end and dedupes idempotently", () => {
    const m: Record<string, unknown> = { dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }
    appendBundle(m as never, "dshmarket")
    expect((m as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "dshmarket",
    ])
    appendBundle(m as never, "dshmarket")
    expect((m as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "dshmarket",
    ])
  })

  test("appendBundle creates the dsh.profile.bundles structure when missing", () => {
    const m: Record<string, unknown> = { name: "web" }
    appendBundle(m as never, "dshmarket")
    const shape = m as { dsh: { profile: { bundles: string[] } } }
    expect(shape.dsh.profile.bundles).toEqual(["dshmarket"])
  })

  test("appendBundle safely completes a non-profile dsh field", () => {
    const m: Record<string, unknown> = { dsh: { bundle: { patch: "./p.yml" } } }
    appendBundle(m as never, "dshmarket")
    const shape = m as { dsh: { profile: { bundles: string[] }; bundle?: unknown } }
    expect(shape.dsh.profile.bundles).toEqual(["dshmarket"])
    expect(shape.dsh.bundle).toEqual({ patch: "./p.yml" })
  })

  test("appendBundle keeps official bundles in front (append only at the tail)", () => {
    const m: Record<string, unknown> = {
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
    }
    appendBundle(m as never, "dshmarket")
    appendBundle(m as never, "another-user-plugin")
    const bundles = (m as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
    expect(bundles).toEqual([
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dshmarket",
      "another-user-plugin",
    ])
  })

  test("setDependency writes the range and overwrites an existing range", () => {
    const m: Record<string, unknown> = {}
    setDependency(m as never, "dshmarket", "^1.42.0")
    expect((m as { dependencies: Record<string, string> }).dependencies).toEqual({ dshmarket: "^1.42.0" })
    setDependency(m as never, "dshmarket", "2.0.0")
    expect((m as { dependencies: Record<string, string> }).dependencies).toEqual({ dshmarket: "2.0.0" })
  })

  test("dropPlugin removes both dependency and bundle and reports the change", () => {
    const m: Record<string, unknown> = {
      dependencies: { dshmarket: "^1.42.0", other: "1.0.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dshmarket"] } },
    }
    const changed = dropPlugin(m as never, "dshmarket")
    expect(changed).toBe(true)
    const shape = m as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(shape.dependencies).toEqual({ other: "1.0.0" })
    expect(shape.dsh.profile.bundles).toEqual(["@deepseek-ai/dsh-base"])
    // Second drop is a no-op returning false.
    expect(dropPlugin(m as never, "dshmarket")).toBe(false)
  })

  test("dropPlugin for an absent plugin returns false", () => {
    const m: Record<string, unknown> = { dependencies: {}, dsh: { profile: { bundles: [] } } }
    expect(dropPlugin(m as never, "ghost")).toBe(false)
  })
})
