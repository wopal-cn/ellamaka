import { describe, expect, test } from "bun:test"
import { join, dirname, resolve } from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(dir, "../..")

const html = async (name: string) => Bun.file(join(dir, name)).text()

/**
 * Packaged Electron windows load renderer HTML via the privileged `oc://`
 * protocol. Root-relative asset paths like `src="/foo.js"` would resolve from
 * the protocol origin root instead of relative to the current HTML entrypoint.
 *
 * All local resource references must use relative paths (`./`).
 */
describe("electron renderer html", () => {
  for (const name of ["index.html", "loading.html"]) {
    describe(name, () => {
      test("script src attributes use relative paths", async () => {
        const content = await html(name)
        const srcs = [...content.matchAll(/\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
        for (const src of srcs) {
          expect(src).not.toMatch(/^\/[^/]/)
        }
      })

      test("link href attributes use relative paths", async () => {
        const content = await html(name)
        const hrefs = [...content.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1])
        for (const href of hrefs) {
          expect(href).not.toMatch(/^\/[^/]/)
        }
      })

      test("no web manifest link (not applicable in Electron)", async () => {
        const content = await html(name)
        expect(content).not.toContain('rel="manifest"')
      })
    })
  }
})

/**
 * Vite resolves `publicDir` relative to `root`, not the config file.
 * This test reads the actual values from electron.vite.config.ts to catch
 * regressions where the publicDir path no longer resolves correctly
 * after the renderer root is accounted for.
 */
describe("electron vite publicDir", () => {
  test("configured publicDir resolves to a directory with oc-theme-preload.js", async () => {
    const config = await Bun.file(join(root, "electron.vite.config.ts")).text()
    const pub = config.match(/publicDir:\s*["']([^"']+)["']/)
    const rendererRoot = config.match(/root:\s*["']([^"']+)["']/)
    expect(pub).not.toBeNull()
    expect(rendererRoot).not.toBeNull()
    const resolved = resolve(root, rendererRoot![1], pub![1])
    expect(existsSync(resolved)).toBe(true)
    expect(existsSync(join(resolved, "oc-theme-preload.js"))).toBe(true)
  })
})

describe("macOS workbench titlebar", () => {
  test("keeps traffic lights in a dedicated drag strip above the app toolbar", async () => {
    const entry = await Bun.file(join(dir, "index.tsx")).text()
    const styles = await Bun.file(join(dir, "styles.css")).text()
    const titlebar = await Bun.file(join(root, "../ellamaka-app/src/pages/workbench/parts/top-bar.tsx")).text()

    expect(entry).toContain("document.documentElement.dataset.platform")
    expect(styles).toContain(".workbench-macos-window-chrome")
    expect(styles).toContain("height: 28px")
    expect(titlebar).toContain("workbench-macos-window-chrome")
    expect(titlebar).toContain("workbench-titlebar-toolbar")
    expect(titlebar).not.toContain("workbench-titlebar-left-inset")

    // Ensure header uses flex-col two-row layout
    expect(titlebar).toMatch(/<header[^>]+class="[^"]*flex-col[^"]*"/)

    // Chrome drag strip must precede the toolbar in DOM structure
    const chromeIndex = titlebar.indexOf("workbench-macos-window-chrome")
    const toolbarIndex = titlebar.indexOf("workbench-titlebar-toolbar")
    expect(chromeIndex).toBeGreaterThan(-1)
    expect(toolbarIndex).toBeGreaterThan(-1)
    expect(chromeIndex).toBeLessThan(toolbarIndex)

    // Brand logo must be rendered inside the toolbar section
    const logoIndex = titlebar.indexOf('alt="Logo"')
    expect(logoIndex).toBeGreaterThan(toolbarIndex)
  })
})

describe("desktop initial route", () => {
  test("starts on the neutral route before the shared startup gate chooses a stage", async () => {
    const entry = await Bun.file(join(dir, "index.tsx")).text()
    const router = await Bun.file(join(dir, "desktop-router.tsx")).text()

    expect(entry).toContain('import { DesktopRouter } from "./desktop-router"')
    expect(entry).not.toContain("WorkbenchRedirect")
    expect(router).toContain('value: "/startup"')
    expect(router).toContain("<MemoryRouter {...props} history={desktopHistory} />")
  })
})
