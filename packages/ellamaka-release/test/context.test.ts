import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { buildReleaseContext, serializeReleaseContext } from "../src/context"
import { loadUpstreamLock } from "../src/identity"

const currentDir = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(currentDir, "fixtures", "release")
const COMMIT_40 = "385cb694419f98103af0e8fc6187ddcbcbb6eecb"
const ELLAMAKA_COMMIT_40 = "91a7db1f22a2007588ee2a62e5d738b7d8e80291"

function validLock() {
  return loadUpstreamLock(join(fixturesDir, "upstream-lock", "valid.lock.json"))
}

const baseArgs = {
  upstreamLock: validLock(),
  gitCommit: ELLAMAKA_COMMIT_40,
  workflowRunId: "123456789",
  builtAt: "2026-08-03T08:30:00Z",
}

describe("buildReleaseContext", () => {
  test("builds release context from namespaced tag and lock", () => {
    const ctx = buildReleaseContext({ tag: "ellamaka-cli-v1.17.1", ...baseArgs })

    expect(ctx.product).toBe("ellamaka-cli")
    expect(ctx.version).toBe("1.17.1")
    expect(ctx.channel).toBe("stable")
    expect(ctx.upstream.version).toBe("1.15.13")
    expect(ctx.build.sourceTag).toBe("ellamaka-cli-v1.17.1")
    expect(ctx.build.gitCommit).toBe(ELLAMAKA_COMMIT_40)
    expect(ctx.build.workflowRunId).toBe("123456789")
  })

  test("builds beta release context", () => {
    const ctx = buildReleaseContext({ tag: "ellamaka-desktop-v1.17.0-beta.1", ...baseArgs })

    expect(ctx.product).toBe("ellamaka-desktop")
    expect(ctx.version).toBe("1.17.0-beta.1")
    expect(ctx.channel).toBe("beta")
  })

  test("release context identity equals standalone identity builder", () => {
    const ctx = buildReleaseContext({ tag: "ellamaka-cli-v1.17.1", ...baseArgs })
    expect(ctx).toMatchObject({
      schemaVersion: 2,
      kind: "release",
      product: "ellamaka-cli",
      version: "1.17.1",
      channel: "stable",
    })
  })

  test("serializes to stable JSON with trailing newline", () => {
    const ctx = buildReleaseContext({ tag: "ellamaka-cli-v1.17.1", ...baseArgs })
    const serialized = serializeReleaseContext(ctx)
    expect(serialized.endsWith("\n")).toBe(true)
    expect(JSON.parse(serialized)).toEqual(ctx)
  })

  test("rejects a non-namespaced tag", () => {
    expect(() => buildReleaseContext({ tag: "v1.17.1", ...baseArgs })).toThrow(/namespaced/)
  })

  test("accepts an rc tag as a stable-channel candidate", () => {
    const ctx = buildReleaseContext({ tag: "ellamaka-cli-v1.18.0-rc.2", ...baseArgs })
    expect(ctx.version).toBe("1.18.0-rc.2")
    expect(ctx.channel).toBe("stable")
    expect(ctx.sourceTag).toBe("ellamaka-cli-v1.18.0-rc.2")
  })

  test("rejects a bad upstream lock", () => {
    const badLock = JSON.parse(
      readFileSync(join(fixturesDir, "upstream-lock", "short-commit.lock.json"), "utf8"),
    )
    expect(() =>
      buildReleaseContext({ tag: "ellamaka-cli-v1.17.1", ...baseArgs, upstreamLock: badLock }),
    ).toThrow(/ECOMMIT/)
  })

  test("rejects a missing workflowRunId", () => {
    expect(() =>
      buildReleaseContext({ tag: "ellamaka-cli-v1.17.1", ...baseArgs, workflowRunId: "" }),
    ).toThrow(/ERUN/)
  })
})
