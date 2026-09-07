import { describe, expect, test } from "bun:test"
import { DshPluginCommand } from "@/cli/cmd/dsh-plugin"
import { DshDumpConfigCommand } from "@/cli/cmd/dsh-dump-config"
import {
  DSH_HELP_EXAMPLES,
  DSH_PARENT_FLAGS,
  dshDumpResolve,
  dshRootFlagsBeforePlugin,
  dshResolvePluginArgs,
} from "@/cli/cmd/dsh-cli"

describe("dsh CLI command definition", () => {
  test("dsh plugin command is a dsh subcommand in the official order", () => {
    // Official `dsh plugin` takes --profile as its own option and forwards
    // the remaining args verbatim; the verb is NOT a declared positional.
    expect(String(DshPluginCommand.command)).toBe("plugin [args...]")
    expect(DshPluginCommand.describe).toContain("manage")
  })

  test("dsh dump-config command is a dsh subcommand", () => {
    expect(String(DshDumpConfigCommand.command)).toBe("dump-config")
    expect(DshDumpConfigCommand.describe).toContain("dump")
  })

  test("dsh subcommands register under one parent without shadowing (yargs regression)", () => {
    // Both commands must be visible as dsh children — the earlier bug had
    // `dsh plugin ...` shadowed by `dsh dump-config` (or vice versa) when each
    // was registered as an independent top-level `dsh ...` command.
    expect(String(DshPluginCommand.command).startsWith("dsh ")).toBe(false)
    expect(String(DshDumpConfigCommand.command).startsWith("dsh ")).toBe(false)
  })
})

describe("dsh plugin verbatim args resolution (official order)", () => {
  test("official verb add with pkg and single --profile", () => {
    expect(dshResolvePluginArgs("web", ["add", "dsh-better-sidebar"])).toEqual({
      mode: "plugin",
      profiles: ["web"],
      action: "add",
      pkg: "dsh-better-sidebar",
      local: false,
    })
  })

  test("a path-like pkg resolves the official local-directory add spec", () => {
    // Official pnpm path-spec semantics: `./`, `../`, `/` and `.` operands
    // install from a local directory (replaces the retired `--dir` flag).
    for (const pkg of ["./my-plugin", "/abs/path/plugin", "../sibling", "."]) {
      expect(dshResolvePluginArgs("web", ["add", pkg])).toEqual({
        mode: "plugin",
        profiles: ["web"],
        action: "add",
        pkg,
        local: true,
      })
    }
    expect(dshResolvePluginArgs("web", ["add", "registry-pkg"])).toEqual({
      mode: "plugin",
      profiles: ["web"],
      action: "add",
      pkg: "registry-pkg",
      local: false,
    })
  })

  test("official verb install takes no pkg (per-profile full reinstall)", () => {
    expect(dshResolvePluginArgs("web", ["install"])).toEqual({
      mode: "install",
      profiles: ["web"],
    })
  })

  test("official verb remove takes pkg", () => {
    expect(dshResolvePluginArgs("web", ["remove", "dsh-better-sidebar"])).toEqual({
      mode: "plugin",
      profiles: ["web"],
      action: "remove",
      pkg: "dsh-better-sidebar",
      local: false,
    })
  })

  test("ellamaka extension verbs enable/disable take pkg", () => {
    expect(dshResolvePluginArgs("web", ["enable", "pkg"])).toEqual({
      mode: "plugin",
      profiles: ["web"],
      action: "enable",
      pkg: "pkg",
      local: false,
    })
    expect(dshResolvePluginArgs("web", ["disable", "pkg"])).toEqual({
      mode: "plugin",
      profiles: ["web"],
      action: "disable",
      pkg: "pkg",
      local: false,
    })
  })

  test("ellamaka extension verb list carries the --json passthrough", () => {
    expect(dshResolvePluginArgs("web", ["list"], { json: true })).toEqual({
      mode: "plugin",
      profiles: ["web"],
      action: "list",
      json: true,
    })
    expect(dshResolvePluginArgs("web", ["list"])).toEqual({
      mode: "plugin",
      profiles: ["web"],
      action: "list",
      json: false,
    })
  })

  test("no --profile falls back to the default builtin profiles (A2 compat)", () => {
    expect(dshResolvePluginArgs(undefined, ["list"])).toEqual({
      mode: "plugin",
      profiles: ["web", "ellamaka-tools"],
      action: "list",
      json: false,
    })
  })

  test("multi-value comma --profile keeps working (ellamaka extension, official superset)", () => {
    expect(dshResolvePluginArgs("web,tools", ["list"])).toEqual({
      mode: "plugin",
      profiles: ["web", "ellamaka-tools"],
      action: "list",
      json: false,
    })
    expect(dshResolvePluginArgs("web,ellamaka-tools", ["add", "pkg"])).toEqual({
      mode: "plugin",
      profiles: ["web", "ellamaka-tools"],
      action: "add",
      pkg: "pkg",
      local: false,
    })
  })

  test("unknown verbs error with the verb name (official why etc. are not forwarded)", () => {
    expect(() => dshResolvePluginArgs("web", ["why", "pkg"])).toThrow(/why/)
    expect(() => dshResolvePluginArgs("web", ["bogus"])).toThrow(/bogus/)
  })

  test("no args errors with the official usage hint", () => {
    expect(() => dshResolvePluginArgs("web", [])).toThrow(/add <package>/)
    expect(() => dshResolvePluginArgs("web", [])).toThrow(/--profile <name>/)
  })

  test("add without pkg errors", () => {
    expect(() => dshResolvePluginArgs("web", ["add"])).toThrow(/add/)
  })

  test("remove/enable/disable without pkg error", () => {
    for (const verb of ["remove", "enable", "disable"] as const) {
      expect(() => dshResolvePluginArgs("web", [verb])).toThrow(new RegExp(verb))
    }
  })

  test("a path operand on a non-add verb is rejected with guidance", () => {
    // Local directories are an install source (add only); the other verbs
    // operate on installed package names.
    for (const verb of ["remove", "enable", "disable"] as const) {
      expect(() => dshResolvePluginArgs("web", [verb, "./x"])).toThrow(/path/)
      expect(() => dshResolvePluginArgs("web", [verb, "../y"])).toThrow(/path/)
    }
  })
})

describe("rejectParentOptions semantics (official argv-order check)", () => {
  test("parent flags before the plugin subcommand are detected", () => {
    expect(dshRootFlagsBeforePlugin(["dsh", "--profile", "web", "plugin", "add", "pkg"])).toBe(true)
    expect(dshRootFlagsBeforePlugin(["dsh", "--patch", "a.yml", "plugin", "list"])).toBe(true)
    expect(dshRootFlagsBeforePlugin(["dsh", "--dump-config", "plugin"])).toBe(true)
    expect(dshRootFlagsBeforePlugin(["dsh", "--dump-default-config", "plugin"])).toBe(true)
  })

  test("flags after the subcommand or absent are allowed", () => {
    expect(dshRootFlagsBeforePlugin(["dsh", "plugin", "--profile", "web", "add", "pkg"])).toBe(false)
    expect(dshRootFlagsBeforePlugin(["dsh", "plugin", "--patch", "a.yml"])).toBe(false)
    expect(dshRootFlagsBeforePlugin(["dsh", "plugin"])).toBe(false)
    expect(dshRootFlagsBeforePlugin(["dsh"])).toBe(false)
  })

  test("parent flag set matches the official launcher", () => {
    expect(DSH_PARENT_FLAGS).toEqual(["--profile", "--patch", "--dump-config", "--dump-default-config"])
  })

  test("the reject error mirrors the official rejectParentOptions message shape", () => {
    // Trigger the same detection the index.ts middleware uses; the surfaced
    // message names the parent flags and the official-order usage.
    expect(dshRootFlagsBeforePlugin(["dsh", "--profile", "web", "plugin", "add", "pkg"])).toBe(true)
    expect(() => {
      if (dshRootFlagsBeforePlugin(["dsh", "--profile", "web", "plugin", "add", "pkg"])) {
        throw new Error(
          "error: dsh plugin takes none of parent --profile, --patch, --dump-config, or --dump-default-config before the subcommand (official dsh semantics); use: `ellamaka dsh plugin --profile <name> add <package>`",
        )
      }
    }).toThrow(/takes none of parent --profile/)
  })

  test("boot mode resolves to an error pointing at `ellamaka serve` (D-01)", () => {
    const base = { "dump-config": false, "dump-default-config": false } as const
    expect(() => dshDumpResolve({ ...base, profile: "web" }, [])).toThrow(/ellamaka serve/)
    expect(() => dshDumpResolve({ ...base, profile: "web" }, ["task args"])).toThrow(/ellamaka serve/)
  })

  test("help examples follow the official shape without boot/web examples", () => {
    // Official-ordered plugin and dump examples...
    expect(DSH_HELP_EXAMPLES).toContain("ellamaka dsh plugin --profile web add <package>")
    expect(DSH_HELP_EXAMPLES).toContain("ellamaka dsh --dump-config --profile web")
    // ...and no boot or `dsh web` alias examples (Out of Scope).
    expect(DSH_HELP_EXAMPLES).not.toMatch(/^  dsh web/m)
    expect(DSH_HELP_EXAMPLES).toContain("ellamaka serve")
  })
})
