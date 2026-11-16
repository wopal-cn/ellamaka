import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

function spaceTemp(): string {
  let directory = import.meta.dir
  while (dirname(directory) !== directory) {
    const candidate = join(directory, ".wopal-space", ".tmp")
    if (existsSync(candidate)) return candidate
    directory = dirname(directory)
  }
  throw new Error("workspace .wopal-space/.tmp is required for the integration fixture")
}

test.each(["ws", "http"] as const)(
  "DSH desktop %s proxy handles upstream TCP reset without crashing Main",
  async (mode) => {
    const directory = mkdtempSync(join(spaceTemp(), "dsh-proxy-reset-"))
    try {
      const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "dsh-proxy.ts")],
        target: "node",
        format: "esm",
      })
      expect(build.success).toBe(true)
      const modulePath = join(directory, "proxy.mjs")
      await Bun.write(modulePath, await build.outputs[0]!.text())
      const fixture = resolve(import.meta.dir, "../../test/fixtures/dsh-proxy-reset.mjs")
      const result = spawnSync("node", [fixture, modulePath, mode], { encoding: "utf8", timeout: 8000 })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`"mode":"${mode}"`)
      expect(result.stdout).toContain('"sawResponse":true')
      expect(result.stdout).toContain('"uncaught":[]')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
  12_000,
)

test("DSH desktop proxy preserves WebSocket permessage-deflate negotiation and compressed stream frames", async () => {
  const directory = mkdtempSync(join(spaceTemp(), "dsh-proxy-deflate-"))
  try {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "dsh-proxy.ts")],
      target: "node",
      format: "esm",
    })
    expect(build.success).toBe(true)
    const modulePath = join(directory, "proxy.mjs")
    await Bun.write(modulePath, await build.outputs[0]!.text())
    const fixture = resolve(import.meta.dir, "../../test/fixtures/dsh-proxy-deflate.mjs")
    const result = spawnSync("node", [fixture, modulePath], { encoding: "utf8", timeout: 8000 })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"negotiated":true')
    expect(result.stdout).toContain('"forwarded":true')
    expect(result.stdout).toContain('"received":true')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 12_000)
