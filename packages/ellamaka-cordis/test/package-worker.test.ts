import { describe, expect, test } from "bun:test"
import { parsePackageWorkerArguments } from "../src/plugins/package-worker"

describe("package worker protocol", () => {
  test("accepts the native registry inspection and install arguments", () => {
    expect(parsePackageWorkerArguments(["config", "get", "registry"])).toMatchObject({ action: "config" })
    expect(
      parsePackageWorkerArguments([
        "view",
        "@scope/plugin@1.2.3",
        "name",
        "version",
        "peerDependencies",
        "--json",
        "--registry=https://registry.npmjs.org",
        "--config.fetch-retries=0",
      ]),
    ).toMatchObject({
      action: "view",
      spec: "@scope/plugin@1.2.3",
      fields: ["name", "version", "peerDependencies"],
      registry: "https://registry.npmjs.org/",
    })
    expect(parsePackageWorkerArguments(["add", "/tmp/local-plugin", "--reporter=append-only"])).toMatchObject({
      action: "add",
      spec: "/tmp/local-plugin",
    })
    expect(parsePackageWorkerArguments(["install", "--frozen-lockfile"])).toMatchObject({ action: "install" })
  })
  test("refuses unsupported sources and options before any write", () => {
    for (const source of ["git+https://host/repo", "https://host/pkg.tgz", "github:owner/repo", "link:../source"]) {
      expect(() => parsePackageWorkerArguments(["add", source])).toThrow(/unsupported/)
    }
    expect(() => parsePackageWorkerArguments(["add", "pkg", "--allow-build=something"])).toThrow(/unsupported/)
    expect(() => parsePackageWorkerArguments(["add", "pkg", "another"])).toThrow(/one/)
    expect(() => parsePackageWorkerArguments(["remove"])).toThrow(/requires/)
  })
})
