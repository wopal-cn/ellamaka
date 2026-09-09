import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@wopal/ellamaka-core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "ellamaka"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})

describe("global env isolation", () => {
  test("$WOPAL_HOME/.env is NOT loaded into process.env by Global module", async () => {
    // The Global module executes at import time (top-level await + side effects).
    // Importing it in-process would hit ESM module caching, so the test spawns a
    // fresh `bun test` subprocess that imports the module in isolation and reports
    // whether a sentinel key from $WOPAL_HOME/.env leaked into process.env.
    const sentinel = "ELLAMAKA_GLOBAL_ENV_SENTINEL"
    const sentinelValue = "loaded-from-file"

    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ellamaka-global-env-"))
    const probeDir = path.join(os.tmpdir(), "ellamaka-global-env-probe-")
    try {
      // Write a non-sensitive sentinel into $WOPAL_HOME/.env
      await fs.writeFile(path.join(tmpHome, ".env"), `${sentinel}=${sentinelValue}\n`)

      // Create a throwaway test file that the subprocess will run.
      // It must live inside this package so `@wopal/ellamaka-core/global` resolves.
      const probeDir = path.join(process.cwd(), ".tmp")
      await fs.mkdir(probeDir, { recursive: true })
      const probeFile = path.join(probeDir, "child-env-probe.test.ts")
      await fs.writeFile(
        probeFile,
        [
          `import { expect, test } from "bun:test"`,
          `import process from "process"`,
          `import { Global } from "@wopal/ellamaka-core/global"`,
          ``,
          `test("child probe", () => {`,
          `  expect(Global.Path.wopalHome).toBeDefined()`,
          `  console.log("PROBE_RESULT=" + JSON.stringify({ leaked: process.env.${sentinel}, wopalHome: Global.Path.wopalHome }))`,
          `})`,
        ].join("\n"),
      )

      const proc = Bun.spawn({
        cmd: [process.execPath, "test", "./.tmp/child-env-probe.test.ts"],
        cwd: process.cwd(),
        env: {
          // Minimal env: WOPAL_HOME points to the temp home.
          // Sentinel must NOT be present here so leakage from .env is detectable.
          WOPAL_HOME: tmpHome,
          PATH: process.env.PATH ?? "",
          HOME: os.homedir(),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      expect(exitCode).toBe(0)

      // Parse the PROBE_RESULT line emitted by the child test.
      const probeLine = stdout
        .split("\n")
        .find((line) => line.startsWith("PROBE_RESULT="))
      expect(probeLine).toBeDefined()
      const result = JSON.parse(probeLine!.slice("PROBE_RESULT=".length))

      // The Global module must NOT write .env keys into process.env.
      expect(result.leaked).toBeUndefined()
      // WOPAL_HOME path resolution still works.
      expect(result.wopalHome).toBe(tmpHome)
    } finally {
      await Promise.all([
        fs.rm(tmpHome, { recursive: true, force: true }),
        fs.rm(path.join(process.cwd(), ".tmp", "child-env-probe.test.ts"), { force: true }),
      ])
    }
  })
})
