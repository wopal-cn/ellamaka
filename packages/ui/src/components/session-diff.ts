import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { parsePatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@wopal/ellamaka-sdk/v2"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type SnapshotDiff = SnapshotFileDiff & { file: string }
type ReviewDiff = SnapshotDiff | VcsFileDiff | LegacyDiff
export type DiffSource = Pick<LegacyDiff, "file" | "patch" | "before" | "after">

export type ViewDiff = {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const diffCacheLimit = 16
const fileDiffCache = new Map<string, FileDiffMetadata>()
const patchFileDiffCache = new Map<string, FileDiffMetadata>()

export function resolveFileDiff(diff: DiffSource) {
  const before = typeof diff.before === "string" ? diff.before : ""
  const after = typeof diff.after === "string" ? diff.after : ""
  const key = JSON.stringify([diff.file, typeof diff.patch === "string" ? diff.patch : null, before, after])
  const hit = fileDiffCache.get(key)
  if (hit) {
    fileDiffCache.delete(key)
    fileDiffCache.set(key, hit)
    return hit
  }
  const value =
    typeof diff.patch === "string"
      ? fileDiffFromPatch(diff.file, diff.patch)
      : fileDiffFromContent(diff.file, before, after)
  fileDiffCache.set(key, value)
  while (fileDiffCache.size > diffCacheLimit) fileDiffCache.delete(fileDiffCache.keys().next().value!)
  return value
}

export function normalize(diff: ReviewDiff): ViewDiff {
  return {
    file: diff.file,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff: resolveFileDiff(diff),
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}

function fileDiffFromPatch(file: string, patch: string) {
  const key = `${file}\0${patch}`
  const hit = patchFileDiffCache.get(key)
  if (hit) {
    patchFileDiffCache.delete(key)
    patchFileDiffCache.set(key, hit)
    return hit
  }

  const input = patchInput(file, patch)
  const value = (input ? parsePatchFiles(input)[0]?.files[0] : undefined) ?? emptyFileDiff(file)
  patchFileDiffCache.set(key, value)
  while (patchFileDiffCache.size > diffCacheLimit) patchFileDiffCache.delete(patchFileDiffCache.keys().next().value!)
  return value
}

function patchInput(file: string, patch: string) {
  try {
    const parsed = parsePatch(patch)[0]
    if (!parsed) return
    if (parsed.index || parsed.oldFileName || parsed.newFileName) return patch
    if (!parsed.hunks.length) return
    return `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${patch}`
  } catch {
    return
  }
}

function fileDiffFromContent(file: string, before: string, after: string) {
  if (!before && !after) return emptyFileDiff(file)
  return parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })
}

function emptyFileDiff(file: string) {
  return parseDiffFromFile({ name: file, contents: "" }, { name: file, contents: "" })
}
