import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDependencyRebuildGate, dependencySnapshot } from "../src/plugins/rebuild-gate"

/**
 * `dsh:web` external rebuild gate (DESIGN.md#unified-reload--lifecycle 两级重载).
 *
 * The web container runs in a child process that owns its own composition
 * watcher: a profile patch/config edit replays IN PLACE there. The host's
 * plugin runtime service sees the same files, but its only lever is an
 * external rebuild (new child process) — which drops every live WebSocket and
 * makes the iframe reconnect. A cold rebuild is therefore reserved for the one
 * change that genuinely needs a fresh module graph: a DEPENDENCY change.
 */

describe("dependencySnapshot", () => {
  test("hashes the manifest dependencies and ignores bundle rows", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-rebuild-gate-snap-"))
    try {
      const dir = join(root, "home", "profiles", "web")
      mkdirSync(dir, { recursive: true })
      const write = (manifest: unknown) =>
        writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8")

      write({
        name: "web",
        dependencies: { "@wopal/dsh-presets": "1.0.0", dshmarket: "^1.2.0" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      })
      const baseline = dependencySnapshot(dir)

      // Bundle enable/disable + unrelated fields are composition changes: the
      // child replays those itself, so the snapshot must not move.
      write({
        name: "web",
        dependencies: { dshmarket: "^1.2.0", "@wopal/dsh-presets": "1.0.0" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@wopal/dsh-presets"] } },
        version: "9.9.9",
      })
      expect(dependencySnapshot(dir)).toBe(baseline)

      // A dependency version change is the cold-reload trigger.
      write({
        name: "web",
        dependencies: { "@wopal/dsh-presets": "2.0.0", dshmarket: "^1.2.0" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
      })
      expect(dependencySnapshot(dir)).not.toBe(baseline)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("createDependencyRebuildGate", () => {
  function gate(initial: string) {
    let snapshot = initial
    let builds = 0
    let failing = false
    const apply = createDependencyRebuildGate({
      profileDir: "/unused",
      readSnapshot: () => snapshot,
      rebuild: async () => {
        builds += 1
        if (failing) {
          failing = false
          throw new Error("simulated cold rebuild failure")
        }
      },
    })
    return {
      apply,
      change(next: string) {
        snapshot = next
      },
      failNext() {
        failing = true
      },
      get builds() {
        return builds
      },
    }
  }

  test("a composition-only change leaves the running child alone", async () => {
    const subject = gate("a")
    await subject.apply()
    await subject.apply()
    expect(subject.builds).toBe(0)
  })

  test("the FIRST observed change already rebuilds (boot baseline is captured at construction)", async () => {
    // The callback only runs after a file change, so a lazily captured
    // baseline would swallow the very first dependency edit.
    const subject = gate("a")
    subject.change("b")
    await subject.apply()
    expect(subject.builds).toBe(1)
  })

  test("a dependency change rebuilds once and adopts the new snapshot", async () => {
    const subject = gate("a")
    subject.change("b")
    await subject.apply()
    expect(subject.builds).toBe(1)
    // The composition watcher fires more than once per write burst; an already
    // adopted dependency set must not rebuild again.
    await subject.apply()
    expect(subject.builds).toBe(1)
  })

  test("a failed rebuild keeps the old snapshot so the next observation retries", async () => {
    const subject = gate("a")
    subject.change("b")
    subject.failNext()
    await expect(subject.apply()).rejects.toThrow("simulated cold rebuild failure")
    await subject.apply()
    expect(subject.builds).toBe(2)
  })
})
