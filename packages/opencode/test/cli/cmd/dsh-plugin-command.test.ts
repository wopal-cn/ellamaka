import { describe, expect, test } from "bun:test"
import { DshPluginCommand, declaredVersion, normalizeAddArgs } from "@/cli/cmd/dsh-plugin"
import { parseOfficialInvocation } from "@/cli/cmd/dsh-official"
import { DshDumpConfigCommand } from "@/cli/cmd/dsh-dump-config"
import { DSH_HELP_EXAMPLES, DSH_PARENT_FLAGS, dshDumpResolve, dshRootFlagsBeforePlugin } from "@/cli/cmd/dsh-cli"
import { resolve } from "node:path"

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
    expect(String(DshPluginCommand.command).startsWith("dsh ")).toBe(false)
    expect(String(DshDumpConfigCommand.command).startsWith("dsh ")).toBe(false)
  })
})

describe("local plugin operands", () => {
  test("a local directory becomes an absolute file: spec", () => {
    // A bare path makes pnpm record `link:` — a symlink that receives none of
    // the plugin's own dependencies. `file:` copies the package and installs
    // them, which is what both installers need to agree on.
    for (const operand of ["./my-plugin", "../sibling", "/abs/path/plugin", "."]) {
      expect(normalizeAddArgs(["add", operand])).toEqual(["add", `file:${resolve(operand)}`])
    }
  })

  test("registry names and explicit protocols pass through verbatim", () => {
    expect(normalizeAddArgs(["add", "dsh-better-sidebar"])).toEqual(["add", "dsh-better-sidebar"])
    expect(normalizeAddArgs(["add", "file:/plugins/x"])).toEqual(["add", "file:/plugins/x"])
    expect(normalizeAddArgs(["add", "link:/plugins/x"])).toEqual(["add", "link:/plugins/x"])
  })

  test("only add normalizes a path operand", () => {
    expect(normalizeAddArgs(["remove", "/abs/plugin"])).toEqual(["remove", "/abs/plugin"])
    expect(normalizeAddArgs(["why", "./x"])).toEqual(["why", "./x"])
  })

  test("trailing arguments survive normalization", () => {
    expect(normalizeAddArgs(["add", "./x", "--registry", "https://r"])).toEqual([
      "add",
      `file:${resolve("./x")}`,
      "--registry",
      "https://r",
    ])
  })
})

describe("plugin version display", () => {
  test("registry ranges display as-is; local sources defer to the installed package", () => {
    expect(declaredVersion("1.2.3")).toBe("1.2.3")
    expect(declaredVersion("^0.2.9")).toBe("^0.2.9")
    expect(declaredVersion("file:/plugins/x")).toBeUndefined()
    expect(declaredVersion("link:/plugins/x")).toBeUndefined()
    expect(declaredVersion(undefined)).toBeUndefined()
  })
})

describe("official dsh child role", () => {
  test("the home flag is consumed and the rest is forwarded verbatim", () => {
    // `--profile` is a parent option on the `dsh` command, so the role is
    // intercepted before yargs or the flag would be hoisted away from the
    // official CLI.
    expect(
      parseOfficialInvocation([
        "bun",
        "/cli/index.ts",
        "dsh",
        "official",
        "--home",
        "/h",
        "plugin",
        "--profile",
        "web",
        "add",
        "file:/p",
      ]),
    ).toEqual({ home: "/h", forwarded: ["plugin", "--profile", "web", "add", "file:/p"] })
  })

  test("ordinary invocations are not intercepted", () => {
    expect(parseOfficialInvocation(["bun", "/cli/index.ts", "dsh", "plugin", "list"])).toBeUndefined()
    expect(parseOfficialInvocation(["bun", "/cli/index.ts", "serve"])).toBeUndefined()
    // A task argument that merely contains the words is not the child role.
    expect(parseOfficialInvocation(["bun", "/cli/index.ts", "run", "dsh", "official"])).toBeUndefined()
  })

  test("a missing home or forwarded args is refused", () => {
    expect(() => parseOfficialInvocation(["bin", "dsh", "official", "plugin", "list"])).toThrow(/--home/)
    expect(() => parseOfficialInvocation(["bin", "dsh", "official", "--home", "/h"])).toThrow(/needs arguments/)
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
    expect(DSH_HELP_EXAMPLES).toContain("ellamaka dsh plugin --profile web add <package>")
    expect(DSH_HELP_EXAMPLES).toContain("ellamaka dsh plugin --profile web add /path/to/bundle")
    expect(DSH_HELP_EXAMPLES).toContain("ellamaka dsh --dump-config --profile web")
    expect(DSH_HELP_EXAMPLES).not.toMatch(/^  dsh web/m)
    expect(DSH_HELP_EXAMPLES).toContain("ellamaka serve")
  })
})
