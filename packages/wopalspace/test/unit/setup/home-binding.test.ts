import { describe, expect, test } from "bun:test"
import { createSetupHomeBinding, SetupServiceError } from "../../../src/setup"

function harness(input: {
  mode: "normal" | "development"
  initialPath: string
  source: "shell" | "default"
  locked: boolean
  persistFails?: boolean
}) {
  const calls: string[] = []
  const binding = createSetupHomeBinding({
    mode: input.mode,
    initialPath: input.initialPath,
    source: input.source,
    locked: input.locked,
    normalizePath: (value) => {
      const path = value.trim()
      if (!path.startsWith("/")) throw new Error("absolute path required")
      return path.replace(/\/+$/, "") || "/"
    },
    persist: async (path) => {
      calls.push(`persist:${path}`)
      if (input.persistFails) throw new Error("profile is read-only")
    },
    apply: async (path) => {
      calls.push(`apply:${path}`)
    },
  })
  return { binding, calls }
}

describe("Setup Home binding", () => {
  test("normal mode keeps an existing shell Home locked", async () => {
    const { binding, calls } = harness({
      mode: "normal",
      initialPath: "/home/user/.wopal",
      source: "shell",
      locked: true,
    })

    expect(binding.inspect()).toEqual({
      mode: "normal",
      source: "shell",
      path: "/home/user/.wopal",
      locked: true,
      selectable: false,
      persisted: true,
    })

    await expect(binding.select("/tmp/other-home")).rejects.toMatchObject({ code: "SETUP_HOME_LOCKED" })
    expect(calls).toEqual([])
  })

  test("normal first use persists before applying and locking the selected Home", async () => {
    const { binding, calls } = harness({
      mode: "normal",
      initialPath: "/home/user/.wopal",
      source: "default",
      locked: false,
    })

    const result = await binding.select("  /srv/wopal-home/  ")

    expect(calls).toEqual(["persist:/srv/wopal-home", "apply:/srv/wopal-home"])
    expect(result).toEqual({
      mode: "normal",
      source: "selected",
      path: "/srv/wopal-home",
      locked: true,
      selectable: false,
      persisted: true,
    })
    expect(binding.inspect()).toEqual(result)
  })

  test("development mode can override the shell candidate without persisting it", async () => {
    const { binding, calls } = harness({
      mode: "development",
      initialPath: "/home/user/.wopal",
      source: "shell",
      locked: false,
    })

    expect(binding.inspect().selectable).toBe(true)
    const result = await binding.select("/tmp/uat-home")

    expect(calls).toEqual(["apply:/tmp/uat-home"])
    expect(result.persisted).toBe(false)
    expect(result.locked).toBe(true)
    expect(result.path).toBe("/tmp/uat-home")
  })

  test("a persistence failure leaves normal mode unlocked and does not apply the path", async () => {
    const { binding, calls } = harness({
      mode: "normal",
      initialPath: "/home/user/.wopal",
      source: "default",
      locked: false,
      persistFails: true,
    })

    await expect(binding.select("/srv/wopal-home")).rejects.toMatchObject({ code: "SETUP_HOME_PERSIST_FAILED" })
    expect(calls).toEqual(["persist:/srv/wopal-home"])
    expect(binding.inspect().locked).toBe(false)
  })

  test("locked selection is idempotent for the same path and rejects a different path", async () => {
    const { binding, calls } = harness({
      mode: "development",
      initialPath: "/tmp/start",
      source: "default",
      locked: false,
    })
    await binding.select("/tmp/chosen")
    calls.length = 0

    expect(await binding.select("/tmp/chosen/")).toEqual(binding.inspect())
    expect(calls).toEqual([])
    await expect(binding.select("/tmp/other")).rejects.toBeInstanceOf(SetupServiceError)
  })

  test("invalid paths fail before persistence or apply", async () => {
    const { binding, calls } = harness({
      mode: "development",
      initialPath: "/tmp/start",
      source: "default",
      locked: false,
    })

    await expect(binding.select("relative/home")).rejects.toMatchObject({ code: "SETUP_HOME_INVALID" })
    expect(calls).toEqual([])
  })
})
