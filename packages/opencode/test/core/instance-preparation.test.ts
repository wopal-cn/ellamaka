import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { getInstancePreparationTarget } from "@/core/instance-preparation"

describe("instance preparation target normalization", () => {
  test("real and symlink paths share the same canonical target directory", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(path.join(os.tmpdir(), "instance-prep-target-"))
    const real = path.join(root, "space")
    const link = path.join(root, "space-link")
    try {
      await mkdir(real, { recursive: true })
      await symlink(real, link, "dir")
      expect(await getInstancePreparationTarget(real)).toEqual(await getInstancePreparationTarget(link))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
