import { describe, expect, test } from "bun:test"
import { directoryLabel, type LoaderLocation } from "./panel-loader"

const location = (over: Partial<LoaderLocation> = {}): LoaderLocation => ({
  key: "k",
  kind: "space-root",
  name: "我的空间",
  path: "/spaces/my-space",
  relativeDirectory: "",
  ...over,
})

describe("directoryLabel", () => {
  test("labels space-root by directory basename, not the display name", () => {
    expect(directoryLabel(location())).toBe("my-space")
  })

  test("labels nested locations by their relative directory", () => {
    expect(directoryLabel(location({ kind: "project", relativeDirectory: "projects/ellamaka" }))).toBe(
      "projects/ellamaka",
    )
  })

  test("falls back to the full path when the path has no parent", () => {
    expect(directoryLabel(location({ path: "/", relativeDirectory: "" }))).toBe("/")
  })
})
