import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDshPluginService, type DshPluginContainer, type DshPluginServiceHandle } from "../src/plugins/runtime"
import { profileDirOf } from "../src/plugins/compose"

/**
 * Per-unit reload scoping (DESIGN.md#unified-reload--lifecycle, Plan Task 9).
 *
 * Each reload unit (`dsh:web` / `dsh:tools`) invalidates INDEPENDENTLY: a web
 * profile composition change replays only the web container — the tools
 * container is untouched, no `dsh:tools` invalidation, no shared hash. A
 * failure in one unit degrades that unit alone; the sibling keeps its last
 * good state and still replays on its own next real change.
 */

let home: string
let service: DshPluginServiceHandle | undefined

/** Write the watched manifest so its hashed content changes. */
function writeManifest(profile: string, version: string): void {
  const dir = profileDirOf(home, profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `p-${profile}`, version }, null, 2))
}

/**
 * A fake container that records every applied composition; `failNext` makes
 * exactly one `includeEntry.update` throw, simulating a compose/mount failure.
 */
function fakeContainer(profile: string, applied: string[]) {
  let failing = false
  const container = {
    profile,
    ctx: {},
    includeEntry: {
      id: `include:${profile}`,
      options: { config: { patches: [] as unknown[] } },
      async update(options: unknown): Promise<void> {
        if (failing) {
          failing = false
          throw new Error(`simulated ${profile} composition failure`)
        }
        const config = (options as { config?: Record<string, unknown> }).config ?? {}
        const { patches: _previous, ...rest } = (this.options.config ?? {}) as Record<string, unknown>
        this.options.config = { ...rest, ...config }
        applied.push(JSON.stringify(this.options.config))
      },
    },
    // The composition is pure transport here: an empty static stack keeps the
    // fake home self-contained.
    stackContext: { profileLayers: [], userPatches: [], extraPatches: [], homePatches: [] },
  } satisfies DshPluginContainer
  return {
    container,
    failNext(): void {
      failing = true
    },
    get calls(): number {
      return applied.length
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dsh-plugins-unit-scope-"))
})

afterEach(async () => {
  await service?.stop()
  service = undefined
  rmSync(home, { recursive: true, force: true })
})

describe("per-unit reload scoping", () => {
  test("a web profile change replays only dsh:web and leaves dsh:tools untouched", async () => {
    writeManifest("web", "1.0.0")
    writeManifest("ellamaka-tools", "1.0.0")
    const webApplied: string[] = []
    const toolsApplied: string[] = []
    const web = fakeContainer("web", webApplied)
    const tools = fakeContainer("ellamaka-tools", toolsApplied)
    service = startDshPluginService({ home, containers: [web.container, tools.container] })
    // Adopt the boot state for both units.
    expect(await service.replay()).toEqual({ ok: true })
    expect(web.calls).toBe(0)
    expect(tools.calls).toBe(0)

    // Only the WEB profile changes: the tools unit must not invalidate.
    writeManifest("web", "2.0.0")
    const result = await service.replay()
    expect(result).toEqual({ ok: true })
    expect(web.calls).toBe(1)
    expect(tools.calls).toBe(0)
  })

  test("a tools profile change replays only dsh:tools (negative for web)", async () => {
    writeManifest("web", "1.0.0")
    writeManifest("ellamaka-tools", "1.0.0")
    const webApplied: string[] = []
    const toolsApplied: string[] = []
    const web = fakeContainer("web", webApplied)
    const tools = fakeContainer("ellamaka-tools", toolsApplied)
    service = startDshPluginService({ home, containers: [web.container, tools.container] })
    expect(await service.replay()).toEqual({ ok: true })

    writeManifest("ellamaka-tools", "2.0.0")
    expect(await service.replay()).toEqual({ ok: true })
    expect(tools.calls).toBe(1)
    expect(web.calls).toBe(0)
  })

  test("a dsh:web failure degrades dsh:web alone; dsh:tools still replays", async () => {
    writeManifest("web", "1.0.0")
    writeManifest("ellamaka-tools", "1.0.0")
    const webApplied: string[] = []
    const toolsApplied: string[] = []
    const web = fakeContainer("web", webApplied)
    const tools = fakeContainer("ellamaka-tools", toolsApplied)
    service = startDshPluginService({ home, containers: [web.container, tools.container] })
    expect(await service.replay()).toEqual({ ok: true })

    // BOTH profiles change, but the web update fails. The whole replay
    // reports the failure (the market must not hear "ok"), the tools
    // container STILL got its new composition (unit isolation), and the web
    // container keeps its last good state.
    web.failNext()
    writeManifest("web", "2.0.0")
    writeManifest("ellamaka-tools", "2.0.0")
    const failed = await service.replay()
    expect(failed).toEqual({ ok: false, error: expect.stringContaining("simulated web composition failure") })
    expect(tools.calls).toBe(1)
    expect(web.calls).toBe(0)

    // The FAILED unit's hash is kept (no retry storm); its next real change
    // recovers it independently.
    writeManifest("web", "3.0.0")
    const recovered = await service.replay()
    expect(recovered).toEqual({ ok: true })
    expect(web.calls).toBe(1)
    expect(tools.calls).toBe(1) // tools unchanged since its 2.0.0 replay
  })
})
