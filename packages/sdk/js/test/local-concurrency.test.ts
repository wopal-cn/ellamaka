import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEllamakaLocalClient } from "../dist/local"

test("concurrent local calls remain isolated while the Worker disposes", async () => {
  const home = mkdtempSync(join(tmpdir(), "ellamaka-local-concurrency-"))
  const local = await createEllamakaLocalClient({ wopalHome: home, directory: home })
  try {
    const calls = Array.from({ length: 12 }, () => local.request("/wopal-space/spaces"))
    await local.dispose()
    const responses = await Promise.all(calls)
    expect(responses.every((response) => response.status === 200 || response.status === 410)).toBe(true)
  } finally {
    await local.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
