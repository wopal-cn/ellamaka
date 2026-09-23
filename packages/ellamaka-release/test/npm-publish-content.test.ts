import { describe, expect, test } from "bun:test"
import { contentDigest, sha256Hex, tarballContentDigest } from "../src/npm/content"
import { file, tarball } from "./tarball-helpers"

const A = file("package/a.js", "export const a = 1\n")
const B = file("package/dist/b.js", "export const b = 2\n")

describe("canonical content digest", () => {
  test("hashes each file by path, so entry order does not matter", () => {
    expect(tarballContentDigest(tarball([A, B]))).toBe(tarballContentDigest(tarball([B, A])))
  })

  test("ignores every timestamp in the container", () => {
    const old = tarball([
      { ...A, mtime: 0 },
      { ...B, mtime: 0 },
    ])
    const recent = tarball([
      { ...A, mtime: 1_700_000_000 },
      { ...B, mtime: 1_800_000_000 },
    ])
    expect(tarballContentDigest(old)).toBe(tarballContentDigest(recent))
  })

  test("ignores directory entries", () => {
    const filesOnly = tarball([A, B])
    const withDirectories = tarball([
      { path: "package/", content: "", type: "5" },
      A,
      { path: "package/dist/", content: "", type: "5" },
      B,
    ])
    expect(tarballContentDigest(filesOnly)).toBe(tarballContentDigest(withDirectories))
  })

  test("ignores only the npm `package/` archive root", () => {
    // `npm pack` and `bun pm pack` both root their archive at `package/`; that
    // folder name is packaging metadata rather than package content.
    expect(tarballContentDigest(tarball([A, B]))).toBe(
      tarballContentDigest(tarball([file("a.js", A.content), file("dist/b.js", B.content)])),
    )
  })

  test("keeps every directory below the archive root", () => {
    // A package that nests all of its files under one directory must not have
    // that directory canonicalized away.
    const nested = tarball([file("package/dist/a.js", A.content), file("package/dist/b.js", B.content)])
    const flat = tarball([file("package/a.js", A.content), file("package/b.js", B.content)])
    expect(tarballContentDigest(nested)).not.toBe(tarballContentDigest(flat))
  })

  test("keeps an unexpected archive root, so a foreign layout mismatches", () => {
    // Only `package/` is recognized. A tarball rooted some other way is
    // compared literally rather than gracefully normalized — an unexpected
    // layout must surface as a mismatch, not pass as "the same".
    const npmRooted = tarball([file("package/a.js", A.content)])
    const otherRooted = tarball([file("elsewhere/a.js", A.content)])
    expect(tarballContentDigest(npmRooted)).not.toBe(tarballContentDigest(otherRooted))
  })

  test("ignores the gzip compression level", () => {
    expect(tarballContentDigest(tarball([A, B], 1))).toBe(tarballContentDigest(tarball([A, B], 9)))
  })

  test("changes when a file's content changes", () => {
    expect(tarballContentDigest(tarball([A, B]))).not.toBe(
      tarballContentDigest(tarball([file("package/a.js", "export const a = 2\n"), B])),
    )
  })

  test("changes when a file is renamed", () => {
    expect(tarballContentDigest(tarball([A, B]))).not.toBe(
      tarballContentDigest(tarball([A, file("package/dist/c.js", B.content)])),
    )
  })

  test("changes when a file is dropped", () => {
    expect(tarballContentDigest(tarball([A, B]))).not.toBe(tarballContentDigest(tarball([A])))
  })

  test("pins the canonical form so both sides of a comparison cannot drift", () => {
    // A golden value: it changes only when the canonical form changes, which is
    // a deliberate contract edit — never a refactor.
    expect(tarballContentDigest(tarball([A, B]))).toBe(
      "9cb4f3184082abe2e53b1c2c8c588e60e56f7c9264fdd653ce1cc0fb825fccd6",
    )
  })

  test("rejects an archive that carries no files", () => {
    expect(() => tarballContentDigest(tarball([{ path: "package/", content: "", type: "5" }]))).toThrow(/no files/)
  })

  test("rejects bytes that are not a tarball", () => {
    expect(() => tarballContentDigest(new TextEncoder().encode("not a tarball"))).toThrow(/not a gzip stream/)
  })

  test("rejects an entry type it cannot canonicalize, instead of ignoring it", () => {
    // A digest that skipped a link entry could call two different packages
    // identical.
    const withLink = tarball([A, { path: "package/link.js", content: "a.js", type: "2" }])
    expect(() => tarballContentDigest(withLink)).toThrow(/typeflag "2"/)
  })
})

describe("contentDigest", () => {
  test("is the same entry point the tarball reader uses", () => {
    const entries = [
      { path: "a.js", content: new TextEncoder().encode(A.content) },
      { path: "dist/b.js", content: new TextEncoder().encode(B.content) },
    ]
    expect(contentDigest(entries)).toBe(tarballContentDigest(tarball([A, B])))
  })

  test("rejects an empty file set rather than hashing nothing", () => {
    expect(() => contentDigest([])).toThrow(/no files/)
  })

  test("sha256Hex matches node's digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})
