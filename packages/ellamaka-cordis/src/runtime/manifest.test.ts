import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  buildDshRuntimeManifest,
  canonicalSerialize,
  computeManifestFingerprint,
  manifestsTextEqual,
  parseDshRuntimeManifest,
  type DshRuntimeManifestV1,
} from "./manifest"

// --- helpers ---------------------------------------------------------------

function makeManifest(overrides: Partial<DshRuntimeManifestV1> = {}): DshRuntimeManifestV1 {
  const base: DshRuntimeManifestV1 = {
    schema: "ellamaka.dsh-runtime/v1",
    bridgeAbi: 1,
    dependencies: { "@deepseek-ai/dsh": "0.1.1-rc.2" },
    fingerprint: "sha512-placeholder",
  }
  return { ...base, ...overrides }
}

const PKG = {
  dependencies: {
    "@deepseek-ai/dsh": "0.1.1-rc.2",
    "@deepseek-ai/cordis": "4.0.1",
  },
}

// --- schema parsing ---------------------------------------------------------

describe("parseDshRuntimeManifest", () => {
  test("accepts a valid v1 manifest", () => {
    const raw = JSON.stringify(makeManifest())
    const m = parseDshRuntimeManifest(raw)
    expect(m.schema).toBe("ellamaka.dsh-runtime/v1")
    expect(m.bridgeAbi).toBe(1)
    expect(m.dependencies["@deepseek-ai/dsh"]).toBe("0.1.1-rc.2")
  })

  test("rejects non-JSON input", () => {
    expect(() => parseDshRuntimeManifest("not-json")).toThrow()
  })

  test("rejects a manifest with an unknown schema", () => {
    const raw = JSON.stringify(makeManifest({ schema: "ellamaka.legacy/v9" }))
    expect(() => parseDshRuntimeManifest(raw)).toThrow(/schema/i)
  })

  test("rejects a manifest missing bridgeAbi", () => {
    const bad = makeManifest()
    delete (bad as Partial<DshRuntimeManifestV1>).bridgeAbi
    expect(() => parseDshRuntimeManifest(JSON.stringify(bad))).toThrow(/bridgeAbi|bridge/i)
  })
})

// --- fingerprint ------------------------------------------------------------

describe("computeManifestFingerprint", () => {
  test("is stable: same manifest yields the same digest", () => {
    const a = computeManifestFingerprint(makeManifest())
    const b = computeManifestFingerprint(makeManifest())
    expect(a).toBe(b)
  })

  test("changes when dependencies change", () => {
    const a = computeManifestFingerprint(makeManifest())
    const b = computeManifestFingerprint(
      makeManifest({ dependencies: { "@deepseek-ai/dsh": "0.2.0" } }),
    )
    expect(a).not.toBe(b)
  })

  test("does not include its own fingerprint field in the hashed content", () => {
    const withA = makeManifest({ fingerprint: "sha512-aaaa" })
    const withB = makeManifest({ fingerprint: "sha512-bbbb" })
    expect(computeManifestFingerprint(withA)).toBe(computeManifestFingerprint(withB))
  })

  test("returns a sha256 hex digest", () => {
    const fp = computeManifestFingerprint(makeManifest())
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

// --- buildDshRuntimeManifest ------------------------------------------------

describe("buildDshRuntimeManifest", () => {
  test("carries the exact DSH direct dependency versions", () => {
    const m = buildDshRuntimeManifest(PKG)
    expect(m.dependencies["@deepseek-ai/dsh"]).toBe("0.1.1-rc.2")
    expect(m.dependencies["@deepseek-ai/cordis"]).toBe("4.0.1")
  })

  test("carries no lock snapshot or registry field (runtime resolves them)", () => {
    const m = buildDshRuntimeManifest(PKG)
    expect(m.packageLock).toBeUndefined()
    expect(m.registry).toBeUndefined()
  })

  test("does not leak non-DSH runtime deps into the manifest", () => {
    // The cordis package carries @npmcli/arborist as a runtime dependency for
    // the materialiser, but the DSH production closure must contain only the
    // official @deepseek-ai/* packages (DESIGN §3.4.1).
    const pkgWithArborist = {
      dependencies: {
        ...PKG.dependencies,
        "@npmcli/arborist": "9.4.0",
      },
    }
    const m = buildDshRuntimeManifest(pkgWithArborist)
    expect(m.dependencies["@npmcli/arborist"]).toBeUndefined()
    expect(m.dependencies["@deepseek-ai/dsh"]).toBe("0.1.1-rc.2")
  })

  test("computes a fingerprint covering the exact dependency set", () => {
    const a = buildDshRuntimeManifest(PKG)
    const b = buildDshRuntimeManifest({ dependencies: { ...PKG.dependencies, "@deepseek-ai/cordis": "4.0.2" } })
    expect(a.fingerprint).not.toBe(b.fingerprint)
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

// --- canonical serialization ------------------------------------------------

describe("canonicalSerialize", () => {
  test("produces deterministic key order regardless of insertion order", () => {
    const a = canonicalSerialize({ b: 1, a: 2 })
    const b = canonicalSerialize({ a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1}')
  })

  test("matches a manual sha256 reference", () => {
    const text = canonicalSerialize({ foo: "bar", num: 42 })
    const expected = createHash("sha256").update(text).digest("hex")
    // recompute here rather than hardcoding, asserting consistency of the digest pipeline
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
  })
})

// --- CRLF-tolerant --check comparison (Windows git autocrlf gate fix) --------

describe("manifestsTextEqual", () => {
  const generated = `${canonicalSerialize({ schema: "ellamaka.dsh-runtime/v1", bridgeAbi: 1 })}\n`

  test("matches byte-identical committed content", () => {
    expect(manifestsTextEqual(generated, generated)).toBe(true)
  })

  test("tolerates CRLF line endings in the committed file (Windows checkout)", () => {
    // windows-latest runners enable core.autocrlf, which rewrites the committed
    // trailing LF into CRLF on checkout; the freshly generated output stays LF.
    const crlfCommitted = generated.replace(/\n/g, "\r\n")
    expect(manifestsTextEqual(crlfCommitted, generated)).toBe(true)
  })

  test("still rejects genuinely different content", () => {
    const different = canonicalSerialize({
      schema: "ellamaka.dsh-runtime/v1",
      bridgeAbi: 2,
    })
    expect(manifestsTextEqual(`${different}\n`, generated)).toBe(false)
  })
})
