import { describe, expect, test } from "bun:test"
import { installOptionalPresetBundle } from "../src/plugins/preset-bundle"

describe("optional preset bundle installation", () => {
  test("not selected is a strict no-op and never resolves the plugin manager", async () => {
    let reads = 0
    const ctx = {
      get() {
        reads += 1
        throw new Error("must not resolve plugin manager")
      },
    }

    expect(
      await installOptionalPresetBundle(ctx, {
        selected: false,
        spec: "/read-only/ontology/dsh/agents-presets",
      }),
    ).toEqual({ selected: false })
    expect(reads).toBe(0)
  })

  test("selected bundle delegates to the official install queue and preserves restart-required", async () => {
    const calls: unknown[][] = []
    const restart = {
      changed: true,
      application: "restart-required" as const,
      stage: "install" as const,
      target: "@wopal/dsh-presets",
      enabled: true,
      bundle: "@wopal/dsh-presets",
    }
    const ctx = {
      get(name: string) {
        expect(name).toBe("pluginManager")
        return {
          async installBundle(...args: unknown[]) {
            calls.push(args)
            return restart
          },
        }
      },
    }

    const result = await installOptionalPresetBundle(ctx, {
      selected: true,
      spec: "/read-only/ontology/dsh/agents-presets",
    })
    expect(calls).toEqual([["/read-only/ontology/dsh/agents-presets", { enabled: true }]])
    expect(result).toEqual({ selected: true, change: restart })
  })

  test("plugin-management failure is surfaced without inventing an applied state", async () => {
    const failed = {
      changed: false,
      application: "failed" as const,
      stage: "install" as const,
      target: "@wopal/dsh-presets",
      error: { code: "operation-error" as const, diagnostic: "fixture failure" },
    }
    const ctx = {
      get() {
        return { installBundle: async () => failed }
      },
    }

    expect(await installOptionalPresetBundle(ctx, { selected: true, spec: "/fixture/presets" })).toEqual({
      selected: true,
      change: failed,
    })
  })
})
