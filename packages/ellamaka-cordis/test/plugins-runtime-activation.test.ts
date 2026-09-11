import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDshPluginService, type DshPluginContainer, type DshPluginServiceHandle } from "../src/plugins/runtime"
import { profileDirOf } from "../src/plugins/compose"

/**
 * The host-activation acknowledgement contract (`DshPluginServiceHandle.replay`).
 *
 * A market install calls `replay()` and reads `{ ok: true }` as "the new
 * plugin is live". That inference only holds when the acknowledged replay
 * OBSERVED the caller's change. The composition-file watcher fires on its own
 * and can already be replaying when the market calls: if the service answers
 * with that in-flight run's result, the caller is told its change is live
 * while nothing has looked at it yet.
 *
 * These cases drive the service through a fake container and a real temp home,
 * so each one settles deterministically without booting a dsh container.
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
 * A fake container whose include entry records every applied composition and
 * can be gated, so a replay provably stays in flight while the test acts.
 */
function fakeContainer(profile: string, applied: unknown[]) {
  let gate: Promise<void> = Promise.resolve()
  let openGate: () => void = () => {}
  let calls = 0
  const container = {
    profile,
    ctx: {},
    includeEntry: {
      id: `include:${profile}`,
      options: { config: { patches: [] as unknown[] } },
      async update(options: unknown): Promise<void> {
        calls += 1
        if (calls === 1) await gate
        const config = (options as { config?: Record<string, unknown> }).config ?? {}
        const { patches: _previous, ...rest } = (this.options.config ?? {}) as Record<string, unknown>
        this.options.config = { ...rest, ...config }
        applied.push(this.options.config)
      },
    },
    // The composition is pure transport here: an empty static stack keeps the
    // fake home self-contained.
    stackContext: { profileLayers: [], userPatches: [], extraPatches: [], homePatches: [] },
  } satisfies DshPluginContainer
  return {
    container,
    gateFirstUpdate(): void {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    release(): void {
      openGate()
    },
    get calls(): number {
      return calls
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dsh-plugins-activation-"))
})

afterEach(async () => {
  await service?.stop()
  service = undefined
  rmSync(home, { recursive: true, force: true })
})

describe("host activation acknowledgement", () => {
  test("replay() observes a change that lands while another replay is in flight", async () => {
    writeManifest("web", "1.0.0")
    const applied: unknown[] = []
    const fake = fakeContainer("web", applied)
    fake.gateFirstUpdate()
    service = startDshPluginService({ home, containers: [fake.container] })

    // A REAL composition change starts replay #1 and holds it in flight.
    writeManifest("web", "2.0.0")
    const inFlight = service.replay()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.calls).toBe(1) // replay #1 is genuinely in flight

    // The market's change lands mid-replay, then it asks for acknowledgement.
    writeManifest("web", "3.0.0")
    const acknowledged = service.replay()
    await new Promise((resolve) => setTimeout(resolve, 20))
    fake.release()

    const [first, second] = await Promise.all([inFlight, acknowledged])
    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    // The acknowledgement must come from a SECOND, later observation:
    // replay #1 read the composition before version 3.0.0 existed.
    expect(fake.calls).toBeGreaterThanOrEqual(2)
  })

  test("replay() answers for a run that reads the composition after the call", async () => {
    writeManifest("web", "1.0.0")
    const applied: unknown[] = []
    const fake = fakeContainer("web", applied)
    service = startDshPluginService({ home, containers: [fake.container] })

    // Settle the boot-adopted state (no change -> no replay).
    expect(await service.replay()).toEqual({ ok: true })
    expect(fake.calls).toBe(0)

    // A real change, acknowledged in the same turn.
    writeManifest("web", "2.0.0")
    expect(await service.replay()).toEqual({ ok: true })
    expect(fake.calls).toBe(1)
    // The applied composition is the one that includes the new manifest.
    expect(applied.length).toBe(1)
  })
})
