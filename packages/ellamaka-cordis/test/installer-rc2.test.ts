import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPackage, manifestIsBundle, removePackage } from "../src/plugins/installer"
import { readProfileManifest } from "../src/plugins/profile-manifest"
import { profileDirOf } from "../src/plugins/compose"

describe("rc.2 installer scope", () => {
  test("accepts a nonempty ordered patch array without accepting malformed arrays", () => {
    expect(manifestIsBundle({ dsh: { bundle: { patch: ["first.yml", "second.yml"] } } })).toBe(true)
    expect(manifestIsBundle({ dsh: { bundle: { patch: [] } } })).toBe(false)
    expect(manifestIsBundle({ dsh: { bundle: { patch: ["first.yml", 1] } } })).toBe(false)
  })
  test("current-profile remove preserves the other profile's declaration and entity", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-rc2-remove-"))
    const source = join(home, "fixture")
    mkdirSync(source)
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({
        name: "scope-fixture",
        version: "1.0.0",
        main: "index.js",
        dsh: { bundle: { patch: ["one.yml", "two.yml"] } },
      }),
    )
    writeFileSync(join(source, "index.js"), "export function apply() {}")
    writeFileSync(join(source, "one.yml"), "[]")
    writeFileSync(join(source, "two.yml"), "[]")
    await installPackage({ kind: "dir", path: source }, { home, profiles: ["web", "ellamaka-tools"] })
    const other = profileDirOf(home, "ellamaka-tools")
    const before = readFileSync(join(other, "package.json"), "utf8")
    await removePackage("scope-fixture", { home, profiles: ["web"] })
    expect(readProfileManifest(profileDirOf(home, "web")).dependencies["scope-fixture"]).toBeUndefined()
    expect(readFileSync(join(other, "package.json"), "utf8")).toBe(before)
    expect(existsSync(join(other, "node_modules/scope-fixture/index.js"))).toBe(true)
  })
})

describe("rc.2 installer failure boundaries", () => {
  test("a failed update preserves the previously installed entity", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-update-failure-"))
    const source = join(home, "fixture")
    mkdirSync(source)
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ name: "stable-fixture", version: "1.0.0", main: "index.js" }),
    )
    writeFileSync(join(source, "index.js"), "old")
    await installPackage({ kind: "dir", path: source }, { home, profiles: ["web"] })
    const dir = profileDirOf(home, "web")
    writeFileSync(join(dir, "package.json"), "{ invalid")
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ name: "stable-fixture", version: "2.0.0", main: "index.js" }),
    )
    writeFileSync(join(source, "index.js"), "new")
    await expect(installPackage({ kind: "dir", path: source }, { home, profiles: ["web"] })).rejects.toThrow(/parse/)
    expect(readFileSync(join(dir, "node_modules/stable-fixture/index.js"), "utf8")).toBe("old")
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe("{ invalid")
  })
  test("a pre-cancelled install performs no profile write", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-install-abort-"))
    const source = join(home, "fixture")
    mkdirSync(source)
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "cancel-fixture", version: "1.0.0" }))
    const controller = new AbortController()
    controller.abort(new Error("installation cancelled"))
    await expect(installPackage({ kind: "dir", path: source }, { home, signal: controller.signal })).rejects.toThrow(
      /cancel/,
    )
    expect(existsSync(profileDirOf(home, "web"))).toBe(false)
  })
})

test("rollback restores an earlier profile when a later profile cannot publish", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-multi-rollback-"))
  const source = join(home, "fixture")
  mkdirSync(source)
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "multi-fixture", version: "1.0.0", main: "index.js" }),
  )
  writeFileSync(join(source, "index.js"), "old")
  await installPackage({ kind: "dir", path: source }, { home, profiles: ["web", "ellamaka-tools"] })
  const web = profileDirOf(home, "web")
  const original = readFileSync(join(web, "package.json"), "utf8")
  writeFileSync(join(profileDirOf(home, "ellamaka-tools"), "package.json"), "{ invalid")
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "multi-fixture", version: "2.0.0", main: "index.js" }),
  )
  writeFileSync(join(source, "index.js"), "new")
  await expect(
    installPackage({ kind: "dir", path: source }, { home, profiles: ["web", "ellamaka-tools"] }),
  ).rejects.toThrow(/parse/)
  expect(readFileSync(join(web, "package.json"), "utf8")).toBe(original)
  expect(readFileSync(join(web, "node_modules/multi-fixture/index.js"), "utf8")).toBe("old")
})

test("official rc.2 compatibility rejects a legacy DSH peer before publication", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-peer-gate-"))
  const source = join(home, "fixture")
  mkdirSync(source)
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "legacy-fixture",
      version: "1.0.0",
      peerDependencies: { "@deepseek-ai/dsh-fs": "0.1.2-rc.1" },
    }),
  )
  await expect(installPackage({ kind: "dir", path: source }, { home, profiles: ["web"] })).rejects.toThrow(
    /0\.2\.0-rc\.2/,
  )
  expect(existsSync(join(profileDirOf(home, "web"), "node_modules/legacy-fixture"))).toBe(false)
  expect(readProfileManifest(profileDirOf(home, "web")).dependencies["legacy-fixture"]).toBeUndefined()
})
