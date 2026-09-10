import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { resolveServerConfig } from "@/cli/network-config"
import { tmpdir } from "../fixture/fixture"

const layer = AppFileSystem.defaultLayer

/** Run `fn` with WOPAL_SPACE forced on, restoring the prior value after. */
async function withWopalSpace<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.WOPAL_SPACE
  process.env.WOPAL_SPACE = "1"
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.WOPAL_SPACE
    else process.env.WOPAL_SPACE = previous
  }
}

/** Turn a bare directory into a space root and write the requested layers. */
async function writeSpace(root: string, layers: { public?: object; local?: object; raw?: string }) {
  await fs.mkdir(path.join(root, ".wopal", "config"), { recursive: true })
  await fs.writeFile(path.join(root, ".wopal", ".git"), "")
  if (layers.public) {
    await fs.writeFile(
      path.join(root, ".wopal", "config", "settings.jsonc"),
      JSON.stringify({ ellamaka: { server: layers.public } }),
    )
  }
  if (layers.raw !== undefined) {
    await fs.writeFile(path.join(root, ".wopal", "config", "settings.local.jsonc"), layers.raw)
  } else if (layers.local) {
    await fs.writeFile(
      path.join(root, ".wopal", "config", "settings.local.jsonc"),
      JSON.stringify({ ellamaka: { server: layers.local } }),
    )
  }
}

function resolve(root: string, globalServer: Record<string, unknown>) {
  return Effect.runPromise(resolveServerConfig(root, globalServer as never).pipe(Effect.provide(layer)))
}

describe("cli server config resolution", () => {
  test("space server block overlays the global one", async () => {
    await withWopalSpace(async () => {
      await using tmp = await tmpdir()
      await writeSpace(tmp.path, { public: { cors: ["http://192.168.1.101:9999"], port: 9999 } })
      const server = await resolve(tmp.path, { cors: ["http://global.example:1234"], hostname: "127.0.0.1" })
      // Arrays replace across tiers (remeda mergeDeep), the same semantics the
      // instance-level config merge applies; scalars overlay field by field.
      expect(server?.cors).toEqual(["http://192.168.1.101:9999"])
      expect(server?.port).toBe(9999)
      expect(server?.hostname).toBe("127.0.0.1")
    })
  })

  test("space private layer overlays the public one", async () => {
    await withWopalSpace(async () => {
      await using tmp = await tmpdir()
      await writeSpace(tmp.path, {
        public: { cors: ["http://public.example:1"], hostname: "127.0.0.1" },
        local: { hostname: "0.0.0.0" },
      })
      const server = await resolve(tmp.path, {})
      expect(server?.hostname).toBe("0.0.0.0")
      expect(server?.cors).toEqual(["http://public.example:1"])
    })
  })

  test("global server fields survive when the space declares none", async () => {
    await withWopalSpace(async () => {
      await using tmp = await tmpdir()
      await writeSpace(tmp.path, {})
      const server = await resolve(tmp.path, { port: 4096, cors: ["http://global.example:1"] })
      expect(server?.port).toBe(4096)
      expect(server?.cors).toEqual(["http://global.example:1"])
    })
  })

  test("skips a malformed settings file instead of failing", async () => {
    await withWopalSpace(async () => {
      await using tmp = await tmpdir()
      await writeSpace(tmp.path, { public: { cors: ["http://valid.example:1"] }, raw: "{ not json" })
      const server = await resolve(tmp.path, { cors: ["http://global.example:1"] })
      expect(server?.cors).toEqual(["http://valid.example:1"])
    })
  })

  test("ignores space settings outside a space root", async () => {
    await withWopalSpace(async () => {
      await using tmp = await tmpdir()
      const server = await resolve(tmp.path, { cors: ["http://global.example:1"] })
      expect(server?.cors).toEqual(["http://global.example:1"])
    })
  })

  test("space detection is by directory marker, not the WOPAL_SPACE env", async () => {
    const previous = process.env.WOPAL_SPACE
    delete process.env.WOPAL_SPACE
    try {
      await using tmp = await tmpdir()
      await writeSpace(tmp.path, { public: { cors: ["http://space.example:1"] } })
      const server = await resolve(tmp.path, { cors: ["http://global.example:1"] })
      expect(server?.cors).toEqual(["http://space.example:1"])
    } finally {
      if (previous === undefined) delete process.env.WOPAL_SPACE
      else process.env.WOPAL_SPACE = previous
    }
  })
})
