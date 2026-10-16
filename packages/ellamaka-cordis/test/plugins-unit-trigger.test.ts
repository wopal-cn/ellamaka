import { describe, expect, test } from "bun:test"
import { restartRequiredForTools } from "../src/plugins/unit-trigger"

describe("per-unit trigger scoping (Plan Task 9 触发定域)", () => {
  test("tools profile changes map to dsh:tools only (negative for dsh:web)", () => {
    expect(restartRequiredForTools("ellamaka-tools", "package.json")).toEqual({
      units: ["dsh:tools"],
    })
  })

  test("web profile changes map to dsh:web only (negative for dsh:tools)", () => {
    expect(restartRequiredForTools("web", "package.json")).toEqual({
      units: ["dsh:web"],
    })
  })

  test("the shared dsh-base composition targets web+tools", () => {
    // A shared-base change (home-level cordis.patch.yml) invalidates BOTH
    // DSH units — it is the one declared multi-unit dependency edge.
    expect(restartRequiredForTools(undefined, "cordis.patch.yml", { sharedBase: true })).toEqual({
      units: ["dsh:web", "dsh:tools"],
    })
  })

  test("global provider/config changes do NOT touch DSH units (negative)", () => {
    expect(restartRequiredForTools(undefined, "settings.jsonc", { globalConfig: true })).toEqual({
      units: [],
    })
  })

  test("a web profile code (module) change requires a web cold rebuild, reported as restart-required for tools' sibling", () => {
    // Code changes cannot hot-replay (module graph is URL-cached); the web
    // unit cold-rebuilds. The tools unit has no code-change trigger in this
    // delivery: it reports restart-required instead of a silent no-op.
    expect(restartRequiredForTools("web", "package.json", { codeChange: true })).toEqual({
      units: ["dsh:web"],
      coldRebuild: true,
    })
  })

  test("tools code change reports restart-required (in-process unit, no silent skip)", () => {
    expect(restartRequiredForTools("ellamaka-tools", "package.json", { codeChange: true })).toEqual({
      units: [],
      restartRequired: "dsh:tools",
    })
  })
})
