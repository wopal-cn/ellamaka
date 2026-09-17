import { afterEach, describe, expect, test } from "bun:test"
import { buildReleaseIdentityForBuild } from "../src/build-identity"

const COMMIT_40 = "91a7db1f22a2007588ee2a62e5d738b7d8e80291"

const savedEnv: Record<string, string | undefined> = {}
for (const key of ["ELLAMAKA_BUILD_COMMIT", "ELLAMAKA_RELEASE_CONTEXT_PATH"]) {
  savedEnv[key] = process.env[key]
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("buildReleaseIdentityForBuild: development identity", () => {
  test("version matches the build version without a 0.0.0-dev prefix", () => {
    delete process.env.ELLAMAKA_BUILD_COMMIT
    delete process.env.ELLAMAKA_RELEASE_CONTEXT_PATH

    const identity = buildReleaseIdentityForBuild({
      isRelease: false,
      version: "2.0.2-dev",
      channel: "main",
    })

    expect(identity.kind).toBe("development")
    expect(identity.version).toBe("2.0.2-dev")
  })

  test("keeps an already 0.0.0-prefixed build version untouched", () => {
    delete process.env.ELLAMAKA_BUILD_COMMIT
    delete process.env.ELLAMAKA_RELEASE_CONTEXT_PATH

    const identity = buildReleaseIdentityForBuild({
      isRelease: false,
      version: "0.0.0-local-202608070916",
      channel: "local",
    })

    expect(identity.version).toBe("0.0.0-local-202608070916")
  })

  test("folds prod (out-of-vocabulary dev channel) to local", () => {
    delete process.env.ELLAMAKA_BUILD_COMMIT
    delete process.env.ELLAMAKA_RELEASE_CONTEXT_PATH

    const identity = buildReleaseIdentityForBuild({
      isRelease: false,
      version: "2.0.2-prod.202608141200",
      channel: "prod",
    })

    expect(identity.channel).toBe("local")
  })

  test("reports local channel verbatim", () => {
    delete process.env.ELLAMAKA_BUILD_COMMIT
    delete process.env.ELLAMAKA_RELEASE_CONTEXT_PATH

    const identity = buildReleaseIdentityForBuild({
      isRelease: false,
      version: "0.0.0-local-202608070916",
      channel: "local",
    })

    expect(identity.channel).toBe("local")
  })

  test("records gitCommit and builtAt when available", () => {
    process.env.ELLAMAKA_BUILD_COMMIT = COMMIT_40
    delete process.env.ELLAMAKA_RELEASE_CONTEXT_PATH

    const identity = buildReleaseIdentityForBuild({
      isRelease: false,
      version: "2.0.2-dev",
      channel: "main",
    })

    expect(identity.build).toBeDefined()
    expect((identity.build as Record<string, unknown>).gitCommit).toBe(COMMIT_40)
    expect((identity.build as Record<string, unknown>).builtAt).toBeDefined()
  })
})
