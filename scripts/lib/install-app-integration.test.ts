import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Tests for build.sh's install_app. The swap runs in a fresh bash subprocess
// against a throwaway install root, so the assertions cover the
// property that matters: a failed install never leaves the user without a
// working app, and a successful one leaves no staging residue behind.

const REPO_ROOT = join(import.meta.dir, "../..")

function runInstall(source: string, root: string, appName = "Ellamaka Main"): { code: number; stderr: string } {
  const script = `
    set -euo pipefail
    eval "$(sed -n '/^install_app() {/,/^}/p' "$REPO_ROOT/scripts/build.sh")"
    install_app "$SOURCE" "$APP_NAME"
  `
  const proc = Bun.spawnSync(["bash", "-c", script], {
    env: { ...process.env, REPO_ROOT, SOURCE: source, APP_NAME: appName, ELLAMAKA_INSTALL_ROOT: root },
  })
  return { code: proc.exitCode, stderr: proc.stderr.toString() }
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
      const leftovers = (await readdir(root)).filter((name) => name.includes(".app."))
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
})
