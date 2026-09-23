// packages/ellamaka-release/src/npm/content.ts
//
// Canonical content digest for npm tarballs — the single implementation of
// "do these two tarballs carry the same package?".
//
// npm versions are immutable, so the publish flow skips a version that already
// exists. A skip is only safe when the registry really holds what this source
// tree builds: a release that published `2.0.5` and then failed before its R2
// commit is re-run from a *fixed* source, and blindly skipping would leave the
// registry on the old contents forever. `verify.ts` compares against this
// digest and fails closed when the two disagree.
//
// The digest is over file *content*, never over container bytes: the tarball's
// per-file mtimes, entry order, directory entries and gzip level differ
// between two runs that ship the exact same package. Both sides of a
// comparison use this module, so the canonical form cannot drift.

import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"

export interface ContentEntry {
  /** File path inside the package (archive root stripped). */
  path: string
  content: Uint8Array
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * Digest of a package's files, independent of how the tarball was written.
 *
 * Entries are sorted by path, so packing order and directory entries cannot
 * change the result, and each file contributes its own path and content hash,
 * so a rename, an added file or an edited file all change the digest.
 */
export function contentDigest(entries: ContentEntry[]): string {
  if (entries.length === 0) throw new Error("cannot digest content: the package has no files")
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const lines: string[] = []
  for (const entry of sorted) {
    lines.push(`${sha256Hex(entry.content)}  ${JSON.stringify(entry.path)}`)
  }
  // One line per file, sorted by path; the trailing newline makes the last
  // entry indistinguishable from a truncated one.
  return sha256Hex(`${lines.join("\n")}\n`)
}

const BLOCK = 512

/** Regular file entry. Old tar writes NUL here, GNU tar writes '0'. */
function isFileType(typeflag: string): boolean {
  return typeflag === "0" || typeflag === "\0"
}

function readField(header: Uint8Array, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && header[end] !== 0) end++
  return new TextDecoder().decode(header.subarray(offset, end))
}

function readSize(header: Uint8Array): number {
  const raw = readField(header, 124, 12).trim()
  if (raw === "") return 0
  const size = Number.parseInt(raw, 8)
  if (!Number.isFinite(size)) throw new Error(`cannot unpack the tarball: malformed size field "${raw}"`)
  return size
}

/**
 * The archive root npm packs at: `@wopal/ellamaka-sdk` ships as
 * `package/dist/index.js`, never as `@wopal/ellamaka-sdk/dist/index.js`.
 *
 * That folder is packaging metadata, not package content, so the digest strips
 * it and compares the paths below it. Only this exact name is stripped: a
 * tarball rooted differently is left as-is, so an unexpected layout shows up as
 * a mismatch (fail-closed) instead of being silently canonicalized away.
 */
const PACKAGE_ROOT = "package/"

function stripPackageRoot(paths: string[]): string[] {
  return paths.map((path) => (path.startsWith(PACKAGE_ROOT) ? path.slice(PACKAGE_ROOT.length) : path))
}

/**
 * Read a tarball into its canonical file entries.
 *
 * Fail-closed on archive shapes this reader cannot canonicalize faithfully
 * (hard/symbolic links, GNU long names, pax extended headers): returning a
 * digest that silently ignored such an entry could call two different packages
 * identical.
 */
export function readTarballEntries(tarball: Uint8Array): ContentEntry[] {
  let bytes: Uint8Array
  try {
    bytes = gunzipSync(tarball)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`cannot unpack the tarball: not a gzip stream (${detail})`, { cause: err })
  }

  const files: Array<{ path: string; content: Uint8Array }> = []
  let offset = 0
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK)
    // Two zero blocks (or the first one) end the archive.
    if (header.every((byte) => byte === 0)) break

    const name = readField(header, 0, 100)
    const prefix = readField(header, 345, 155)
    const typeflag = String.fromCharCode(header[156] ?? 0) || "0"
    const size = readSize(header)
    const path = prefix ? `${prefix}/${name}` : name

    if (typeflag === "5") {
      // A directory entry carries no content.
    } else if (isFileType(typeflag)) {
      const start = offset + BLOCK
      const content = bytes.subarray(start, start + size)
      if (content.length !== size) throw new Error(`cannot unpack the tarball: "${path}" is truncated`)
      files.push({ path, content })
    } else {
      throw new Error(
        `cannot unpack the tarball: entry "${path}" has unsupported typeflag "${typeflag}" ` +
          `(only regular files and directories are canonicalized)`,
      )
    }

    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }

  if (files.length === 0) throw new Error("cannot digest content: the tarball holds no files")
  const stripped = stripPackageRoot(files.map((entry) => entry.path))
  return files.map((entry, index) => {
    const path = stripped[index]
    if (path === undefined || path === "" || path.endsWith("/")) {
      throw new Error(`cannot unpack the tarball: entry "${entry.path}" has no path below the archive root`)
    }
    return { path, content: entry.content }
  })
}

/** Canonical content digest of a gzipped tarball. */
export function tarballContentDigest(tarball: Uint8Array): string {
  return contentDigest(readTarballEntries(tarball))
}
