import { describe, expect, test } from "bun:test"
import { ALL_TARGETS, filterTargets } from "../src/build-targets"

const names = (targets: { os: string; arch: string; avx2?: false }[]) =>
  targets.map((t) => `${t.os}-${t.arch}${t.avx2 === false ? "-baseline" : ""}`)

describe("filterTargets", () => {
  test("no filters returns the full matrix", () => {
    expect(filterTargets({})).toEqual(ALL_TARGETS)
    expect(ALL_TARGETS).toHaveLength(12)
  })

  test("regression: --platform all --arch primary builds the release matrix (v2.0.2 incident)", () => {
    const targets = filterTargets({ platformArg: "all", archArg: "primary" })
    expect(names(targets)).toEqual([
      "linux-arm64",
      "linux-x64",
      "linux-x64-baseline",
      "darwin-arm64",
      "darwin-x64",
      "darwin-x64-baseline",
      "win32-x64",
      "win32-x64-baseline",
    ])
  })

  test("--platform windows selects win32 targets (workflow input name)", () => {
    const targets = filterTargets({ platformArg: "windows" })
    expect(names(targets)).toEqual(["win32-arm64", "win32-x64", "win32-x64-baseline"])
  })

  test("--platform win is an alias for windows", () => {
    expect(filterTargets({ platformArg: "win" })).toEqual(filterTargets({ platformArg: "windows" }))
  })

  test("--platform mac --arch primary selects darwin release targets", () => {
    const targets = filterTargets({ platformArg: "mac", archArg: "primary" })
    expect(names(targets)).toEqual(["darwin-arm64", "darwin-x64", "darwin-x64-baseline"])
  })

  test("--arch x64 selects all x64 variants (incl. musl and baseline)", () => {
    const targets = filterTargets({ archArg: "x64" })
    expect(targets).toHaveLength(8)
    for (const t of targets) expect(t.arch).toBe("x64")
  })

  test("single flag builds only the current platform/arch, no baseline by default", () => {
    const targets = filterTargets({ singleFlag: true, currentPlatform: "darwin", currentArch: "arm64" })
    expect(names(targets)).toEqual(["darwin-arm64"])
  })

  test("single flag with baseline includes the baseline variant", () => {
    const targets = filterTargets({
      singleFlag: true,
      baselineFlag: true,
      currentPlatform: "darwin",
      currentArch: "x64",
    })
    expect(names(targets)).toEqual(["darwin-x64", "darwin-x64-baseline"])
  })

  test("unknown platform token fails fast instead of building nothing", () => {
    expect(() => filterTargets({ platformArg: "solaris" })).toThrow(/no build targets match/)
  })

  test("fails fast when filters combine to an empty set", () => {
    expect(() =>
      filterTargets({
        platformArg: "linux",
        archArg: "primary",
        singleFlag: true,
        currentPlatform: "freebsd",
        currentArch: "x64",
      }),
    ).toThrow(/no build targets match/)
  })
})
