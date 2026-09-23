import { describe, expect, test } from "bun:test"
import { tarballContentDigest } from "../src/npm/content"
import { verifySkippedVersion } from "../src/npm/verify"
import type { PublishPlanEntry } from "../src/npm/plan"
import { file, tarball } from "./tarball-helpers"

const REGISTRY = "https://registry.npmjs.org/"

const ENTRY: PublishPlanEntry = {
  name: "@wopal/ellamaka-plugin",
  version: "2.0.5",
  dir: "packages/plugin",
  tarball: "wopal-ellamaka-plugin-2.0.5.tgz",
  decision: "skip",
  reason: "already published on the registry",
}

/** The package contents the registry is assumed to hold. */
const PUBLISHED = [
  file("package/package.json", '{"name":"@wopal/ellamaka-plugin","version":"2.0.5"}\n'),
  file("package/dist/index.js", "export const x = 1\n"),
]

/** A tarball that differs from PUBLISHED in one shipped file. */
function tamperedContents(): Uint8Array {
  return tarball([PUBLISHED[0]!, file("package/dist/index.js", "export const x = 2\n")])
}

function errorText(record: Recorder): string {
  const err = record.error
  return err instanceof Error ? err.message : String(err)
}

interface Recorder {
  fetched: string[]
  packed: string[]
  out: string[]
  /** The thrown error, captured rather than propagated, so the recorder is
   *  always inspectable. `verify()` below still asserts the throwing contract. */
  error?: unknown
}

function attempt(
  options: {
    registry?: Uint8Array
    local?: Uint8Array
    fetchError?: Error
    packError?: Error
    entry?: PublishPlanEntry
  } = {},
): { record: Recorder; failed: () => unknown } {
  const record: Recorder = { fetched: [], packed: [], out: [] }
  const failed = () => record.error
  try {
    verifySkippedVersion(options.entry ?? ENTRY, {
      registry: REGISTRY,
      fetchTarball: (name, version, registryUrl) => {
        record.fetched.push(`${name}@${version} <- ${registryUrl}`)
        if (options.fetchError) throw options.fetchError
        return options.registry ?? tarball(PUBLISHED)
      },
      packLocal: (entry) => {
        record.packed.push(`${entry.name}@${entry.version}`)
        if (options.packError) throw options.packError
        return options.local ?? tarball(PUBLISHED)
      },
      log: (line) => record.out.push(line),
    })
  } catch (err) {
    record.error = err
  }
  return { record, failed }
}

/** Run the guard, asserting it threw, and return the recorded evidence. */
function verifyFailure(options: Parameters<typeof attempt>[0]): Recorder {
  const { record, failed } = attempt(options)
  expect(failed()).toBeDefined()
  return record
}

describe("verifySkippedVersion", () => {
  test("accepts the idempotent skip when the registry holds this build", () => {
    const record = attempt().record
    expect(record.error).toBeUndefined()
    expect(record.fetched).toEqual([`@wopal/ellamaka-plugin@2.0.5 <- ${REGISTRY}`])
    expect(record.packed).toEqual(["@wopal/ellamaka-plugin@2.0.5"])
    // The operator must be able to tell a verified skip from an unverified one
    // in the release log.
    expect(record.out.join("\n")).toMatch(/verified identical/)
    expect(record.out.join("\n")).toContain("@wopal/ellamaka-plugin@2.0.5")
  })

  test("compares content, not container bytes", () => {
    // A rebuilt tarball differs in entry order, mtimes and gzip level while
    // shipping the exact same package.
    const repacked = tarball([
      { ...PUBLISHED[1]!, path: "package/dist/index.js", mtime: 1_800_000_000 },
      { ...PUBLISHED[0]!, path: "package/package.json", mtime: 1_800_000_000 },
    ])
    const record = attempt({ local: repacked }).record
    expect(record.error).toBeUndefined()
    expect(record.out.join("\n")).toMatch(/verified identical/)
  })

  test("fails closed when the registry version is not what this source builds", () => {
    const record = verifyFailure({ local: tamperedContents() })
    expect(errorText(record)).toMatch(/@wopal\/ellamaka-plugin@2\.0\.5/)
  })

  test("tells the operator the version is burned and must be bumped", () => {
    const record = verifyFailure({ local: tamperedContents() })
    expect(errorText(record)).toMatch(/immutable|permanent/i)
    expect(errorText(record)).toMatch(/bump/i)
    expect(errorText(record)).toMatch(/version/i)
  })

  test("reports both digests so the divergence is diagnosable", () => {
    const record = verifyFailure({ local: tamperedContents() })
    expect(errorText(record)).toContain(tarballContentDigest(tarball(PUBLISHED)))
    expect(errorText(record)).toContain(tarballContentDigest(tamperedContents()))
  })

  test("still fetches the registry tarball before comparing", () => {
    const record = verifyFailure({ local: tamperedContents() })
    expect(record.fetched).toEqual([`@wopal/ellamaka-plugin@2.0.5 <- ${REGISTRY}`])
    expect(record.packed).toEqual(["@wopal/ellamaka-plugin@2.0.5"])
  })

  test("never packs the local build when the registry tarball cannot be read", () => {
    // A broken registry read must not be papered over by a successful local
    // build: the comparison is the guard.
    const record = verifyFailure({ fetchError: new Error("npm pack failed with exit code 1") })
    expect(errorText(record)).toMatch(/npm pack failed/)
    expect(record.packed).toEqual([])
  })

  test("propagates a local pack failure instead of skipping", () => {
    const record = verifyFailure({ packError: new Error("bun run build failed") })
    expect(errorText(record)).toMatch(/bun run build failed/)
  })
})
