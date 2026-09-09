import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPackage, listInstalled, NotInstalledError, removePackage } from "../src/plugins/installer"
import { profileDirOf } from "../src/plugins/compose"
import { readProfileManifest } from "../src/plugins/profile-manifest"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-plugin-installer-"))
}

/** A fixture plugin package on disk (the `--dir` install source). */
function fixturePluginDir(root: string, name = "fixture-greeter", version = "1.0.0", withBundle = true): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = { name, version, type: "module", main: "index.js" }
  if (withBundle) {
    manifest.dsh = { bundle: { patch: "./cordis.patch.yml" } }
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
  writeFileSync(join(dir, "index.js"), "export const name = 'fixture'\nexport function apply() {}\n")
  if (withBundle) writeFileSync(join(dir, "cordis.patch.yml"), "- insert:\n    - id: dsh-plugin:fixture\n      name: fixture\n")
  return dir
}

/**
 * A fake extract mirroring the REAL pacote contract: the tarball content
 * lands DIRECTLY in `dest` (the tarball's `package/` root is stripped), so
 * the installer must pass each package's final `node_modules/<name>` slot
 * as dest. Extract of the failing spec throws (failure-path coverage).
 */
function fakeExtract(failing?: string) {
  const extracted: Array<{ spec: string; dest: string }> = []
  return {
    extracted,
    extract: async (spec: string, dest: string) => {
      if (failing && spec === failing) throw new Error(`download failed for ${spec}`)
      extracted.push({ spec, dest })
      const at = spec.lastIndexOf("@")
      const name = spec.slice(0, at)
      const version = spec.slice(at + 1)
      mkdirSync(dest, { recursive: true })
      writeFileSync(
        join(dest, "package.json"),
        JSON.stringify({
          name,
          version,
          dsh: name === "is-odd" ? { bundle: { patch: "./cordis.patch.yml" } } : undefined,
        }),
      )
    },
  }
}

/** Every extract dest must be the package's final staging slot `…/node_modules/<name>`. */
function expectSlotDest(extracted: Array<{ spec: string; dest: string }>): void {
  for (const { spec, dest } of extracted) {
    const name = spec.slice(0, spec.lastIndexOf("@"))
    expect(dest.endsWith(join("node_modules", ...name.split("/")))).toBe(true)
  }
}

function fakeResolveTree(packages: [string, string, string[]][]) {
  const map = new Map(
    packages.map(([name, version, deps]) => [`${name}@${version}`, { name, version, dependencies: deps.map((d) => d), tarball: "" }]),
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (spec: { kind: string; name?: string; version?: string }) => ({
    root: { name: spec.name ?? "", version: spec.version ?? "" },
    packages: map,
  }) as never
}

describe("Bun installer: registry pipeline (official end state)", () => {
  test("install lands the package in the profile node_modules and declares it in the manifest", async () => {
    const root = tempRoot()
    const fake = fakeExtract()
    const result = await installPackage(
      { kind: "registry", name: "is-odd", version: "3.0.1" },
      {
        home: root,
        extract: fake.extract,
        resolve: fakeResolveTree([["is-odd", "3.0.1", []]]),
      },
    )
    expect(result).toMatchObject({ name: "is-odd", version: "3.0.1", isBundle: true })
    // Extract must target each package's final node_modules slot (real pacote contract).
    expectSlotDest(fake.extracted)
    // The package entity sits in the PROFILE node_modules.
    const entity = join(profileDirOf(root, "web"), "node_modules", "is-odd")
    expect(existsSync(join(entity, "package.json"))).toBe(true)
    // The manifest declares the dependency and the bundle.
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(manifest.dependencies["is-odd"]).toBe("3.0.1")
    expect(manifest.bundles).toContain("is-odd")
  })

  test("transitive dependencies land flat in the entry package's node_modules (parent-walk resolvable)", async () => {
    const root = tempRoot()
    const fake = fakeExtract()
    const result = await installPackage(
      { kind: "registry", name: "root-pkg", version: "1.0.0" },
      {
        home: root,
        extract: fake.extract,
        resolve: fakeResolveTree([
          ["root-pkg", "1.0.0", ["mid-pkg@2.0.0"]],
          ["mid-pkg", "2.0.0", ["deep-pkg@3.0.0"]],
          ["deep-pkg", "3.0.0", []],
        ]),
      },
    )
    expect(result.name).toBe("root-pkg")
    expect(fake.extracted).toHaveLength(3)
    expectSlotDest(fake.extracted)
    const target = join(profileDirOf(root, "web"), "node_modules", "root-pkg")
    expect(existsSync(join(target, "package.json"))).toBe(true)
    // Transitive deps hoisted flat under the entry package's node_modules.
    expect(existsSync(join(target, "node_modules", "mid-pkg", "package.json"))).toBe(true)
    expect(existsSync(join(target, "node_modules", "deep-pkg", "package.json"))).toBe(true)
    // Only the ENTRY package is declared in the manifest.
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(Object.keys(manifest.dependencies)).toEqual(["root-pkg"])
  })

  test("official packages are never downloaded or placed", async () => {
    const root = tempRoot()
    const fake = fakeExtract()
    await installPackage(
      { kind: "registry", name: "is-odd", version: "3.0.1" },
      {
        home: root,
        extract: fake.extract,
        resolve: fakeResolveTree([
          ["is-odd", "3.0.1", ["@deepseek-ai/cordis@4.0.2"]],
          ["@deepseek-ai/cordis", "4.0.2", []],
        ]),
      },
    )
    // The official package was not extracted.
    expect(fake.extracted.map((e) => e.spec)).toEqual(["is-odd@3.0.1"])
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(manifest.dependencies).toEqual({ "is-odd": "3.0.1" })
    expect(manifest.bundles).toEqual(["is-odd"])
  })

  test("a non-bundle package installs with isBundle:false, declared as dependency but not bundle", async () => {
    const root = tempRoot()
    const fake = fakeExtract()
    const result = await installPackage(
      { kind: "registry", name: "plain-lib", version: "2.0.0" },
      {
        home: root,
        extract: fake.extract,
        resolve: fakeResolveTree([["plain-lib", "2.0.0", []]]),
      },
    )
    expect(result.isBundle).toBe(false)
    expect(result.warning).toMatch(/dsh\.bundle\.patch/)
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(manifest.dependencies["plain-lib"]).toBe("2.0.0")
    expect(manifest.bundles).toEqual([])
  })

  test("official bundles already in the manifest keep their order in front (bundles append semantics)", async () => {
    const root = tempRoot()
    const profileDir = profileDirOf(root, "web")
    mkdirSync(join(profileDir, "node_modules"), { recursive: true })
    await import("../src/plugins/profile-manifest").then(({ withProfileManifestWrite }) =>
      withProfileManifestWrite(profileDir, (manifest) => {
        const dsh = (manifest.dsh ??= {}) as Record<string, unknown>
        const profile = (dsh.profile ??= {}) as Record<string, unknown>
        profile.bundles = ["@deepseek-ai/dsh-base"]
      }),
    )
    const fake = fakeExtract()
    await installPackage(
      { kind: "registry", name: "is-odd", version: "3.0.1" },
      { home: root, extract: fake.extract, resolve: fakeResolveTree([["is-odd", "3.0.1", []]]) },
    )
    const manifest = readProfileManifest(profileDir)
    expect(manifest.bundles).toEqual(["@deepseek-ai/dsh-base", "is-odd"])
  })
})

describe("Bun installer: dir pipeline", () => {
  test("dir install copies the package into the profile node_modules and declares it", async () => {
    const root = tempRoot()
    const src = fixturePluginDir(mkdtempSync(join(tmpdir(), "dsh-plugin-src-")))
    const result = await installPackage({ kind: "dir", path: src }, { home: root })
    expect(result).toMatchObject({ name: "fixture-greeter", version: "1.0.0", isBundle: true })
    const target = join(profileDirOf(root, "web"), "node_modules", "fixture-greeter")
    expect(existsSync(join(target, "package.json"))).toBe(true)
    expect(existsSync(join(target, "index.js"))).toBe(true)
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(manifest.dependencies["fixture-greeter"]).toBe("1.0.0")
    expect(manifest.bundles).toContain("fixture-greeter")
  })

  test("dir install keeps a pre-bundled nested node_modules", async () => {
    const root = tempRoot()
    const srcRoot = mkdtempSync(join(tmpdir(), "dsh-plugin-src-"))
    const src = fixturePluginDir(srcRoot)
    const nested = join(src, "node_modules", "tiny-dep")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "tiny-dep", version: "0.0.1" }))
    await installPackage({ kind: "dir", path: src }, { home: root })
    expect(existsSync(join(profileDirOf(root, "web"), "node_modules", "fixture-greeter", "node_modules", "tiny-dep", "package.json"))).toBe(true)
  })
})

describe("Bun installer: failure semantics (profile untouched)", () => {
  test("extract failure cleans staging and leaves the profile untouched", async () => {
    const root = tempRoot()
    const profileDir = profileDirOf(root, "web")
    mkdirSync(join(profileDir, "node_modules"), { recursive: true })
    const fake = fakeExtract("is-odd@3.0.1")
    const resolve = fakeResolveTree([["is-odd", "3.0.1", []]])
    await expect(
      installPackage({ kind: "registry", name: "is-odd", version: "3.0.1" }, { home: root, extract: fake.extract, resolve }),
    ).rejects.toThrow("download failed for is-odd@3.0.1")
    // The profile manifest and node_modules are untouched.
    expect(existsSync(join(profileDir, "node_modules", "is-odd"))).toBe(false)
    expect(readProfileManifest(profileDir).dependencies).toEqual({})
    // Nothing remains in staging.
    const leftovers = readdirSync(tmpdir()).filter((d) => d.startsWith("dsh-plugins-stage-"))
    expect(leftovers).toEqual([])
  })

  test("a malicious --dir manifest with traversal name is rejected (rook B-08) and writes nothing", async () => {
    const root = tempRoot()
    const evilRoot = mkdtempSync(join(tmpdir(), "dsh-plugin-evil-"))
    const evil = join(evilRoot, "evil")
    mkdirSync(evil, { recursive: true })
    writeFileSync(
      join(evil, "package.json"),
      JSON.stringify({ name: "../../escape", version: "1.0.0", dsh: { bundle: { patch: "./p.yml" } } }),
    )
    await expect(installPackage({ kind: "dir", path: evil }, { home: root })).rejects.toThrow(/unsafe package name/)
    expect(readProfileManifest(profileDirOf(root, "web")).dependencies).toEqual({})
  })

  test("a --dir manifest with a non-semver version is rejected (rook B-08)", async () => {
    const root = tempRoot()
    const srcRoot = mkdtempSync(join(tmpdir(), "dsh-plugin-evil3-"))
    const src = fixturePluginDir(srcRoot, "badver", "not-semver")
    await expect(installPackage({ kind: "dir", path: src }, { home: root })).rejects.toThrow(/unsafe package version/)
  })

  test("a registry resolve result with a traversal root name is rejected", async () => {
    const root = tempRoot()
    await expect(
      installPackage(
        { kind: "registry", name: "x", version: "1.0.0" },
        {
          home: root,
          extract: fakeExtract().extract,
          resolve: async () => ({
            root: { name: "../escape", version: "1.0.0" },
            packages: new Map([["../escape@1.0.0", { name: "../escape", version: "1.0.0", dependencies: [], tarball: "" }]]),
          }) as never,
        },
      ),
    ).rejects.toThrow(/unsafe package name/)
  })
})

describe("Bun installer: github source (phase 1 explicit error)", () => {
  test("a github: spec is rejected with npm guidance before any network activity", async () => {
    const root = tempRoot()
    await expect(
      installPackage({ kind: "registry", name: "dshmarket", version: "github:owner/repo" }, { home: root }),
    ).rejects.toThrow(/github/i)
    await expect(
      installPackage({ kind: "registry", name: "dshmarket", version: "github:owner/repo" }, { home: root }),
    ).rejects.toThrow(/npm/i)
    expect(readProfileManifest(profileDirOf(root, "web")).dependencies).toEqual({})
  })
})

describe("Bun installer: replace semantics (official CLI)", () => {
  test("same-name same-version reinstall overwrites (no AlreadyInstalledError)", async () => {
    const root = tempRoot()
    const src = fixturePluginDir(mkdtempSync(join(tmpdir(), "dsh-plugin-src-")))
    await installPackage({ kind: "dir", path: src }, { home: root })
    const again = await installPackage({ kind: "dir", path: src }, { home: root })
    expect(again.name).toBe("fixture-greeter")
    // Exactly one entity and one manifest entry.
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(Object.keys(manifest.dependencies)).toEqual(["fixture-greeter"])
    expect(manifest.bundles.filter((b) => b === "fixture-greeter")).toHaveLength(1)
  })

  test("a different version replaces the previous one (remove+add in one)", async () => {
    const root = tempRoot()
    const srcRoot = mkdtempSync(join(tmpdir(), "dsh-plugin-src-"))
    const v1 = fixturePluginDir(srcRoot, "upgradable", "1.0.0")
    await installPackage({ kind: "dir", path: v1 }, { home: root })
    const v2dir = join(srcRoot, "upgradable-v2")
    mkdirSync(v2dir, { recursive: true })
    writeFileSync(
      join(v2dir, "package.json"),
      JSON.stringify({ name: "upgradable", version: "2.0.0", type: "module", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
    )
    writeFileSync(join(v2dir, "cordis.patch.yml"), "- insert:\n    - id: dsh-plugin:fixture\n      name: fixture\n")
    const result = await installPackage({ kind: "dir", path: v2dir }, { home: root })
    expect(result.version).toBe("2.0.0")
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(manifest.dependencies["upgradable"]).toBe("2.0.0")
  })
})

describe("Bun installer: remove", () => {
  test("removePackage deletes the entity and drops the declaration", async () => {
    const root = tempRoot()
    const src = fixturePluginDir(mkdtempSync(join(tmpdir(), "dsh-plugin-src-")))
    const installed = await installPackage({ kind: "dir", path: src }, { home: root })
    await removePackage(installed.name, { home: root })
    expect(existsSync(join(profileDirOf(root, "web"), "node_modules", "fixture-greeter"))).toBe(false)
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    expect(manifest.dependencies).toEqual({})
    expect(manifest.bundles).toEqual([])
    // The profiles/node_modules link is gone too (rook B-06).
    expect(existsSync(join(root, "home", "profiles", "node_modules", "fixture-greeter"))).toBe(false)
  })

  test("removePackage for an unknown plugin throws NotInstalledError", async () => {
    const root = tempRoot()
    await expect(removePackage("ghost", { home: root })).rejects.toBeInstanceOf(NotInstalledError)
  })
})

describe("Bun installer: listInstalled (profile manifest source)", () => {
  test("listInstalled reads the profile manifest user bundles", async () => {
    const root = tempRoot()
    const src = fixturePluginDir(mkdtempSync(join(tmpdir(), "dsh-plugin-src-")))
    await installPackage({ kind: "dir", path: src }, { home: root })
    const list = listInstalled(root, "web")
    expect(list).toEqual([{ name: "fixture-greeter", version: "1.0.0" }])
  })
})

describe("Bun installer: symlink heal integration", () => {
  test("install re-runs the module-fallback heal so the fresh package resolves", async () => {
    const root = tempRoot()
    const src = fixturePluginDir(mkdtempSync(join(tmpdir(), "dsh-plugin-src-")))
    await installPackage({ kind: "dir", path: src }, { home: root })
    const link = join(root, "home", "profiles", "node_modules", "fixture-greeter")
    expect(existsSync(link)).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(join(profileDirOf(root, "web"), "node_modules", "fixture-greeter")))
  })
})

describe("Bun installer: multi-profile placement", () => {
  test("profiles option places the package in each requested profile", async () => {
    const root = tempRoot()
    const src = fixturePluginDir(mkdtempSync(join(tmpdir(), "dsh-plugin-src-")))
    await installPackage({ kind: "dir", path: src }, { home: root, profiles: ["web", "ellamaka-tools"] })
    for (const profile of ["web", "ellamaka-tools"]) {
      expect(existsSync(join(profileDirOf(root, profile), "node_modules", "fixture-greeter", "package.json"))).toBe(true)
      const manifest = readProfileManifest(profileDirOf(root, profile))
      expect(manifest.dependencies["fixture-greeter"]).toBe("1.0.0")
      expect(manifest.bundles).toContain("fixture-greeter")
    }
  })

  test("registry install lands the entry + transitive tree in EVERY profile (the CLI default path)", async () => {
    // The default CLI add (`--profile` omitted) targets BOTH built-ins. The
    // staged tree is consumed per profile — the second placement must not
    // depend on staging surviving the first (rook B-01: rename drained it).
    const root = tempRoot()
    const fake = fakeExtract()
    const result = await installPackage(
      { kind: "registry", name: "root-pkg", version: "1.0.0" },
      {
        home: root,
        profiles: ["web", "ellamaka-tools"],
        extract: fake.extract,
        resolve: fakeResolveTree([
          ["root-pkg", "1.0.0", ["mid-pkg@2.0.0"]],
          ["mid-pkg", "2.0.0", []],
        ]),
      },
    )
    expect(result.name).toBe("root-pkg")
    for (const profile of ["web", "ellamaka-tools"]) {
      const entity = join(profileDirOf(root, profile), "node_modules", "root-pkg")
      expect(existsSync(join(entity, "package.json"))).toBe(true)
      expect(existsSync(join(entity, "node_modules", "mid-pkg", "package.json"))).toBe(true)
      const manifest = readProfileManifest(profileDirOf(root, profile))
      expect(manifest.dependencies["root-pkg"]).toBe("1.0.0")
    }
  })

  test("removePackage removes from every profile that declares the package", async () => {
    const root = tempRoot()
    const src = fixturePluginDir(mkdtempSync(join(tmpdir(), "dsh-plugin-src-")))
    await installPackage({ kind: "dir", path: src }, { home: root, profiles: ["web", "ellamaka-tools"] })
    await removePackage("fixture-greeter", { home: root })
    for (const profile of ["web", "ellamaka-tools"]) {
      expect(existsSync(join(profileDirOf(root, profile), "node_modules", "fixture-greeter"))).toBe(false)
      expect(readProfileManifest(profileDirOf(root, profile)).dependencies).toEqual({})
    }
  })
})
