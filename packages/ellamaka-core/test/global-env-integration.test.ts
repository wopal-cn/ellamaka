import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { temporaryDirectory } from "./fixture/temp"

describe("global env isolation", () => {
  test("$WOPAL_HOME/.env is NOT loaded into process.env by Global module", async () => {
    // The Global module executes at import time (top-level await + side effects).
    // Importing it in-process would hit ESM module caching, so the test spawns a
    // fresh `bun test` subprocess that imports the module in isolation and reports
    // whether a sentinel key from $WOPAL_HOME/.env leaked into process.env.
    const sentinel = "ELLAMAKA_GLOBAL_ENV_SENTINEL"
    const sentinelValue = "loaded-from-file"

    const tmpHome = temporaryDirectory("ellamaka-global-env-")
    try {
      // Write a non-sensitive sentinel into $WOPAL_HOME/.env
      await fs.writeFile(path.join(tmpHome, ".env"), `${sentinel}=${sentinelValue}\n`)

      const probePreload = path.join(tmpHome, "child-env-preload.ts")
      const probeFile = path.join(tmpHome, "child-env-probe.test.ts")
      const globalModule = pathToFileURL(path.resolve(import.meta.dir, "../src/global.ts")).href
      // Set WOPAL_HOME to tmpHome in the subprocess preload BEFORE Global is imported
      // so initial module evaluation observes tmpHome (not after import via bindWopalHome).
      await fs.writeFile(probePreload, `process.env.WOPAL_HOME = ${JSON.stringify(tmpHome)}\n`)
      await fs.writeFile(
        probeFile,
        [
          `import { expect, test } from "bun:test"`,
          `import process from "process"`,
          `import { Global } from ${JSON.stringify(globalModule)}`,
          ``,
          `test("child probe", () => {`,
          `  expect(Global.Path.wopalHome).toBeDefined()`,
          `  console.log("PROBE_RESULT=" + JSON.stringify({ leaked: process.env.${sentinel}, wopalHome: Global.Path.wopalHome }))`,
          `})`,
        ].join("\n"),
      )

      const proc = Bun.spawn({
        cmd: [process.execPath, "test", probeFile, "--preload", probePreload],
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
      await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      expect(exitCode).toBe(0)

      // Parse the PROBE_RESULT line emitted by the child test.
      const probeLine = stdout.split("\n").find((line) => line.startsWith("PROBE_RESULT="))
      expect(probeLine).toBeDefined()
      const result = JSON.parse(probeLine!.slice("PROBE_RESULT=".length))

      // The Global module must NOT write .env keys into process.env.
      expect(result.leaked).toBeUndefined()
      // WOPAL_HOME path resolution still works at initial import time.
      expect(result.wopalHome).toBe(tmpHome)
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true })
    }
  })
})
