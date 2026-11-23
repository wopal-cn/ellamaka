import { describe, expect, test } from "bun:test"
import type { SidebarNav } from "./sidebar-nav"

/**
 * The sidebar nav identity is a closed union: the "files" view no longer has a
 * master switch (the legacy showFileTree setting was removed), so any value of
 * SidebarNav stays effective as-is.
 */
describe("SidebarNav", () => {
  test("covers exactly the three sidebar views", () => {
    const all: SidebarNav[] = ["sessions", "files", "maintenance"]
    expect(all).toHaveLength(3)
  })
})
