import { describe, expect, test } from "bun:test"
import { parseArgs, parseLegacyTag, parseReleaseTag } from "../src/cleanup/parse"
import { PRODUCTS } from "../src/cleanup/products"
import type { Flags, TagParseResult } from "../src/cleanup/parse"

const cli = PRODUCTS["ellamaka-cli"]
const desktop = PRODUCTS["ellamaka-desktop"]

type ParseResult = ReturnType<typeof parseArgs>

/** Get the error object from a failed parse result. */
function err(res: ParseResult): { error: string; exitCode: number } {
  if (!("error" in res)) throw new Error(`expected error, got flags ${JSON.stringify(res)}`)
  return res as { error: string; exitCode: number }
}

/** Get the flags from a successful parse result. */
function ok(res: ParseResult): Flags {
  if ("error" in res) throw new Error(`expected ok, got error: ${res.error}`)
  return (res as { flags: Flags }).flags
}

/** Narrow a TagParseResult to the standard variant. */
function standard(r: TagParseResult) {
  if (r.kind !== "standard") throw new Error(`expected standard, got ${r.kind}`)
  return r
}

/** Narrow a TagParseResult to the legacy variant. */
function legacy(r: TagParseResult) {
  if (r.kind !== "legacy") throw new Error(`expected legacy, got ${r.kind}`)
  return r
}

describe("cleanup parse — parseReleaseTag (B-01)", () => {
  test("parses a real ellamaka-cli release tag (single v, no double-v)", () => {
    const r = parseReleaseTag(cli, "ellamaka-cli-v1.17.0")
    expect(r).not.toBeNull()
    expect(r!.version).toBe("1.17.0")
    expect(r!.kind).toBe("standard")
    expect(standard(r!).channel).toBe("stable")
  })

  test("parses a real ellamaka-desktop release tag", () => {
    const r = parseReleaseTag(desktop, "ellamaka-desktop-v1.17.0")
    expect(r).not.toBeNull()
    expect(r!.version).toBe("1.17.0")
    expect(standard(r!).channel).toBe("stable")
  })

  test("parses a real ellamaka-desktop beta release tag", () => {
    const r = parseReleaseTag(desktop, "ellamaka-desktop-v1.17.0-beta.1")
    expect(r).not.toBeNull()
    expect(r!.version).toBe("1.17.0-beta.1")
    expect(standard(r!).channel).toBe("beta")
  })

  test("returns null for a different product's tag", () => {
    expect(parseReleaseTag(cli, "ellamaka-desktop-v1.17.0")).toBeNull()
    expect(parseReleaseTag(desktop, "ellamaka-cli-v1.17.0")).toBeNull()
  })

  test("returns null for a legacy tag", () => {
    expect(parseReleaseTag(cli, "ellamaka-cli-v1.15.13-4")).toBeNull()
  })

  test("returns null for a bare generic tag", () => {
    expect(parseReleaseTag(cli, "v1.17.0")).toBeNull()
    expect(parseReleaseTag(cli, "ellamaka-v1.17.0")).toBeNull()
  })
})

describe("cleanup parse — parseLegacyTag (B-01)", () => {
  test("parses a legacy stable-iteration cli tag", () => {
    const r = parseLegacyTag(cli, "ellamaka-cli-v1.15.13-4")
    expect(r).not.toBeNull()
    expect(r!.version).toBe("1.15.13-4")
    expect(r!.kind).toBe("legacy")
  })

  test("returns null for a standard tag", () => {
    expect(parseLegacyTag(cli, "ellamaka-cli-v1.17.0")).toBeNull()
  })

  test("desktop legacy beta-iteration", () => {
    const r = parseLegacyTag(desktop, "ellamaka-desktop-v1.16.0-beta.1")
    // beta.N is a standard prerelease shape → parseLegacyVersion fails, but
    // the desktop fallback classifies it as legacy beta-iteration.
    expect(r).not.toBeNull()
    expect(legacy(r!).legacyShape).toBe("beta-iteration")
  })
})

describe("cleanup parse — parseArgs fail-closed (B-02)", () => {
  test("requires --product", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--keep-stable", "5"]))
    expect(res.error).toContain("--product")
    expect(res.exitCode).toBe(2)
  })

  test("rejects an unknown --product", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--product", "bogus"]))
    expect(res.error).toContain("unknown --product")
    expect(res.exitCode).toBe(2)
  })

  test("rejects an unknown flag (misspelled dry-run)", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--product", "ellamaka-cli", "--dryrun"]))
    expect(res.error).toContain("unknown argument '--dryrun'")
    expect(res.exitCode).toBe(2)
  })

  test("rejects a missing value for --keep-stable", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--product", "ellamaka-cli", "--keep-stable"]))
    expect(res.error).toContain("--keep-stable requires a value")
    expect(res.exitCode).toBe(2)
  })

  test("rejects a non-integer --keep-stable", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--product", "ellamaka-cli", "--keep-stable", "abc"]))
    expect(res.error).toContain("must be a non-negative integer")
    expect(res.exitCode).toBe(2)
  })

  test("rejects a negative --keep-stable", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--product", "ellamaka-cli", "--keep-stable", "-1"]))
    expect(res.error).toContain("must be a non-negative integer")
    expect(res.exitCode).toBe(2)
  })

  test("rejects a NaN-producing --keep-beta", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--product", "ellamaka-desktop", "--keep-beta", "x"]))
    expect(res.error).toContain("--keep-beta must be a non-negative integer")
    expect(res.exitCode).toBe(2)
  })

  test("parses a valid retention invocation", () => {
    const flags = ok(
      parseArgs([
        "node",
        "cleanup.ts",
        "--product",
        "ellamaka-desktop",
        "--keep-stable",
        "3",
        "--keep-beta",
        "2",
        "--dry-run",
      ]),
    )
    expect(flags.product).toBe("ellamaka-desktop")
    expect(flags.keepStable).toBe(3)
    expect(flags.keepBeta).toBe(2)
    expect(flags.dryRun).toBe(true)
    expect(flags.mode).toBe("retention")
  })

  test("rejects withdraw mode without --fallback", () => {
    const res = err(parseArgs(["node", "cleanup.ts", "--product", "ellamaka-cli", "--withdraw", "1.16.0"]))
    expect(res.error).toContain("--fallback")
    expect(res.exitCode).toBe(2)
  })

  test("parses a valid withdraw invocation", () => {
    const flags = ok(
      parseArgs(["node", "cleanup.ts", "--product", "ellamaka-cli", "--withdraw", "1.16.0", "--fallback", "1.15.0"]),
    )
    expect(flags.mode).toBe("withdraw")
    expect(flags.withdrawVersion).toBe("1.16.0")
    expect(flags.fallback).toBe("1.15.0")
  })
})
