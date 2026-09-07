import { describe, expect, test } from "bun:test"
import { DshDumpConfigCommand } from "@/cli/cmd/dsh-dump-config"
import { DshPluginCommand } from "@/cli/cmd/dsh-plugin"
import {
  dshDumpRequested,
  dshDumpResolve,
  type DshDumpFlags,
} from "@/cli/cmd/dsh-cli"

describe("dsh dump-config CLI command definition", () => {
  test("command configuration matches contract (compat subcommand)", () => {
    expect(DshDumpConfigCommand.command).toBe("dump-config")
    expect(DshDumpConfigCommand.describe).toContain("dump")
  })

  test("the compat subcommand keeps the ellamaka extensions", () => {
    // --patch (Plan 223 D-03) joins the official-shaped --profile and the
    // ellamaka --default-only extension. Output is rendered YAML in both
    // forms (official alignment: the --json envelope was retired).
    expect(String(DshDumpConfigCommand.command).startsWith("dsh ")).toBe(false)
    expect(String(DshPluginCommand.command).startsWith("dsh ")).toBe(false)
  })
})

describe("dsh dump invocation resolution (official bin.js resolveBoot semantics)", () => {
  const base: DshDumpFlags = {
    "dump-config": false,
    "dump-default-config": false,
  }

  test("root --dump-config resolves a full dump with --profile", () => {
    expect(dshDumpResolve({ ...base, "dump-config": true, profile: "web" }, [])).toEqual({
      mode: "dump-config",
      profile: "web",
      defaultOnly: false,
      patches: [],
    })
  })

  test("--patch overlays keep argv order", () => {
    expect(
      dshDumpResolve({ ...base, "dump-config": true, profile: "web", patch: ["a.yml", "b.yml"] }, []),
    ).toEqual({
      mode: "dump-config",
      profile: "web",
      defaultOnly: false,
      patches: ["a.yml", "b.yml"],
    })
  })

  test("--dump-default-config resolves the bundle-only dump", () => {
    expect(dshDumpResolve({ ...base, "dump-default-config": true, profile: "web" }, [])).toEqual({
      mode: "dump-config",
      profile: "web",
      defaultOnly: true,
      patches: [],
    })
  })

  test("--dump-config and --dump-default-config are mutually exclusive", () => {
    expect(() =>
      dshDumpResolve({ ...base, "dump-config": true, "dump-default-config": true, profile: "web" }, []),
    ).toThrow(/mutually exclusive/)
  })

  test("--dump-default-config rejects --patch", () => {
    expect(() =>
      dshDumpResolve({ ...base, "dump-default-config": true, profile: "web", patch: ["a.yml"] }, []),
    ).toThrow(/--patch/)
  })

  test("config dumps take no app arguments", () => {
    expect(() => dshDumpResolve({ ...base, "dump-config": true, profile: "web" }, ["extra"])).toThrow(
      /take no app arguments/,
    )
  })

  test("--profile is required on the dsh root", () => {
    expect(() => dshDumpResolve({ ...base, "dump-config": true }, [])).toThrow(/--profile <name> is required/)
    expect(() => dshDumpResolve({ ...base, "dump-config": true, profile: "" }, [])).toThrow(/needs a name/)
  })

  test("--patch needs a path (official empty-value error)", () => {
    expect(() => dshDumpResolve({ ...base, "dump-config": true, profile: "web", patch: [""] }, [])).toThrow(
      /--patch needs a path/,
    )
  })

  test("boot mode errors and points at `ellamaka serve` (D-01, official profile mode replaced)", () => {
    expect(() => dshDumpResolve({ ...base, profile: "web" }, [])).toThrow(/ellamaka serve/)
    expect(() => dshDumpResolve({ ...base, profile: "web" }, ["task", "args"])).toThrow(/ellamaka serve/)
  })

  test("no --profile without a dump flag keeps the boot error (official --profile-required shape)", () => {
    expect(() => dshDumpResolve({ ...base }, [])).toThrow(/--profile <name> is required/)
  })

  test("dshDumpRequested detects the dump flags (root priority over subcommands)", () => {
    expect(dshDumpRequested({ ...base, "dump-config": true })).toBe(true)
    expect(dshDumpRequested({ ...base, "dump-default-config": true })).toBe(true)
    expect(dshDumpRequested(base)).toBe(false)
    expect(dshDumpRequested({ ...base, patch: ["a.yml"] })).toBe(false)
  })
})
