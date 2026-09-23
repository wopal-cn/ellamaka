import { describe, expect, test } from "bun:test"
import { buildPublishPlan, tarballFileName, type NpmPublishTarget } from "../src/npm/plan"

function target(dir: string, name: string, version: string): NpmPublishTarget {
  return { dir, manifest: { name, version, exports: { ".": "./src/index.ts" } } }
}

const SDK = target("packages/sdk/js", "@wopal/ellamaka-sdk", "2.0.5")
const PLUGIN = target("packages/plugin", "@wopal/ellamaka-plugin", "2.0.5")

const neverPublished = () => false

describe("publish order", () => {
  test("sdk is published before plugin (plugin depends on sdk, including /v2)", () => {
    const plan = buildPublishPlan({ targets: [SDK, PLUGIN], productVersion: "2.0.5", isPublished: neverPublished })
    expect(plan.entries.map((entry) => entry.name)).toEqual(["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"])
  })
})

describe("idempotency", () => {
  test("an already published version is skipped", () => {
    const plan = buildPublishPlan({
      targets: [SDK, PLUGIN],
      productVersion: "2.0.5",
      isPublished: (name) => name === "@wopal/ellamaka-sdk",
    })
    expect(plan.entries.map((entry) => entry.decision)).toEqual(["skip", "publish"])
    expect(plan.entries[0]?.reason).toMatch(/already published/)
  })

  test("a version absent from the registry is published", () => {
    const plan = buildPublishPlan({ targets: [SDK], productVersion: "2.0.5", isPublished: neverPublished })
    expect(plan.entries[0]?.decision).toBe("publish")
    expect(plan.entries[0]?.tarball).toBe("wopal-ellamaka-sdk-2.0.5.tgz")
  })

  test("a fully published release plans no publish at all", () => {
    const plan = buildPublishPlan({ targets: [SDK, PLUGIN], productVersion: "2.0.5", isPublished: () => true })
    expect(plan.entries.every((entry) => entry.decision === "skip")).toBe(true)
  })

  test("the registry is probed once per package at that package's own version", () => {
    const probes: string[] = []
    buildPublishPlan({
      targets: [SDK, PLUGIN],
      productVersion: "2.0.5-rc.7",
      isPublished: (name, version) => {
        probes.push(`${name}@${version}`)
        return false
      },
    })
    expect(probes).toEqual(["@wopal/ellamaka-sdk@2.0.5", "@wopal/ellamaka-plugin@2.0.5"])
  })
})

describe("version validation", () => {
  test("strips the prerelease from the product version before matching", () => {
    const plan = buildPublishPlan({ targets: [SDK, PLUGIN], productVersion: "2.0.5-rc.7", isPublished: neverPublished })
    expect(plan.version).toBe("2.0.5")
  })

  test("accepts a prerelease-free product version as-is", () => {
    const plan = buildPublishPlan({ targets: [SDK], productVersion: "2.0.5", isPublished: neverPublished })
    expect(plan.version).toBe("2.0.5")
  })

  test("fails fast when a package version does not match the release version", () => {
    const stale = target("packages/plugin", "@wopal/ellamaka-plugin", "2.0.4")
    expect(() =>
      buildPublishPlan({ targets: [SDK, stale], productVersion: "2.0.5", isPublished: neverPublished }),
    ).toThrow(/@wopal\/ellamaka-plugin@2\.0\.4/)
  })

  test("validates every package before touching the registry", () => {
    // A version mismatch must never trigger a network probe: the release is
    // already invalid at that point.
    let probes = 0
    const stale = target("packages/plugin", "@wopal/ellamaka-plugin", "2.0.4")
    expect(() =>
      buildPublishPlan({
        targets: [SDK, stale],
        productVersion: "2.0.5",
        isPublished: () => {
          probes++
          return false
        },
      }),
    ).toThrow()
    expect(probes).toBe(0)
  })

  test("rejects a non-semver product version instead of guessing a base", () => {
    // stripPrerelease passes `local` through unchanged; the plan must then
    // fail the match rather than publish an unpublished version.
    expect(() => buildPublishPlan({ targets: [SDK], productVersion: "local", isPublished: neverPublished })).toThrow(
      /local/,
    )
  })
  test("fails the plan when a package to publish has no usable export map", () => {
    // Fail-closed before any publish: an empty/missing exports map would ship a
    // package whose public contract is gone.
    const bare = { dir: "packages/plugin", manifest: { name: "@wopal/ellamaka-plugin", version: "2.0.5" } }
    expect(() => buildPublishPlan({ targets: [bare], productVersion: "2.0.5", isPublished: neverPublished })).toThrow(
      /exports/,
    )
  })

  test("does not resolve the publish shape for a package that is skipped", () => {
    // A skipped package is never packed, so an unusable manifest must not fail
    // the run on its behalf.
    const bare = { dir: "packages/plugin", manifest: { name: "@wopal/ellamaka-plugin", version: "2.0.5" } }
    const plan = buildPublishPlan({ targets: [bare], productVersion: "2.0.5", isPublished: () => true })
    expect(plan.entries.map((entry) => entry.decision)).toEqual(["skip"])
  })
})

describe("tarball name", () => {
  test("follows the npm pack convention for scoped packages", () => {
    expect(tarballFileName("@wopal/ellamaka-sdk", "2.0.5")).toBe("wopal-ellamaka-sdk-2.0.5.tgz")
    expect(tarballFileName("@wopal/ellamaka-plugin", "2.0.5")).toBe("wopal-ellamaka-plugin-2.0.5.tgz")
  })
})
