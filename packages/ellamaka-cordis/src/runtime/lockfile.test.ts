import { afterEach, describe, expect, test } from "bun:test"
import { computeManifestFingerprint, type DshRuntimeManifestV1 } from "./manifest"
import {
  parseDshRuntimeLock,
  validateEmbeddedLock,
  type DshRuntimeLockEntryV1,
  type DshRuntimeLockV1,
} from "./lockfile"

const dirs: string[] = []

const MANIFEST: DshRuntimeManifestV1 = {
  schema: "ellamaka.dsh-runtime/v1",
  bridgeAbi: 1,
  dependencies: {
    "@deepseek-ai/dsh": "0.1.1-rc.2",
    "@deepseek-ai/cordis": "4.0.2",
  },
  fingerprint: "sha256:498f05d2654baf53d71934a4a856daf09a3980c8074b5ba872523eaf23e44088",
}

function lockWith(
  packages: Record<string, DshRuntimeLockEntry>,
  fingerprint = MANIFEST.fingerprint!,
): DshRuntimeLockV1 {
  return { schema: "ellamaka.dsh-runtime-lock/v1", manifestFingerprint: fingerprint, packages }
}

type DshRuntimeLockEntry = { version: string }

describe("parseDshRuntimeLock", () => {
  test("accepts a well-formed lock document with entries", () => {
    const lock = lockWith({
      "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
      "node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules/react": { version: "19.2.8" },
    })
    const parsed = parseDshRuntimeLock(JSON.stringify(lock))
    expect(parsed.schema).toBe("ellamaka.dsh-runtime-lock/v1")
    expect(Object.keys(parsed.packages)).toHaveLength(2)
    expect(parsed.packages["node_modules/@deepseek-ai/dsh"]?.version).toBe("0.1.1-rc.2")
    // nested entries carry their full node_modules-relative path
    expect(parsed.packages["node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules/react"]?.version).toBe(
      "19.2.8",
    )
  })

  test("rejects malformed JSON, wrong schema, or missing fields", () => {
    expect(() => parseDshRuntimeLock("not json")).toThrow()
    expect(() =>
      parseDshRuntimeLock(JSON.stringify({ schema: "other/v1", packages: {} })),
    ).toThrow(/schema/i)
    expect(() =>
      parseDshRuntimeLock(JSON.stringify({ schema: "ellamaka.dsh-runtime-lock/v1" })),
    ).toThrow(/packages|fingerprint/i)
  })

  test("accepts and preserves the optional flag on entries", () => {
    const lock = lockWith({
      "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
      "node_modules/@koromix/koffi-android-x64": { version: "3.2.1", optional: true },
    })
    const parsed = parseDshRuntimeLock(JSON.stringify(lock))
    expect(parsed.packages["node_modules/@koromix/koffi-android-x64"]?.optional).toBe(true)
    expect(parsed.packages["node_modules/@deepseek-ai/dsh"]?.optional).toBeUndefined()
  })

  test("rejects an entry whose optional flag is not a boolean", () => {
    const lock = lockWith({
      "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
      "node_modules/@koromix/koffi-android-x64": { version: "3.2.1", optional: "yes" },
    })
    expect(() => parseDshRuntimeLock(JSON.stringify(lock))).toThrow(/optional/)
  })
})

describe("validateEmbeddedLock", () => {
  test("accepts a lock whose fingerprint matches the manifest", () => {
    const lock = lockWith({
      "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" },
      "node_modules/@deepseek-ai/cordis": { version: "4.0.2" },
    })
    expect(() => validateEmbeddedLock(lock, MANIFEST)).not.toThrow()
  })

  test("rejects a lock whose fingerprint does not match the manifest", () => {
    const lock = lockWith({ "node_modules/@deepseek-ai/dsh": { version: "0.1.1-rc.2" } }, "sha256:stale")
    expect(() => validateEmbeddedLock(lock, MANIFEST)).toThrow(/fingerprint|drift/i)
  })

  test("rejects a lock missing one of the manifest's direct dependencies", () => {
    const lock = lockWith({ "node_modules/@deepseek-ai/cordis": { version: "4.0.2" } })
    expect(() => validateEmbeddedLock(lock, MANIFEST)).toThrow(/@deepseek-ai\/dsh/)
  })

  test("rejects a lock entry whose direct-dependency version drifts from the manifest", () => {
    const lock = lockWith({ "node_modules/@deepseek-ai/dsh": { version: "9.9.9" } })
    expect(() => validateEmbeddedLock(lock, MANIFEST)).toThrow(/@deepseek-ai\/dsh.*9\.9\.9/)
  })

  test("covers generated manifest fingerprint round-trip", () => {
    const computed = computeManifestFingerprint(MANIFEST)
    // the fixture fingerprint must be the canonical hash of the fixture itself,
    // proving the drift guard binds the real (manifest, lock) pair.
    expect(MANIFEST.fingerprint).toBe(computed)
  })
})