import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { resolveAppId, resolveUserDataPath } from "./user-data"

describe("resolveAppId", () => {
  test("packaged builds use the channel-specific app id", () => {
    expect(resolveAppId(true, "stable")).toBe("ai.ellamaka.desktop")
    expect(resolveAppId(true, "beta")).toBe("ai.ellamaka.desktop.beta")
    expect(resolveAppId(true, "main")).toBe("ai.ellamaka.desktop.main")
  })

  test("development builds use the local channel suffix", () => {
    expect(resolveAppId(false, "local")).toBe("ai.ellamaka.desktop.local")
  })

  test("unknown channels fall back to the channel-suffixed id", () => {
    expect(resolveAppId(true, "future")).toBe("ai.ellamaka.desktop.future")
    expect(resolveAppId(false, "future")).toBe("ai.ellamaka.desktop.future")
  })
})

describe("resolveUserDataPath", () => {
  test("packaged userData always lives under the OS app-data directory", () => {
    expect(resolveUserDataPath(true, "/Users/me/Library/Application Support", "beta")).toBe(
      join("/Users/me/Library/Application Support", "ai.ellamaka.desktop.beta"),
    )
  })

  test("development userData is appId-scoped but still under app-data", () => {
    expect(resolveUserDataPath(false, "/Users/me/Library/Application Support", "local")).toBe(
      join("/Users/me/Library/Application Support", "ai.ellamaka.desktop.local"),
    )
  })

  test("packaged and development paths never collide", () => {
    const appData = "/Users/me/Library/Application Support"
    expect(resolveUserDataPath(true, appData, "beta")).not.toBe(resolveUserDataPath(false, appData, "local"))
  })

  test("is independent of WOPAL_HOME", () => {
    const appData = "/Users/me/Library/Application Support"
    const saved = process.env.WOPAL_HOME
    try {
      process.env.WOPAL_HOME = "/Users/me/.wopal"
      expect(resolveUserDataPath(true, appData, "beta")).toBe(join(appData, "ai.ellamaka.desktop.beta"))
    } finally {
      if (saved === undefined) delete process.env.WOPAL_HOME
      else process.env.WOPAL_HOME = saved
    }
  })
})
