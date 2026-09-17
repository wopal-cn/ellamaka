import { describe, expect, test } from "bun:test"
import { resolveDevSidecarChannel } from "../../scripts/dev-channel"

describe("desktop dev channel", () => {
  test("defaults sidecar builds to local while preserving explicit channels", () => {
    expect(resolveDevSidecarChannel(undefined)).toBe("local")
    expect(resolveDevSidecarChannel("main")).toBe("main")
    expect(resolveDevSidecarChannel("latest")).toBe("latest")
  })

  test("predev uses the shared channel resolver", async () => {
    const source = await Bun.file(new URL("../../scripts/predev.ts", import.meta.url)).text()
    expect(source).toContain("resolveDevSidecarChannel")
  })

  test("predev defaults the icon channel to local, never the legacy dev", async () => {
    const source = await Bun.file(new URL("../../scripts/predev.ts", import.meta.url)).text()
    // The predev icon channel must be vocabulary-resolved with a "local"
    // fallback; the legacy "dev" literal must be gone.
    expect(source).toContain('resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, "local")')
    expect(source).not.toContain('?? "dev"')
  })

  test("one-click dev launcher defaults the full build chain to local", async () => {
    const source = await Bun.file(new URL("../../../../scripts/dev.sh", import.meta.url)).text()
    expect(source).toContain('local CHANNEL="local"')
  })
})
