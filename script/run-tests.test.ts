import { describe, expect, test } from "bun:test"
import { planLayer } from "./run-tests"

describe("planLayer layer x package mapping", () => {
  test("unit + opencode maps to test:unit in opencode dir", () => {
    expect(planLayer("unit", "opencode")).toEqual([{ pkg: "opencode", command: ["bun", "run", "test:unit"] }])
  })

  test("integration + opencode maps to test:integration", () => {
    expect(planLayer("integration", "opencode")).toEqual([
      { pkg: "opencode", command: ["bun", "run", "test:integration"] },
    ])
  })

  test("e2e + opencode maps to test:e2e", () => {
    expect(planLayer("e2e", "opencode")).toEqual([{ pkg: "opencode", command: ["bun", "run", "test:e2e"] }])
  })

  test("unit + ellamaka-app maps to test:unit", () => {
    expect(planLayer("unit", "ellamaka-app")).toEqual([
      { pkg: "ellamaka-app", command: ["bun", "run", "test:unit"] },
    ])
  })

  test("e2e + ellamaka-app maps to test:e2e", () => {
    expect(planLayer("e2e", "ellamaka-app")).toEqual([
      { pkg: "ellamaka-app", command: ["bun", "run", "test:e2e"] },
    ])
  })

  test("unit + ellamaka-desktop maps to test", () => {
    expect(planLayer("unit", "ellamaka-desktop")).toEqual([
      { pkg: "ellamaka-desktop", command: ["bun", "run", "test"] },
    ])
  })

  test("e2e + ellamaka-desktop maps to test:e2e", () => {
    expect(planLayer("e2e", "ellamaka-desktop")).toEqual([
      { pkg: "ellamaka-desktop", command: ["bun", "run", "test:e2e"] },
    ])
  })

  test("unit + ellamaka-cordis maps to test:unit", () => {
    expect(planLayer("unit", "ellamaka-cordis")).toEqual([
      { pkg: "ellamaka-cordis", command: ["bun", "run", "test:unit"] },
    ])
  })

  test("integration + ellamaka-cordis maps to test:integration", () => {
    expect(planLayer("integration", "ellamaka-cordis")).toEqual([
      { pkg: "ellamaka-cordis", command: ["bun", "run", "test:integration"] },
    ])
  })

  test("e2e + ellamaka-cordis throws (no e2e layer)", () => {
    expect(() => planLayer("e2e", "ellamaka-cordis")).toThrow(/has no e2e layer/)
  })

  test("e2e + all maps each of the four packages to its own test:e2e command", () => {
    const commands = planLayer("e2e", "all")
    expect(commands).toEqual([
      { pkg: "opencode", command: ["bun", "run", "test:e2e"] },
      { pkg: "ellamaka-app", command: ["bun", "run", "test:e2e"] },
      { pkg: "ellamaka-desktop", command: ["bun", "run", "test:e2e"] },
    ])
  })

  test("unit + all includes all four packages", () => {
    const commands = planLayer("unit", "all")
    expect(commands.map((c) => c.pkg)).toEqual(["opencode", "ellamaka-app", "ellamaka-desktop", "ellamaka-cordis"])
  })

  test("integration + all filters to only packages that have an integration layer", () => {
    const commands = planLayer("integration", "all")
    expect(commands).toEqual([
      { pkg: "opencode", command: ["bun", "run", "test:integration"] },
      { pkg: "ellamaka-cordis", command: ["bun", "run", "test:integration"] },
    ])
  })

  test("integration + ellamaka-app throws (no integration layer)", () => {
    expect(() => planLayer("integration", "ellamaka-app")).toThrow(/has no integration layer/)
  })

  test("integration + ellamaka-desktop throws (no integration layer)", () => {
    expect(() => planLayer("integration", "ellamaka-desktop")).toThrow(/has no integration layer/)
  })

  test("invalid layer throws", () => {
    expect(() => planLayer("invalid" as never, "all")).toThrow(/Invalid layer/)
  })

  test("unknown package throws a distinct unknown-package error", () => {
    expect(() => planLayer("unit", "unknown" as never)).toThrow(/Unknown package/)
  })
})
