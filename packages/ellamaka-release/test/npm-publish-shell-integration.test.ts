import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { spawnSync } from "child_process"

const root = resolve(import.meta.dir, "..", "..", "..")

test.each([
  { selected: ["@wopal/ellamaka-sdk"], sdk: "2.0.12", plugin: "2.0.8", tag: "ellamaka-npm-v2.0.12-sdk", fail: false },
  {
    selected: ["@wopal/ellamaka-plugin"],
    sdk: "2.0.11",
    plugin: "2.0.9",
    tag: "ellamaka-npm-v2.0.9-plugin",
    fail: false,
  },
  {
    selected: ["@wopal/ellamaka-plugin"],
    sdk: "2.0.11",
    plugin: "2.0.9",
    tag: "ellamaka-npm-v2.0.9-plugin",
    fail: true,
  },
  {
    selected: ["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"],
    sdk: "2.0.12",
    plugin: "2.0.9",
    tag: "ellamaka-npm-v2.0.12-sdk-v2.0.9-plugin",
    fail: false,
  },
])("release shell selection $tag (preflight failure: $fail)", ({ selected, sdk, plugin, tag, fail }) => {
  const temp = mkdtempSync(join(tmpdir(), "ellamaka-release-selection-"))
  const repo = join(temp, "repo")
  const bin = join(temp, "bin")
  mkdirSync(repo)
  mkdirSync(bin)
  const env = {
    ...process.env,
    HOME: temp,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: join(temp, "calls"),
    FAIL_CHECK: fail ? "1" : "0",
  }
  const run = (cmd: string, args: string[], cwd = repo) => {
    const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr}`)
    return result.stdout
  }
  try {
    for (const dir of ["scripts", "packages/sdk/js", "packages/plugin", "packages/ellamaka-release/src/cli"])
      mkdirSync(join(repo, dir), { recursive: true })
    copyFileSync(join(root, "scripts/release-npm.sh"), join(repo, "scripts/release-npm.sh"))
    symlinkSync(join(root, "node_modules"), join(repo, "node_modules"))
    writeFileSync(join(repo, "packages/sdk/js/package.json"), '{"name":"@wopal/ellamaka-sdk","version":"2.0.11"}\n')
    writeFileSync(join(repo, "packages/plugin/package.json"), '{"name":"@wopal/ellamaka-plugin","version":"2.0.8"}\n')
    writeFileSync(join(repo, "bun.lock"), "fixture\n")
    writeFileSync(
      join(bin, "bun"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALL_LOG"\ncase "$*" in *--check*) [ "$FAIL_CHECK" != 1 ] || exit 1;; esac\n',
      { mode: 0o755 },
    )
    run("git", ["init", "--bare", join(temp, "remote.git")], temp)
    run("git", ["init", "-b", "main"])
    run("git", ["config", "user.name", "Test"])
    run("git", ["config", "user.email", "test@example.invalid"])
    run("git", ["add", "."])
    run("git", ["commit", "-m", "fixture"])
    run("git", ["remote", "add", "origin", join(temp, "remote.git")])
    run("git", ["push", "-u", "origin", "main"])
    const args = selected.flatMap((name) => ["--package", name])
    const result = spawnSync("bash", ["scripts/release-npm.sh", "--confirm", "--yes", "--no-push", ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    })
    expect(result.status).toBe(fail ? 1 : 0)
    expect(JSON.parse(readFileSync(join(repo, "packages/sdk/js/package.json"), "utf8")).version).toBe(sdk)
    expect(JSON.parse(readFileSync(join(repo, "packages/plugin/package.json"), "utf8")).version).toBe(plugin)
    if (fail) expect(run("git", ["tag", "--list"])).toBe("")
    else expect(run("git", ["tag", "--list"])).toContain(tag)
    const calls = readFileSync(env.CALL_LOG, "utf8")
    expect(calls).toContain(`--check ${args.join(" ")}`)
    if (fail) expect(calls).not.toContain("verify-npm.ts")
    else expect(calls).toContain(`verify-npm.ts ${args.join(" ")}`)
    if (selected.length === 1)
      expect(calls).not.toContain(
        selected[0].endsWith("sdk") ? "--package @wopal/ellamaka-plugin" : "--package @wopal/ellamaka-sdk",
      )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
