import { describe, expect, test } from "bun:test"
import configExport from "../../electron.vite.config"

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

async function resolveMainBuild() {
  const config =
    typeof configExport === "function" ? await configExport({ command: "build", mode: "production" }) : configExport
  const main = config.main
  if (!main?.build) throw new Error("main build config missing")
  return main.build
}

describe("Desktop main bundle config", () => {
  test("inlines the TypeScript-only workspace package instead of externalizing it", async () => {
    const build = await resolveMainBuild()
    const externalize = build.externalizeDeps

    expect(externalize).not.toBe(true)
    if (typeof externalize !== "object" || externalize === null) throw new Error("externalizeDeps not configured")
    // `@wopal/ellamaka-core` ships `.ts` sources; leaving it external would make
    // the packaged main process depend on runtime type stripping plus the
    // workspace package being shipped.
    expect(externalize.exclude).toEqual(["@wopal/ellamaka-core"])
    expect(externalize.include).toEqual([nodePtyPkg])
  })

  test("keeps every other externalization and entry point unchanged", async () => {
    const build = await resolveMainBuild()

    expect(build.rollupOptions?.external).toEqual(["kerberos"])
    expect(Object.keys(build.rollupOptions?.input ?? {})).toEqual(["index", "sidecar", "source-ts-loader"])
  })
})
