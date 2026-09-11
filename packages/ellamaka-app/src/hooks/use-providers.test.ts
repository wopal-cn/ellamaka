import { describe, expect, test } from "bun:test"
import { resolveProviderDirectory, shouldBootstrapProviderDirectory } from "./use-providers"

describe("resolveProviderDirectory", () => {
  test("keeps each panel scoped to its own SDK directory ahead of the Workbench catalog fallback", () => {
    expect(
      resolveProviderDirectory({
        sdkDirectory: () => "/workspace/panel-a",
        fallbackDirectory: () => "/workspace/active-panel-b",
        routeDirectory: () => "",
      }),
    ).toBe("/workspace/panel-a")
  })

  test("uses an injected active directory for top-level Workbench settings without inventing a default cwd", () => {
    expect(
      resolveProviderDirectory({
        catalogDirectory: () => "/workspace/active-panel",
        routeDirectory: () => "",
      }),
    ).toBe("/workspace/active-panel")

    expect(
      resolveProviderDirectory({
        routeDirectory: () => "",
      }),
    ).toBe("")
  })
})

describe("shouldBootstrapProviderDirectory", () => {
  test("keeps an empty Panel cache-only even when it has an SDK directory", () => {
    expect(shouldBootstrapProviderDirectory({ directory: "/workspace/empty-panel", sdkRuntime: false })).toBe(false)
  })

  test("allows an explicitly runtime Panel or a top-level active catalog to load providers", () => {
    expect(shouldBootstrapProviderDirectory({ directory: "/workspace/bound-panel", sdkRuntime: true })).toBe(true)
    expect(shouldBootstrapProviderDirectory({ directory: "/workspace/active-settings" })).toBe(true)
  })
})
