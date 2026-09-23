import { describe, expect, test } from "bun:test"
import {
  InstallationVersion,
  InstallationVersionBase,
  stripPrerelease,
} from "@wopal/ellamaka-core/installation/version"

// The plugin contract package follows the product base version (`2.0.5`) while
// the CLI/Desktop build version may carry a prerelease tag (`2.0.5-rc.7`). The
// engine pins the contract package at the stripped base version, so the
// stripping rule is load-bearing and lives in exactly one place.
describe("stripPrerelease", () => {
  test("strips an rc prerelease segment", () => {
    expect(stripPrerelease("2.0.5-rc.7")).toBe("2.0.5")
  })

  test("strips a beta prerelease segment", () => {
    expect(stripPrerelease("2.0.5-beta.2")).toBe("2.0.5")
  })

  test("returns a pure version unchanged", () => {
    expect(stripPrerelease("2.0.5")).toBe("2.0.5")
  })

  test("strips the legacy iteration suffix", () => {
    expect(stripPrerelease("1.15.13-4")).toBe("1.15.13")
  })

  test("passes the local dev version through unchanged", () => {
    expect(stripPrerelease("local")).toBe("local")
  })

  test("passes unrecognized input through unchanged", () => {
    expect(stripPrerelease("")).toBe("")
  })
})

describe("InstallationVersionBase", () => {
  test("is InstallationVersion without its prerelease segment", () => {
    expect(InstallationVersionBase).toBe(stripPrerelease(InstallationVersion))
  })

  test("is a pure x.y.z version or the local dev marker", () => {
    expect(InstallationVersionBase).toMatch(/^(\d+\.\d+\.\d+|local)$/)
  })
})
