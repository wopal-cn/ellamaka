import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootDshTools, bootDshWeb } from "../src/dsh-web"
import { prepareDshProfiles } from "./fixture/prepare-dsh-profiles"

const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-activation-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Insert a user plugin row that can never activate: the bundle package does
 * not exist, so the loader import fails and the entry stays inactive.
 * User patches live in the harness-home profile area (`<home>/home/profiles/
 * <profile>/cordis.patch.yml`), NOT the territory-root profiles directory.
 */
function seedBrokenUserPlugin(profile: "ellamaka-tools" | "web"): (home: string) => void {
  return (home: string) => {
    const profileDir = join(home, "home", "profiles", profile)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, "cordis.patch.yml"),
      ["- insert:", "    - id: broken-user-plugin", "      name: no-such-dsh-plugin-package", ""].join("\n"),
    )
  }
}

describe("tools container activation gate", () => {
  test("bootDshTools fails closed when a plugin entry does not activate", async () => {
    const home = tempHome()
    prepareDshProfiles(home)
    seedBrokenUserPlugin("ellamaka-tools")(home)
    let error: unknown
    try {
      await bootDshTools({ home, port: 0 })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : String(error)).toContain("broken-user-plugin")
  }, 120_000)

  test("bootDshWeb keeps the optional-entry audit behavior (warn, not throw)", async () => {
    const home = tempHome()
    prepareDshProfiles(home)
    seedBrokenUserPlugin("web")(home)
    const web = await bootDshWeb({ home, port: 4097, disablePtcRuntime: true })
    expect(web.includeEntry).toBeDefined()
    await web.dispose()
  }, 120_000)
})
