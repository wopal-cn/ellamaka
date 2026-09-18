import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

describe("ellamaka-app vite.js channel resolution", () => {
  test("consumes the shared channel resolver with a local dev fallback", async () => {
    const vite = await Bun.file(join(root, "vite.js")).text()
    expect(vite).toContain('import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"')
    expect(vite).toContain('resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, "local")')
    expect(vite).not.toContain("process.env.OPENCODE_CHANNEL")
  })

  test("has no residual legacy channel literals", async () => {
    const vite = await Bun.file(join(root, "vite.js")).text()
    expect(vite).not.toContain('"dev"')
    expect(vite).not.toContain('"prod"')
  })
})

describe("ellamaka-app ELLAMAKA_CHANNEL type domain", () => {
  test("env.d.ts declares the closed build channel vocabulary", async () => {
    const env = await Bun.file(join(root, "src/env.d.ts")).text()
    expect(env).toContain('readonly ELLAMAKA_CHANNEL?: "stable" | "beta" | "main" | "local"')
    expect(env).not.toMatch(/"dev"/)
    expect(env).not.toMatch(/"prod"/)
  })
})

describe("ellamaka-app server env is ELLAMAKA-branded", () => {
  // The product layer owns these names end to end (nothing outside this repo
  // sets them, and the engine never reads them), so the OPENCODE_* spelling is
  // pure upstream residue. Assert every producer and consumer agrees, so a
  // half-rename cannot reintroduce a silently-ignored env var.
  const PRODUCERS = ["scripts/dev.sh", "packages/ellamaka-app/playwright.config.ts", "packages/ellamaka-app/script/e2e-local.ts"]

  test("no VITE_OPENCODE_* producer or consumer survives", async () => {
    for (const relative of [...PRODUCERS, "packages/ellamaka-app/src/entry.tsx", "packages/ellamaka-app/src/env.d.ts"]) {
      const file = relative.startsWith("packages/ellamaka-app")
        ? join(root, relative.replace("packages/ellamaka-app/", ""))
        : join(root, "..", "..", relative)
      const text = await Bun.file(file).text()
      expect(text, relative).not.toContain("VITE_OPENCODE_")
    }
  })

  test("env.d.ts and entry.tsx agree on the branded names", async () => {
    const env = await Bun.file(join(root, "src/env.d.ts")).text()
    const entry = await Bun.file(join(root, "src/entry.tsx")).text()
    expect(env).toContain("VITE_ELLAMAKA_SERVER_HOST")
    expect(env).toContain("VITE_ELLAMAKA_SERVER_PORT")
    expect(entry).toContain("import.meta.env.VITE_ELLAMAKA_SERVER_HOST")
    expect(entry).toContain("import.meta.env.VITE_ELLAMAKA_SERVER_PORT")
  })

  test("desktop sidecar port env is branded and legacy OPENCODE_PORT is gone", async () => {
    const desktopMain = await Bun.file(join(root, "..", "ellamaka-desktop", "src", "main", "index.ts")).text()
    const desktopVite = await Bun.file(join(root, "..", "ellamaka-desktop", "electron.vite.config.ts")).text()
    const dev = await Bun.file(join(root, "..", "..", "scripts", "dev.sh")).text()
    expect(desktopMain).toContain("process.env.ELLAMAKA_PORT")
    expect(desktopVite).toContain("process.env.ELLAMAKA_PORT")
    expect(dev).toContain("ELLAMAKA_PORT=")
    expect(desktopMain).not.toContain("OPENCODE_PORT")
    expect(desktopVite).not.toContain("OPENCODE_PORT")
    expect(dev).not.toContain("OPENCODE_PORT")
  })
})
