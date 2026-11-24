import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Tests for build.sh's install_app. The swap runs in a fresh bash subprocess
// against a throwaway install root, so the assertions cover the
// property that matters: a failed install never leaves the user without a
// working app, and a successful one leaves no staging residue behind.

const REPO_ROOT = join(import.meta.dir, "../..")

function runInstall(
  source: string,
  root: string,
  appName = "Ellamaka Main",
): { code: number; stderr: string; stdout: string } {
  const script = `
    set -euo pipefail
    eval "$(sed -n '/^install_app() {/,/^}/p' "$REPO_ROOT/scripts/build.sh")"
    install_app "$SOURCE" "$APP_NAME"
    echo REACHED-AFTER-INSTALL
  `
  const proc = Bun.spawnSync(["bash", "-c", script], {
    env: { ...process.env, REPO_ROOT, SOURCE: source, APP_NAME: appName, ELLAMAKA_INSTALL_ROOT: root },
  })
  return { code: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
}

async function fakeApp(parent: string, name: string, marker: string) {
  const app = join(parent, `${name}.app`)
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true })
  await writeFile(join(app, "Contents", "MacOS", "marker.txt"), marker)
  return app
}

async function withRoot<A>(callback: (root: string) => Promise<A>) {
  const root = await mkdtemp(join(tmpdir(), "ellamaka-install-"))
  try {
    return await callback(root)
  } finally {
    // A test may lock a directory to force a cleanup failure; restore write
    // access so removing the throwaway root cannot fail in turn. Bun's
    // recursive chmod does not descend, so unlock through chmod(1).
    await Bun.$`chmod -R u+w ${root}`.quiet().nothrow()
    await rm(root, { recursive: true, force: true })
  }
}

function markerOf(appPath: string) {
  return Bun.file(join(appPath, "Contents", "MacOS", "marker.txt")).text()
}

describe("build.sh install_app", () => {
  test("fresh install places the app under the install root", async () => {
    await withRoot(async (root) => {
      const source = await fakeApp(join(root, "build"), "Ellamaka Main", "new")
      const result = runInstall(source, root)
      expect(result.code).toBe(0)
      expect(await markerOf(join(root, "Ellamaka Main.app"))).toBe("new")
    })
  })

  test("replaces an existing install and leaves no staging residue", async () => {
    await withRoot(async (root) => {
      await fakeApp(root, "Ellamaka Main", "old")
      const source = await fakeApp(join(root, "build"), "Ellamaka Main", "new")
      const result = runInstall(source, root)
      expect(result.code).toBe(0)
      expect(await markerOf(join(root, "Ellamaka Main.app"))).toBe("new")
      // The staging workspace is a hidden mktemp directory, so any dot entry
      // left behind is residue.
      const leftovers = (await readdir(root)).filter((name) => name.startsWith("."))
      expect(leftovers).toEqual([])
    })
  })

  test("keeps the installed app when the copy cannot happen", async () => {
    await withRoot(async (root) => {
      await fakeApp(root, "Ellamaka Main", "old")
      const missing = join(root, "does-not-exist", "Ellamaka Main.app")
      const result = runInstall(missing, root)
      expect(result.code).not.toBe(0)
      // The failure path must not have touched the installed bundle.
      expect(existsSync(join(root, "Ellamaka Main.app"))).toBe(true)
      expect(await markerOf(join(root, "Ellamaka Main.app"))).toBe("old")
    })
  })

  // Regression: the cleanup of the previous bundle runs under `set -e` after the
  // new bundle has already landed. An unguarded `rm -rf` there killed the build
  // mid-install, so step 3 printed no success line even though the app had been
  // installed correctly. The failed cleanup is housekeeping noise, not a failure.
  test("a successful install still reports success when the old bundle cannot be removed", async () => {
    await withRoot(async (root) => {
      await fakeApp(root, "Ellamaka Main", "old")
      const source = await fakeApp(join(root, "build"), "Ellamaka Main", "new")

      // An undeletable directory inside the installed bundle: `mv` can still
      // rename the bundle aside, but `rm -rf` of that copy must fail.
      const locked = join(root, "Ellamaka Main.app", "Contents", "locked")
      await mkdir(locked, { recursive: true })
      await writeFile(join(locked, "keep"), "x")
      await chmod(locked, 0o555)

      try {
        const result = runInstall(source, root)
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("REACHED-AFTER-INSTALL")
        expect(result.stderr).toContain("could not remove the previous bundle")
        // The new bundle is the one that survived.
        expect(await markerOf(join(root, "Ellamaka Main.app"))).toBe("new")
      } finally {
        await chmod(locked, 0o755).catch(() => {})
      }
    })
  })
})
