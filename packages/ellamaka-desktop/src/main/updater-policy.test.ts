import { describe, expect, test } from "bun:test"
import { authorizeUpdate, authorizeUpdateFromFeed, type UpdateAuthorizationInput } from "./updater-policy"

function validInput(overrides: Partial<UpdateAuthorizationInput> = {}): UpdateAuthorizationInput {
  return {
    currentVersion: "1.16.2",
    currentChannel: "stable",
    targetVersion: "1.17.0",
    targetChannel: "stable",
    targetManifestVersion: "1.17.0",
    ...overrides,
  }
}

describe("updater: authorizeUpdate policy gate", () => {
  test("authorizes a valid stable upgrade", () => {
    const result = authorizeUpdate(validInput())
    expect(result.authorized).toBe(true)
  })

  test("rejects downgrade", () => {
    const result = authorizeUpdate(validInput({ currentVersion: "1.17.0", targetVersion: "1.16.2" }))
    expect(result.authorized).toBe(false)
    expect(result.reason).toMatch(/downgrade/)
  })

  test("rejects cross-channel (stable to beta)", () => {
    const result = authorizeUpdate(
      validInput({ currentChannel: "stable", targetChannel: "beta", targetVersion: "1.17.0-beta.1" }),
    )
    expect(result.authorized).toBe(false)
    expect(result.reason).toMatch(/channel/)
  })

  test("rejects when target manifest version mismatches updater version", () => {
    const result = authorizeUpdate(validInput({ targetVersion: "1.17.0", targetManifestVersion: "1.17.1" }))
    expect(result.authorized).toBe(false)
    expect(result.reason).toMatch(/manifest/)
  })

  test("authorizes beta channel upgrade within beta", () => {
    const result = authorizeUpdate(
      validInput({
        currentVersion: "1.16.0-beta.1",
        currentChannel: "beta",
        targetVersion: "1.16.0-beta.2",
        targetChannel: "beta",
        targetManifestVersion: "1.16.0-beta.2",
      }),
    )
    expect(result.authorized).toBe(true)
  })

  test("rejects same version (no-op)", () => {
    const result = authorizeUpdate(validInput({ currentVersion: "1.17.0", targetVersion: "1.17.0" }))
    expect(result.authorized).toBe(false)
    expect(result.reason).toMatch(/same|no-op|downgrade/)
  })

  test("rc sorts above beta (compareSemVer rank: stable > rc > beta)", () => {
    // rc.1 should authorize as an upgrade from beta.5 (rc > beta per SemVer).
    const result = authorizeUpdate(
      validInput({
        currentVersion: "1.17.0-beta.5",
        currentChannel: "beta",
        targetVersion: "1.17.0-rc.1",
        targetChannel: "beta", // same channel for the gate; rc is allowed in beta feed
        targetManifestVersion: "1.17.0-rc.1",
      }),
    )
    // Note: rc in a beta feed is a channel question; the policy gate treats
    // targetChannel from the version string. This test asserts the SemVer
    // precedence (rc > beta) drives the authorization.
    expect(result.authorized).toBe(true)
  })

  test("beta does NOT authorize as upgrade from rc (rc > beta)", () => {
    const result = authorizeUpdate(
      validInput({
        currentVersion: "1.17.0-rc.1",
        currentChannel: "beta",
        targetVersion: "1.17.0-beta.2",
        targetChannel: "beta",
        targetManifestVersion: "1.17.0-beta.2",
      }),
    )
    expect(result.authorized).toBe(false)
    expect(result.reason).toMatch(/downgrade/)
  })
})

// W-07: the gate must fetch the feed manifest independently and use its
// releaseIdentity.version as targetManifestVersion — NOT the updater-reported
// version, which would make the third gate self-proving.
describe("updater: authorizeUpdateFromFeed (manifest-backed gate)", () => {
  function makeFetch(manifestVersion: string | null) {
    return async (_url: string) => {
      if (manifestVersion === null) {
        throw new Error("network error")
      }
      return new Response(
        JSON.stringify({
          manifestSchemaVersion: 2,
          version: manifestVersion,
          releaseIdentity: { version: manifestVersion, product: "ellamaka-desktop" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
  }

  test("authorizes when feed manifest version equals updater version", async () => {
    const result = await authorizeUpdateFromFeed({
      fetch: makeFetch("1.17.0"),
      feedManifestUrl: "https://download.coursedao.com/ellamaka-desktop/latest/manifest.json",
      currentVersion: "1.16.2",
      currentChannel: "stable",
      targetVersion: "1.17.0",
      targetChannel: "stable",
    })
    expect(result.authorized).toBe(true)
  })

  test("rejects when feed manifest version mismatches updater version", async () => {
    // Updater says 1.17.0 but the feed manifest says 1.17.1 — the gate must
    // reject because the updater-reported version is not the same as the
    // authoritative manifest version.
    const result = await authorizeUpdateFromFeed({
      fetch: makeFetch("1.17.1"),
      feedManifestUrl: "https://download.coursedao.com/ellamaka-desktop/latest/manifest.json",
      currentVersion: "1.16.2",
      currentChannel: "stable",
      targetVersion: "1.17.0",
      targetChannel: "stable",
    })
    expect(result.authorized).toBe(false)
    expect(result.reason).toMatch(/manifest/)
  })

  test("fail closed when feed manifest fetch fails", async () => {
    const result = await authorizeUpdateFromFeed({
      fetch: makeFetch(null),
      feedManifestUrl: "https://download.coursedao.com/ellamaka-desktop/latest/manifest.json",
      currentVersion: "1.16.2",
      currentChannel: "stable",
      targetVersion: "1.17.0",
      targetChannel: "stable",
    })
    expect(result.authorized).toBe(false)
    expect(result.failed).toBe(true)
    expect(result.reason).toMatch(/manifest fetch|fetch/)
  })

  test("fail closed when feed manifest is not valid JSON", async () => {
    const fetch = async () =>
      new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
    const result = await authorizeUpdateFromFeed({
      fetch,
      feedManifestUrl: "https://download.coursedao.com/ellamaka-desktop/latest/manifest.json",
      currentVersion: "1.16.2",
      currentChannel: "stable",
      targetVersion: "1.17.0",
      targetChannel: "stable",
    })
    expect(result.authorized).toBe(false)
    expect(result.failed).toBe(true)
  })

  test("authorizes beta upgrade with matching beta feed manifest", async () => {
    const result = await authorizeUpdateFromFeed({
      fetch: makeFetch("1.16.0-beta.2"),
      feedManifestUrl: "https://download.coursedao.com/ellamaka-desktop/beta/latest/manifest.json",
      currentVersion: "1.16.0-beta.1",
      currentChannel: "beta",
      targetVersion: "1.16.0-beta.2",
      targetChannel: "beta",
    })
    expect(result.authorized).toBe(true)
  })
})
