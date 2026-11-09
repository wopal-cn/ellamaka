import { describe, expect, test } from "bun:test"
import {
  canonicalJson,
  publicSubset,
  sdkOpenApi,
  verifyPackedContract,
  verifyPackedManifest,
} from "../src/npm/contract"
import type { PublishPlanEntry } from "../src/npm/plan"
import { file, tarball } from "./tarball-helpers"

const entry: PublishPlanEntry = {
  name: "@wopal/ellamaka-sdk",
  version: "2.0.11",
  dir: "packages/sdk/js",
  tarball: "wopal-ellamaka-sdk-2.0.11.tgz",
  decision: "publish",
  reason: "not published yet",
}

function operation(id: string) {
  return {
    operationId: id,
    summary: id,
    description: id + " description",
    "x-ellamaka-audience": "public-platform",
    "x-codeSamples": [{ lang: "shell", source: "curl http://127.0.0.1:4096/global/health" }],
  }
}

const serverDocument = {
  openapi: "3.1.0",
  paths: {
    "/global/health": { get: operation("global.health") },
    "/wopal-space/spaces": { get: operation("wopalSpace.space.list") },
    "/workbench/session-tree": {
      get: {
        operationId: "workbench.sessionTree",
        description: "Official App projection",
        "x-ellamaka-audience": "official-app",
        "x-codeSamples": [{ lang: "shell", source: "curl http://127.0.0.1:4096/workbench/session-tree" }],
      },
    },
  },
}

/** The packed SDK contract the Server publishes today. */
function packedSdk(overrides: Record<string, unknown> = {}): Uint8Array {
  const document = {
    openapi: "3.1.0",
    info: { title: "ellamaka", version: "2.0.11" },
    paths: publicSubset(serverDocument).paths,
    ...overrides,
  }
  return tarball([file("package/package.json", "{}"), file("package/dist/openapi.json", JSON.stringify(document))])
}

describe("packed SDK contract gate", () => {
  test("accepts a packed contract equal to the public Server subset", () => {
    const result = verifyPackedContract({ entry, tarball: packedSdk(), serverDocument })
    expect(result).toEqual({ operations: 2, paths: 2 })
  })

  test("rejects a packed contract missing a public Server operation", () => {
    // The committed openapi.json is the failure this gate exists for: it packs
    // and publishes happily while a newly public operation never reaches SDK
    // consumers.
    const stale = { "/global/health": { get: operation("global.health") } }
    expect(() => verifyPackedContract({ entry, tarball: packedSdk({ paths: stale }), serverDocument })).toThrow(
      /missing 1 public Server operation\(s\): GET \/wopal-space\/spaces/,
    )
  })

  test("rejects a packed contract documenting an operation the Server does not publish", () => {
    const paths = {
      ...publicSubset(serverDocument).paths,
      "/global/removed": { get: operation("global.removed") },
    }
    expect(() => verifyPackedContract({ entry, tarball: packedSdk({ paths }), serverDocument })).toThrow(
      /operation\(s\) the Server does not publish: GET \/global\/removed/,
    )
  })

  test("rejects a packed contract whose operation drifted from the Server document", () => {
    const drifted = structuredClone(publicSubset(serverDocument).paths)
    drifted["/global/health"]!.get = { ...operation("global.health"), description: "an older description" }
    expect(() => verifyPackedContract({ entry, tarball: packedSdk({ paths: drifted }), serverDocument })).toThrow(
      /GET \/global\/health differs from the Server document/,
    )
  })

  test("rejects an Official App BFF operation inside the packed SDK", () => {
    const paths = {
      ...publicSubset(serverDocument).paths,
      "/workbench/session-tree": serverDocument.paths["/workbench/session-tree"],
    }
    expect(() => verifyPackedContract({ entry, tarball: packedSdk({ paths }), serverDocument })).toThrow(
      /Official App BFF operation \/workbench\/session-tree/,
    )
  })

  test("rejects a public example that calls an App BFF path", () => {
    const paths = structuredClone(publicSubset(serverDocument).paths)
    paths["/global/health"]!.get = {
      ...operation("global.health"),
      "x-codeSamples": [{ lang: "shell", source: "curl http://127.0.0.1:4096/workbench/session-tree" }],
    }
    expect(() => verifyPackedContract({ entry, tarball: packedSdk({ paths }), serverDocument })).toThrow(
      /differs from the Server document|must not call \/workbench\//,
    )
  })

  test("rejects a packed SDK without the published OpenAPI contract", () => {
    const without = tarball([file("package/package.json", "{}")])
    expect(() => sdkOpenApi(without)).toThrow(/no dist\/openapi.json/)
  })
})

describe("packed manifest gate", () => {
  const manifest = (dependencies: Record<string, string>) =>
    tarball([file("package/package.json", JSON.stringify({ name: "@wopal/ellamaka-plugin", dependencies }))])

  test("accepts a manifest whose dependencies are all published versions", () => {
    const parsed = verifyPackedManifest(
      manifest({ "@wopal/ellamaka-sdk": "2.0.11", effect: "4.0.0-beta.66" }),
      "plugin",
    )
    expect(parsed.dependencies).toEqual({ "@wopal/ellamaka-sdk": "2.0.11", effect: "4.0.0-beta.66" })
  })

  test("rejects an unpublished workspace dependency", () => {
    // A workspace: specifier packs as-is and makes the package uninstallable
    // from the registry, so it must fail before the tarball reaches npm.
    expect(() => verifyPackedManifest(manifest({ "@wopal/ellamaka-sdk": "workspace:*" }), "plugin")).toThrow(
      /unpublished dependencies @wopal\/ellamaka-sdk@workspace:\*/,
    )
  })

  test("rejects file and link dependencies", () => {
    for (const specifier of ["file:../sdk", "link:../sdk"])
      expect(() => verifyPackedManifest(manifest({ "@wopal/ellamaka-sdk": specifier }), "plugin")).toThrow(
        /unpublished dependencies/,
      )
  })
})

describe("canonical document comparison", () => {
  test("ignores key order but not values", () => {
    expect(canonicalJson({ a: 1, b: [2, 3] })).toBe(canonicalJson({ b: [2, 3], a: 1 }))
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }))
  })
})
