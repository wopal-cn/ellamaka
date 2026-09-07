import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NoVersionError, resolveTree, satisfiesRange, UnsupportedSpecError, type FetchLike } from "../src/plugins/resolver"

/** Load a recorded packument fixture (real registry data, trimmed fields). */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "packuments", `${name}.json`), "utf-8"))
}

/** A fetch injected with the real recorded packuments (fully offline). */
function offlineFetch(): FetchLike {
  const docs = new Map<string, unknown>([
    ["is-odd", fixture("is-odd")],
    ["is-number", fixture("is-number")],
    ["chalk", fixture("chalk")],
    ["@sindresorhus/is", fixture("sindresorhus-is")],
  ])
  return async (url) => {
    const parsed = new URL(url)
    // Scoped names arrive percent-encoded (`@scope%2fpkg`).
    const name = decodeURIComponent(parsed.pathname.slice(1))
    const doc = docs.get(name)
    if (!doc) throw new Error(`404 for ${name} at ${url}`)
    return { ok: true, status: 200, json: async () => doc }
  }
}

describe("dsh plugin dependency resolver", () => {
  test("resolveTree('is-odd@3.0.1') yields the exact root plus its dependency, flat hoisted", async () => {
    const tree = await resolveTree({ kind: "registry", name: "is-odd", version: "3.0.1" }, { fetch: offlineFetch() })
    expect(tree.root).toEqual({ name: "is-odd", version: "3.0.1" })
    const keys = [...tree.packages.keys()].sort()
    expect(keys).toEqual(["is-number@6.0.0", "is-odd@3.0.1"])
    expect(tree.packages.get("is-odd@3.0.1")?.dependencies).toEqual(["is-number@6.0.0"])
    expect(tree.packages.get("is-number@6.0.0")?.dependencies).toEqual([])
  })

  test("resolveTree('chalk@^5') resolves to the highest 5.x", async () => {
    const tree = await resolveTree({ kind: "registry", name: "chalk", version: "^5" }, { fetch: offlineFetch() })
    expect(tree.root.version.startsWith("5.")).toBe(true)
    expect([...tree.packages.keys()]).toContain(`chalk@${tree.root.version}`)
  })

  test("resolveTree('chalk@5') resolves the exact version 5.6.2", async () => {
    const tree = await resolveTree({ kind: "registry", name: "chalk", version: "5" }, { fetch: offlineFetch() })
    expect(tree.root.version).toBe("5.6.2")
  })

  test("resolveTree('chalk@~5.3') respects the tilde minor pin", async () => {
    const tree = await resolveTree({ kind: "registry", name: "chalk", version: "~5.3" }, { fetch: offlineFetch() })
    expect(tree.root.version).toBe("5.3.0")
  })

  test("resolveTree('chalk@latest') follows the dist-tag", async () => {
    const tree = await resolveTree({ kind: "registry", name: "chalk", version: "latest" }, { fetch: offlineFetch() })
    expect(tree.root.version).toBe("6.0.0")
  })

  test("a bare name and '*' resolve to the latest STABLE version, never a prerelease", async () => {
    // npm semantics: bare name and `latest` pin dist-tags.latest; `*` picks
    // the highest stable. A newer prerelease (4.0.0-nightly) must never win.
    const bare = await resolveTree({ kind: "registry", name: "chalk" }, { fetch: offlineFetch() })
    expect(bare.root.version).toBe("6.0.0")
    const star = await resolveTree({ kind: "registry", name: "chalk", version: "*" }, { fetch: offlineFetch() })
    expect(star.root.version).toBe("6.0.0")
    // Unit level: prerelease candidates fail `latest`/`*`/empty ranges.
    const tags = { latest: "2.1.3" }
    expect(satisfiesRange("4.0.0-nightly.202508271359", "", tags)).toBe(false)
    expect(satisfiesRange("4.0.0-nightly.202508271359", "latest", tags)).toBe(false)
    expect(satisfiesRange("4.0.0-nightly.202508271359", "*", tags)).toBe(false)
    expect(satisfiesRange("2.1.3", "", tags)).toBe(true)
    expect(satisfiesRange("2.1.3", "latest", tags)).toBe(true)
    expect(satisfiesRange("2.1.3", "*", tags)).toBe(true)
  })

  test("a dist-tag pointing at a prerelease pins that exact version", async () => {
    // Explicit opt-in: `pkg@nightly` still selects the nightly dist-tag.
    expect(satisfiesRange("4.0.0-nightly.202508271359", "nightly", { latest: "2.1.3", nightly: "4.0.0-nightly.202508271359" })).toBe(true)
  })

  test("scoped names split correctly", async () => {
    const tree = await resolveTree(
      { kind: "registry", name: "@sindresorhus/is", version: "7.0.1" },
      { fetch: offlineFetch() },
    )
    expect(tree.root.name).toBe("@sindresorhus/is")
    expect(tree.root.version).toBe("7.0.1")
  })

  test("the same package required by multiple parents shares one copy (hoist)", async () => {
    // is-odd 2.0.0 -> is-number@^4.0.0; simulate a synthetic parent requiring
    // the same is-number version by resolving two specs against one fetch.
    const tree = await resolveTree({ kind: "registry", name: "is-odd", version: "3.0.1" }, { fetch: offlineFetch() })
    const isNumberCopies = [...tree.packages.keys()].filter((k) => k.startsWith("is-number@"))
    expect(isNumberCopies).toHaveLength(1)
  })

  test("caret ranges follow npm 0.x upper-bound semantics (rook B-02)", () => {
    // ^0.2.3 must stay within 0.2.x (the MINOR is the leftmost non-zero).
    expect(satisfiesRange("0.2.3", "^0.2.3")).toBe(true)
    expect(satisfiesRange("0.2.9", "^0.2.3")).toBe(true)
    expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false)
    expect(satisfiesRange("0.1.9", "^0.2.3")).toBe(false)
    // ^0.0.3: only 0.0.x from the pinned patch on — PATCH is leftmost non-zero.
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true)
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(true)
    expect(satisfiesRange("0.0.2", "^0.0.3")).toBe(false)
    expect(satisfiesRange("0.1.0", "^0.0.3")).toBe(false)
    // ^0.2 (x patch): within 0.2.x.
    expect(satisfiesRange("0.2.5", "^0.2")).toBe(true)
    expect(satisfiesRange("0.3.0", "^0.2")).toBe(false)
    // ^0 (x minor): any 0.x.
    expect(satisfiesRange("0.9.9", "^0")).toBe(true)
    expect(satisfiesRange("1.0.0", "^0")).toBe(false)
    // regular caret unchanged.
    expect(satisfiesRange("5.6.2", "^5.3.0")).toBe(true)
    expect(satisfiesRange("6.0.0", "^5.3.0")).toBe(false)
  })

  test("a range with no satisfying version throws NoVersionError naming the parent chain", async () => {
    try {
      await resolveTree({ kind: "registry", name: "is-odd", version: "99.0.0" }, { fetch: offlineFetch() })
      throw new Error("expected NoVersionError")
    } catch (error) {
      expect(error).toBeInstanceOf(NoVersionError)
      expect((error as Error).message).toContain("is-odd")
      expect((error as Error).message).toContain("99.0.0")
    }
  })

  test("git and file specs are rejected with UnsupportedSpecError", async () => {
    await expect(
      resolveTree({ kind: "registry", name: "is-odd", version: "github:foo/is-odd#main" }),
    ).rejects.toBeInstanceOf(UnsupportedSpecError)
    await expect(
      resolveTree({ kind: "registry", name: "is-odd", version: "file:../is-odd" }),
    ).rejects.toBeInstanceOf(UnsupportedSpecError)
  })

  test("fetch failures propagate with the registry URL", async () => {
    const failingFetch: FetchLike = async (url) => {
      throw new Error(`network down at ${url}`)
    }
    try {
      await resolveTree({ kind: "registry", name: "is-odd", version: "3.0.1" }, { fetch: failingFetch })
      throw new Error("expected the fetch error to propagate")
    } catch (error) {
      expect((error as Error).message).toContain("registry.npmjs.org")
      expect((error as Error).message).toContain("network down")
    }
  })
})
