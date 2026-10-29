import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { NpmConfig } from "@wopal/ellamaka-core/npm-config"
import { tmpdir } from "./fixture/tmpdir"
import { scopedEnv } from "./fixture/process-env"

describe("NpmConfig.load", () => {
  test("reads registry from project .npmrc", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.registry).toBe("https://registry.example.test/")
  })

  test("reads scoped registries from project .npmrc", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "@acme:registry=https://npm.acme.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config["@acme:registry"]).toBe("https://npm.acme.test/")
  })

  test("flattens boolean and list options", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "ignore-scripts=true\nomit[]=dev\nomit[]=optional\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.ignoreScripts).toBe(true)
    expect(config.omit).toEqual(["dev", "optional"])
  })

  test("does not leak npm config flattening side effects into process.env", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit[]=dev\n")
    using _env = scopedEnv({ npm_config_user_agent: undefined, NODE_ENV: undefined })

    await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(process.env.npm_config_user_agent).toBeUndefined()
    expect(process.env.NODE_ENV).toBeUndefined()
  })

  test("restores pre-existing process env values after npm config flattening", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit[]=dev\n")
    using _env = scopedEnv({ npm_config_user_agent: "caller-agent", NODE_ENV: "development" })

    await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(process.env.npm_config_user_agent).toBe("caller-agent")
    expect(process.env.NODE_ENV).toBe("development")
  })

  test("restores process env values when npm config flattening fails", async () => {
    await using tmp = await tmpdir()
    const cafile = tmp.path.replaceAll("\\", "/")
    await Bun.write(
      path.join(tmp.path, ".npmrc"),
      [`user-agent=temporary-agent`, `omit[]=dev`, `cafile=${cafile}`].join("\n") + "\n",
    )
    using _env = scopedEnv({ npm_config_user_agent: "caller-agent", NODE_ENV: "development" })

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config).toEqual({})
    expect(process.env.npm_config_user_agent).toBe("caller-agent")
    expect(process.env.NODE_ENV).toBe("development")
  })
})

describe("NpmConfig.registry", () => {
  test("normalizes configured registry without trailing slash", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })

  test("leaves configured registry without trailing slash unchanged", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })
})
