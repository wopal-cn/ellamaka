import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import {
  CliContract,
  classifyWopalCliVersion,
  MIN_WOPAL_CLI_VERSION,
  isCompiledBundlePath,
  resolveMinWopalCliVersion,
} from "../../src/wopal/cli-contract"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer))

describe("wopal CLI contract", () => {
  test("accepts the minimum compatible release", () => {
    expect(classifyWopalCliVersion(MIN_WOPAL_CLI_VERSION)).toEqual({
      state: "ok",
      requiredVersion: MIN_WOPAL_CLI_VERSION,
      actualVersion: MIN_WOPAL_CLI_VERSION,
    })
  })

  test("rejects releases below the required version", () => {
    expect(classifyWopalCliVersion("0.3.3")).toEqual({
      state: "incompatible",
      requiredVersion: MIN_WOPAL_CLI_VERSION,
      actualVersion: "0.3.3",
    })
  })

  test("rejects prereleases before the required stable release", () => {
    expect(classifyWopalCliVersion("0.3.4-dev.1")).toEqual({
      state: "incompatible",
      requiredVersion: MIN_WOPAL_CLI_VERSION,
      actualVersion: "0.3.4-dev.1",
    })
  })

  test("marks non-semver output as broken", () => {
    expect(classifyWopalCliVersion("dev")).toEqual({
      state: "broken",
      requiredVersion: MIN_WOPAL_CLI_VERSION,
      actualVersion: "dev",
    })
  })

  test("accepts non-semver output from the explicit development CLI", () => {
    expect(classifyWopalCliVersion("dev", { development: true })).toEqual({
      state: "ok",
      requiredVersion: MIN_WOPAL_CLI_VERSION,
      actualVersion: "dev",
    })
  })

  it.live("inspect accepts the explicit TypeScript development CLI", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const executable = path.join(dir, "wopal.ts")
      yield* Effect.promise(() => Bun.write(executable, 'process.stdout.write("dev\\n")\n'))
      const previous = process.env.WOPAL_DEV_CLI_PATH
      process.env.WOPAL_DEV_CLI_PATH = executable
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.WOPAL_DEV_CLI_PATH
          else process.env.WOPAL_DEV_CLI_PATH = previous
        }),
      )

      const health = yield* Effect.gen(function* () {
        const service = yield* CliContract.Service
        return yield* service.inspect()
      }).pipe(Effect.provide(CliContract.defaultLayer))
      expect(health).toEqual({
        state: "ok",
        requiredVersion: MIN_WOPAL_CLI_VERSION,
        actualVersion: "dev",
      })
    }),
  )
})

describe("protocol floor resolution", () => {
  const FLOOR_ERROR = /MIN_WOPAL_CLI_VERSION is undefined/
  const sourcePath = "/repo/packages/opencode/src/wopal/cli-contract.ts"
  const compiledPath = "/$bunfs/root/chunk-x.js"
  const readVersions = (value?: string) => (): string | undefined => value

  test("prefers the injected env value in any bundle mode", () => {
    expect(resolveMinWopalCliVersion("9.9.9", compiledPath, readVersions("0.3.16"))).toBe("9.9.9")
    expect(resolveMinWopalCliVersion("9.9.9", sourcePath, readVersions("0.3.16"))).toBe("9.9.9")
  })

  test("falls back to the source-tree file only outside compiled bundles", () => {
    expect(resolveMinWopalCliVersion(undefined, sourcePath, readVersions("0.3.16"))).toBe("0.3.16")
  })

  test("throws in a compiled bundle when the value was not injected", () => {
    expect(() => resolveMinWopalCliVersion(undefined, compiledPath, readVersions("0.3.16"))).toThrow(FLOOR_ERROR)
  })

  test("throws in a source run when the file is unavailable", () => {
    expect(() => resolveMinWopalCliVersion(undefined, sourcePath, readVersions(undefined))).toThrow(FLOOR_ERROR)
  })
})

describe("isCompiledBundlePath", () => {
  test("recognizes bunfs virtual paths", () => {
    expect(isCompiledBundlePath("/$bunfs/root/chunk-abc.js")).toBe(true)
    expect(isCompiledBundlePath("B:/~BUN/root/chunk-abc.js")).toBe(true)
    expect(isCompiledBundlePath("b:/~bun/root/x.js")).toBe(true)
  })

  test("rejects real filesystem paths", () => {
    expect(isCompiledBundlePath("/repo/src/wopal/cli-contract.ts")).toBe(false)
    expect(isCompiledBundlePath("C:\\dev\\cli-contract.ts")).toBe(false)
  })
})
