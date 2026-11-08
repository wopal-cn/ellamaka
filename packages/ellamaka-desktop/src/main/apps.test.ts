import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkAppExists } from "./apps"

// A GUI cold start inherits only the system directories; the login shell adds
// user-level ones. Discovery must follow whichever environment it is handed.
const GUI_MINIMAL_PATH = "/usr/bin:/bin"

async function withShellOnlyExecutable<T>(name: string, run: (dir: string) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), "app-discovery-"))
  try {
    const tool = join(dir, name)
    writeFileSync(tool, "#!/bin/sh\nexit 0\n")
    chmodSync(tool, 0o755)
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("checkAppExists", () => {
  test("finds an executable that only the login-shell PATH carries", async () => {
    await withShellOnlyExecutable("ellamaka-shell-only-tool", async (dir) => {
      // GUI-minimal inherited PATH: the shell-only executable is invisible.
      expect(await checkAppExists("ellamaka-shell-only-tool", { PATH: GUI_MINIMAL_PATH }, "darwin")).toBe(false)
      // Host Environment resolved from the login shell: it resolves.
      expect(await checkAppExists("ellamaka-shell-only-tool", { PATH: `${dir}:${GUI_MINIMAL_PATH}` }, "darwin")).toBe(
        true,
      )
    })
  })

  test("keeps the standard PATH lookup working", async () => {
    expect(await checkAppExists("sh", { PATH: GUI_MINIMAL_PATH }, "darwin")).toBe(true)
  })

  test("keeps the non-macOS short circuits", async () => {
    expect(await checkAppExists("definitely-not-installed-tool", { PATH: "/nonexistent" }, "linux")).toBe(true)
    expect(await checkAppExists("definitely-not-installed-tool", { PATH: "/nonexistent" }, "win32")).toBe(true)
  })

  test("Desktop Main hands the resolved Host Environment to app discovery", () => {
    // The replacement for the removed global PATH merge is explicit input; a
    // revert to `checkAppExists(appName)` would silently regress open-with.
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
    expect(index).toContain("checkAppExists(appName, opts.host.env)")
    expect(index).not.toContain("checkAppExists: (appName) => checkAppExists(appName),")
  })
})
