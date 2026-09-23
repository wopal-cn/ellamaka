// packages/ellamaka-release/test/tarball-helpers.ts
//
// Hand-rolled tar container builder for the npm content tests.
//
// `Bun.Archive` can only write an archive from an in-memory map: the header
// fields the canonical digest must *ignore* (per-file mtime), and the entries it
// must skip (directory entries), are not expressible through it. Tests therefore
// build the container themselves, which also keeps the "ignores timestamps"
// case a real per-file mtime difference instead of a mock.

import { gzipSync } from "node:zlib"

export interface TarEntry {
  path: string
  content: string
  /** Header mtime in seconds since the epoch. Defaults to 0. */
  mtime?: number
  /** ustar typeflag: "0" regular file (default), "5" directory, "x" pax header. */
  type?: string
}

const BLOCK = 512

function tarHeader(name: string, size: number, mtime: number, type: string): Uint8Array {
  const header = new Uint8Array(BLOCK)
  const write = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset)
  // ustar splits long paths: name holds the first 100 bytes, prefix the rest.
  const prefix = name.length > 100 ? name.slice(0, name.lastIndexOf("/", 100)) : ""
  write(0, prefix ? name.slice(prefix.length + 1) : name)
  write(100, "0000644\0")
  write(108, "0000000\0")
  write(116, "0000000\0")
  write(124, `${size.toString(8).padStart(11, "0")}\0`)
  write(136, `${mtime.toString(8).padStart(11, "0")}\0`)
  write(148, "        ") // the checksum is summed with this field blank
  write(156, type)
  write(257, "ustar\0")
  write(263, "00")
  if (prefix) write(345, prefix)
  let sum = 0
  for (const byte of header) sum += byte
  write(148, `${sum.toString(8).padStart(6, "0")}\0 `)
  return header
}

/** Build an uncompressed tar container. */
export function buildTar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    const content = new TextEncoder().encode(entry.content)
    const type = entry.type ?? "0"
    const size = type === "0" || type === "x" ? content.length : 0
    chunks.push(tarHeader(entry.path, size, entry.mtime ?? 0, type))
    if (size === 0) continue
    chunks.push(content)
    const padding = (BLOCK - (size % BLOCK)) % BLOCK
    if (padding > 0) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(BLOCK * 2)) // end-of-archive marker
  const archive = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.length
  }
  return archive
}

/** Build a gzipped tar container (`tar -czf` equivalent). */
export function tarball(entries: TarEntry[], level = 6): Uint8Array {
  return gzipSync(buildTar(entries), { level })
}

/** A regular file entry with no interesting metadata, for terse fixtures. */
export function file(path: string, content: string): TarEntry {
  return { path, content }
}
