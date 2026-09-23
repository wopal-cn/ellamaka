import { describe, expect, test } from "bun:test"
import { resolve } from "path"
import { parsePublishArgs, runPublishCli, type PublishCliDeps } from "../src/cli/publish-npm"
import { createAuthCheck } from "../src/npm/execute"
import { loadPublishTargets, readProductVersion, type NpmPublishTarget, type PublishPlanEntry } from "../src/npm/plan"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")

interface Recorder {
  deps: PublishCliDeps
  published: PublishPlanEntry[]
  verified: PublishPlanEntry[]
  authChecks: string[]
  out: string[]
  err: string[]
}

function recorder(
  options: {
    published?: string[]
    probe?: (name: string, version: string) => boolean
    auth?: (registry: string) => void
    publishError?: Error
    verifyError?: Error
    targets?: () => NpmPublishTarget[]
  } = {},
): Recorder {
  const record: Recorder = {
    published: [],
    verified: [],
    authChecks: [],
    out: [],
    err: [],
    deps: {
      // Real workspace targets and the real version anchor: the CLI test proves
      // the shipped packages agree with the release version the workflow passes.
      loadTargets: options.targets ?? (() => loadPublishTargets(repoRoot)),
      readProductVersion: () => readProductVersion(repoRoot),
      isPublished: options.probe ?? ((name) => (options.published ?? []).includes(name)),
      verifySkipped: (entry) => {
        record.verified.push(entry)
        if (options.verifyError) throw options.verifyError
      },
      assertRegistryAuth: (registry) => {
        record.authChecks.push(registry)
        options.auth?.(registry)
      },
      publishPackage: (entry) => {
        record.published.push(entry)
        if (options.publishError) throw options.publishError
      },
      log: (line) => record.out.push(line),
      logError: (line) => record.err.push(line),
    },
  }
  return record
}

function withStalePlugin(): NpmPublishTarget[] {
  return loadPublishTargets(repoRoot).map((target) =>
    target.dir === "packages/plugin" ? { ...target, manifest: { ...target.manifest, version: "2.0.4" } } : target,
  )
}

describe("argument parsing", () => {
  test("defaults to a real publish against the public registry", () => {
    expect(parsePublishArgs([])).toEqual({
      options: { dryRun: false, registry: "https://registry.npmjs.org/", version: undefined },
    })
  })

  test("parses --dry-run, --version and --registry", () => {
    expect(parsePublishArgs(["--dry-run", "--version", "2.0.5-rc.7", "--registry", "https://r.example/"])).toEqual({
      options: { dryRun: true, version: "2.0.5-rc.7", registry: "https://r.example/" },
    })
  })

  test("fails closed on an unknown flag", () => {
    expect(parsePublishArgs(["--force"])).toMatchObject({ exitCode: 2 })
  })

  test("fails closed when a valued flag is missing its value", () => {
    expect(parsePublishArgs(["--version"])).toMatchObject({ exitCode: 2 })
  })
})

describe("skip verification", () => {
  test("verifies every version it is about to skip", () => {
    const record = recorder({ published: ["@wopal/ellamaka-sdk"] })
    expect(runPublishCli([], record.deps)).toBe(0)
    expect(record.verified.map((entry) => entry.name)).toEqual(["@wopal/ellamaka-sdk"])
    expect(record.published.map((entry) => entry.name)).toEqual(["@wopal/ellamaka-plugin"])
  })

  test("verifies all skipped versions before publishing anything", () => {
    // Verification is the guard: it must run before the first publish, so a
    // divergent skip cannot be discovered after a sibling has shipped.
    const record = recorder({ published: ["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"] })
    expect(runPublishCli([], record.deps)).toBe(0)
    expect(record.verified.map((entry) => entry.name)).toEqual(["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"])
    expect(record.published).toEqual([])
  })

  test("does not verify a version it is going to publish", () => {
    const record = recorder()
    expect(runPublishCli([], record.deps)).toBe(0)
    expect(record.verified).toEqual([])
  })

  test("fails closed when a skipped version does not match this source", () => {
    const record = recorder({
      published: ["@wopal/ellamaka-sdk"],
      verifyError: new Error(
        "@wopal/ellamaka-sdk@2.0.5 is already on the registry but its contents differ from this build " +
          "(registry deadbeef, local cafef00d): the version is permanently burned — bump the version and re-release",
      ),
    })
    expect(runPublishCli([], record.deps)).toBe(1)
    // Nothing is published after a failed verification: the release is broken.
    expect(record.published).toEqual([])
    expect(record.err.join("\n")).toMatch(/2\.0\.5/)
    expect(record.err.join("\n")).toMatch(/bump/i)
  })

  test("does not authenticate when verification fails", () => {
    const record = recorder({
      published: ["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"],
      verifyError: new Error("@wopal/ellamaka-sdk@2.0.5 contents differ"),
    })
    expect(runPublishCli([], record.deps)).toBe(1)
    expect(record.authChecks).toEqual([])
  })

  test("verifies a concurrently published version before accepting the race", () => {
    const probes: string[] = []
    const record = recorder({
      probe: (name, version) => {
        probes.push(`${name}@${version}`)
        return probes.length > 2
      },
      publishError: new Error("npm publish failed with exit code 1: npm error code E403 Forbidden"),
    })
    expect(runPublishCli([], record.deps)).toBe(0)
    expect(record.verified.map((entry) => entry.name)).toEqual(["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"])
  })
})

describe("dry run", () => {
  test("prints the expected manifest and performs zero side effects", () => {
    const record = recorder()
    const exitCode = runPublishCli(["--dry-run"], record.deps)

    expect(exitCode).toBe(0)
    expect(record.authChecks).toEqual([])
    expect(record.published).toEqual([])

    const output = record.out.join("\n")
    expect(output).toContain("[publish] @wopal/ellamaka-sdk@")
    expect(output).toContain("[publish] @wopal/ellamaka-plugin@")
    expect(output).toContain("wopal-ellamaka-sdk-")
    expect(output).toContain("wopal-ellamaka-plugin-")
    expect(output).toContain("packages/sdk/js")
    // The rewritten entrypoints are shown so the operator sees what ships.
    expect(output).toContain("./dist/v2/index.js")
    expect(output).toContain("./dist/v2/gen/client/index.d.ts")
    expect(output).toMatch(/dry run/i)
  })

  test("reports skips without publishing them", () => {
    const record = recorder({ published: ["@wopal/ellamaka-sdk"] })
    expect(runPublishCli(["--dry-run"], record.deps)).toBe(0)

    const output = record.out.join("\n")
    expect(output).toContain("[skip] @wopal/ellamaka-sdk@")
    expect(output).toContain("already published")
    expect(output).toContain("[publish] @wopal/ellamaka-plugin@")
  })

  test("does not download or unpack anything, so it stays side-effect free", () => {
    // The digest comparison fetches a registry tarball and packs the local
    // build; a dry run must do neither.
    const record = recorder({ published: ["@wopal/ellamaka-sdk"] })
    expect(runPublishCli(["--dry-run"], record.deps)).toBe(0)
    expect(record.verified).toEqual([])
    expect(record.published).toEqual([])
  })

  test("keeps the sdk-first order in the plan", () => {
    const record = recorder()
    runPublishCli(["--dry-run"], record.deps)
    const output = record.out.join("\n")
    expect(output.indexOf("@wopal/ellamaka-sdk")).toBeLessThan(output.indexOf("@wopal/ellamaka-plugin"))
  })
})

describe("publish", () => {
  test("authenticates, then publishes sdk before plugin", () => {
    const record = recorder()
    expect(runPublishCli([], record.deps)).toBe(0)

    expect(record.authChecks).toEqual(["https://registry.npmjs.org/"])
    expect(record.published.map((entry) => entry.name)).toEqual(["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"])
  })

  test("skips an already published version instead of republishing it", () => {
    const record = recorder({ published: ["@wopal/ellamaka-sdk"] })
    expect(runPublishCli([], record.deps)).toBe(0)
    expect(record.published.map((entry) => entry.name)).toEqual(["@wopal/ellamaka-plugin"])
  })

  test("does not authenticate when every version is already published", () => {
    const record = recorder({ published: ["@wopal/ellamaka-sdk", "@wopal/ellamaka-plugin"] })
    expect(runPublishCli([], record.deps)).toBe(0)
    expect(record.authChecks).toEqual([])
    expect(record.published).toEqual([])
    expect(record.out.join("\n")).toContain("nothing to do")
  })

  test("fails with an explicit message when the registry rejects the login", () => {
    // The real credential check, with `npm whoami` stubbed as unauthenticated.
    const record = recorder({ auth: createAuthCheck({ whoami: () => false, env: {} }) })
    expect(runPublishCli([], record.deps)).toBe(1)
    expect(record.published).toEqual([])
    expect(record.err.join("\n")).toMatch(/NPM_TOKEN|npm login|authenticat/i)
  })

  test("fails with a permission hint when publish is rejected", () => {
    const record = recorder({ publishError: new Error("npm publish failed with exit code 1: npm error code E403") })
    expect(runPublishCli([], record.deps)).toBe(1)
    const errors = record.err.join("\n")
    expect(errors).toContain("@wopal/ellamaka-sdk@")
    expect(errors).toMatch(/permission|trusted publishing|403/i)
  })

  test("takes the idempotent path when a concurrent release wins the race", () => {
    // The probe runs before the build/pack, so another release can publish the
    // same immutable version in between; the resulting conflict is not a
    // failure — the version is on the registry and this run still succeeds.
    const probes: string[] = []
    const record = recorder({
      probe: (name, version) => {
        probes.push(`${name}@${version}`)
        // The two planning probes miss; every re-probe after a failed publish hits.
        return probes.length > 2
      },
      publishError: new Error("npm publish failed with exit code 1: npm error code E403 Forbidden"),
    })

    expect(runPublishCli([], record.deps)).toBe(0)
    expect(probes).toEqual([
      "@wopal/ellamaka-sdk@2.0.5",
      "@wopal/ellamaka-plugin@2.0.5",
      "@wopal/ellamaka-sdk@2.0.5",
      "@wopal/ellamaka-plugin@2.0.5",
    ])
    expect(record.err).toEqual([])
    expect(record.out.join("\n")).toMatch(/published concurrently/i)
  })

  test("still fails hard when the rejected version is absent from the registry", () => {
    // A genuine credential/permission rejection must not be excused by the
    // re-probe: nothing published the version, so the release is broken.
    const record = recorder({ publishError: new Error("npm publish failed with exit code 1: npm error code E403") })
    expect(runPublishCli([], record.deps)).toBe(1)
    expect(record.err.join("\n")).toMatch(/failed to publish @wopal\/ellamaka-sdk@/)
  })
})

describe("version validation", () => {
  test("fails fast on a mismatch before any registry access", () => {
    const record = recorder({ targets: withStalePlugin })
    expect(runPublishCli([], record.deps)).toBe(1)
    expect(record.authChecks).toEqual([])
    expect(record.published).toEqual([])
    expect(record.err.join("\n")).toContain("@wopal/ellamaka-plugin@2.0.4")
  })

  test("--version overrides the anchor-derived product version", () => {
    const record = recorder()
    expect(runPublishCli(["--dry-run", "--version", "2.0.6"], record.deps)).toBe(1)
    expect(record.err.join("\n")).toContain("2.0.6")
  })

  test("the shipped packages agree with the prerelease-bearing release version", () => {
    // The anchor carries the release prerelease (2.0.5-rc.7) while the packages
    // are pinned at the base version — the strip must bridge the two.
    const anchor = readProductVersion(repoRoot)
    expect(anchor).toMatch(/^\d+\.\d+\.\d+/)
    const record = recorder()
    expect(runPublishCli(["--dry-run", "--version", anchor], record.deps)).toBe(0)
    expect(record.err).toEqual([])
  })
})
