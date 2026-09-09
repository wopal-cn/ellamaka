import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * B-01 audit: production mount paths must never fall back to the host package
 * closure.
 *
 * Packaged hosts (CLI bundle, Desktop sidecar) ship WITHOUT `@deepseek-ai/*`
 * in their own closure, so `new CordisHub(null)` with no injected context, or
 * any lazy `createPackageDshRuntimeApi()` fallback reached at mount time,
 * fails at runtime on a packaged host.
 *
 * This is a static scan over the entry files asserting the production mount
 * call sites always:
 *  - construct `CordisHub` with an injected `{ context: ... }` from the
 *    closure-resolved runtime, and
 *  - pass `runtime` to `bootDshWeb`/`bootDshTools`/`mountDshWeb`/`mountDshTools`.
 *
 * The audit intentionally greps the files (read-only, no network, no package
 * install) so a regression that reintroduces a bare `new CordisHub(null)` in a
 * prod entry fails the gate.
 */
describe("B-01: production mount sites inject the closure-resolved runtime", () => {
  const entries = [
    // CLI serve/web assembly.
    {
      path: "packages/opencode/src/cli/cmd/dsh-mount.ts",
      // The hub must be constructed with an injected closure context, never a
      // bare `new CordisHub(null)` (which falls back to the package closure).
      mustNotMatch: [/new CordisHub\(null\)/],
      mustMatch: [/new CordisHub\(null, \{ context: new runtime\.cordis\.Context\(\) \}\)/],
    },
    // TUI tool container.
    {
      path: "packages/opencode/src/cli/cmd/tui/dsh-mount.ts",
      mustNotMatch: [/new CordisHub\(null\)/],
      mustMatch: [/new CordisHub\(null, \{ context: new runtime\.cordis\.Context\(\) \}\)/],
    },
    // Desktop sidecar — uses bootDshWeb/bootDshTools, which build the hub from
    // the injected runtime themselves; the runtime must be passed in.
    {
      path: "packages/ellamaka-desktop/src/main/sidecar.ts",
      mustNotMatch: [/new CordisHub\(/],
      // Both mounts pass the closure runtime into the boot entry points.
      mustMatch: [/bootDshWeb\(\{[\s\S]*?runtime,/, /bootDshTools\(\{[\s\S]*?runtime,/],
    },
  ]

  // B-06 / W-02 code-level guarantees for the Desktop sidecar: the dsh mounts
  // must be wrapped in a degrade boundary (catch, log, continue — never
  // process.exit) and initialise the runtime once per launch (shared state).
  test("desktop sidecar dsh mounts degrade (no exit) and initialise once per launch", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "packages", "ellamaka-desktop", "src", "main", "sidecar.ts"),
      "utf-8",
    )
    // Both mount functions catch and continue (B-06): the structured log
    // tags the sidecar writes on mount failure (the console.error lines were
    // renamed to structured tags in 0ea73aa0aa).
    expect(source).toMatch(/dsh\.desktop\.web\.failed/)
    expect(source).toMatch(/dsh\.desktop\.tools\.failed/)
    // The runtime is initialised once per launch (W-02).
    expect(source).toMatch(/initDshLaunch/)
    expect(source).toMatch(/dshLaunchState/)
  })

  // dshmarket install-worker contract: `bootDshWeb` must receive an
  // `ellamakaCommand` on the Desktop sidecar, otherwise the market's
  // `apply()` probes no `desktopProfiles` service and falls back to the
  // CLI-spawn path — spawning the OFFICIAL `dsh` CLI, whose installer is
  // pnpm. That path is incompatible with this workspace (private
  // `@wopal/*` packages in the profile manifest are unresolvable from a
  // public registry; the failed pnpm run quarantines every previously
  // installed plugin into `node_modules/.ignored/`). Passing
  // `ellamakaCommand` provides the desktopProfiles/desktopPnpm install
  // worker and the market routes installs through the ellamaka Bun
  // installer instead (DESIGN-dsh-poc 「Bun 安装器流水线」).
  test("desktop sidecar bootDshWeb supplies the market install worker (ellamakaCommand)", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "packages", "ellamaka-desktop", "src", "main", "sidecar.ts"),
      "utf-8",
    )
    expect(source).toMatch(/bootDshWeb\(\{[\s\S]*?ellamakaCommand,/)
    // The command resolves through the dedicated env var the launcher sets
    // (dev points it at the worktree source entry run via bun); a plain
    // `process.execPath` fallback would resolve to Electron's helper
    // executable under utilityProcess.fork and spawn a non-CLI process.
    expect(source).toMatch(/ELLAMAKA_DSH_INSTALL_COMMAND/)
  })

  test("serve and desktop bind dshmarket activation to the one host watcher", () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const serve = readFileSync(join(root, "packages", "opencode", "src", "cli", "cmd", "dsh-mount.ts"), "utf-8")
    const desktop = readFileSync(join(root, "packages", "ellamaka-desktop", "src", "main", "sidecar.ts"), "utf-8")

    // Market install calls the web host bridge. Both production mount paths
    // must bind that bridge to the SAME Plugin Runtime Service replay: a
    // missing binding falls back to market hotMount and reintroduces a second
    // .dsh-market loader source for each newly installed plugin.
    expect(serve).toMatch(/dsh\.pluginActivation\?\.bind\(\(\) => pluginService!\.replay\(\)\)/)
    expect(desktop).toMatch(/dshHost\.pluginActivation\?\.bind\(\(\) => dshPluginService!\.replay\(\)\)/)
    expect(desktop).toMatch(/dshHost = \{[\s\S]*?pluginActivation: host\.pluginActivation,/)
  })

  for (const entry of entries) {
    test(`mount site ${entry.path} injects the closure runtime (no bare-hub fallback)`, () => {
      // test/ -> ellamaka-cordis (..) -> packages (..) -> worktree root (..).
      const abs = join(import.meta.dir, "..", "..", "..", entry.path)
      const source = readFileSync(abs, "utf-8")
      for (const re of entry.mustNotMatch) {
        expect(source).not.toMatch(re)
      }
      for (const re of entry.mustMatch) {
        expect(source).toMatch(re)
      }
    })
  }
})
