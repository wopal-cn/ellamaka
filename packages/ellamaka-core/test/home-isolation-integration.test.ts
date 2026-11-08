import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Global } from "../src/global"
import { loadRepositoryFiles } from "../../opencode/script/test-isolation/check"
import { scanRepository } from "../../opencode/script/test-isolation/scan"

const coreRoot = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(coreRoot, "../..")

describe("ellamaka-core Home isolation base", () => {
  test("in-process Global.Path.wopalHome is bound to the isolated per-PID directory", () => {
    const expectedPrefix = path.join(os.tmpdir(), "ellamaka-core-test-data-")
    expect(Global.Path.wopalHome.startsWith(expectedPrefix)).toBe(true)
    expect(process.env.WOPAL_HOME).toBe(Global.Path.wopalHome)
    expect(existsSync(Global.Path.wopalHome)).toBe(true)
  })

  test("real bun test runner redirects WOPAL_HOME before Global.Path evaluation, ignores caller sentinel, and cleans up on pass and fail", () => {
    const workTmp = path.join(os.tmpdir(), `ellamaka-core-base-verify-${process.pid}-${Date.now()}`)
    mkdirSync(workTmp, { recursive: true })
    const probeDir = path.join(coreRoot, ".tmp")
    mkdirSync(probeDir, { recursive: true })
    const passProbe = path.join(probeDir, `home-base-pass-${process.pid}.test.ts`)
    const failProbe = path.join(probeDir, `home-base-fail-${process.pid}.test.ts`)

    try {
      writeFileSync(
        passProbe,
        [
          'import { expect, test } from "bun:test"',
          'import { existsSync, writeFileSync } from "node:fs"',
          'import path from "node:path"',
          'import { Global } from "@wopal/ellamaka-core/global"',
          'test("pass probe records isolated home", () => {',
          "  expect(existsSync(Global.Path.wopalHome)).toBe(true)",
          '  writeFileSync(path.join(Global.Path.wopalHome, "marker.txt"), "ok")',
          '  console.log("ISOLATED_HOME=" + Global.Path.wopalHome)',
          "})",
        ].join("\n"),
      )

      const passSentinel = path.join(workTmp, "nonexistent-pass-sentinel")
      const passRun = spawnSync(process.execPath, ["test", passProbe], {
        cwd: coreRoot,
        env: {
          ...process.env,
          WOPAL_HOME: passSentinel,
        },
        encoding: "utf8",
      })

      expect(passRun.status).toBe(0)
      expect(existsSync(passSentinel)).toBe(false)
      const combinedPassOut = (passRun.stdout ?? "") + "\n" + (passRun.stderr ?? "")
      const passHomeLine = combinedPassOut.split(/\r?\n/).find((l) => l.startsWith("ISOLATED_HOME="))
      expect(passHomeLine).toBeDefined()
      const passIsolatedHome = passHomeLine!.slice("ISOLATED_HOME=".length).trim()
      expect(passIsolatedHome).not.toBe(passSentinel)
      expect(passIsolatedHome.startsWith(path.join(os.tmpdir(), "ellamaka-core-test-data-"))).toBe(true)
      // Must be cleaned up after process exit
      expect(existsSync(passIsolatedHome)).toBe(false)

      // Also verify afterAll cleanup runs when a test fails
      writeFileSync(
        failProbe,
        [
          'import { expect, test } from "bun:test"',
          'import { existsSync, writeFileSync } from "node:fs"',
          'import path from "node:path"',
          'import { Global } from "@wopal/ellamaka-core/global"',
          'test("fail probe still cleans up isolated home", () => {',
          '  writeFileSync(path.join(Global.Path.wopalHome, "marker.txt"), "fail")',
          '  console.log("ISOLATED_HOME=" + Global.Path.wopalHome)',
          "  expect(true).toBe(false)",
          "})",
        ].join("\n"),
      )

      const failSentinel = path.join(workTmp, "nonexistent-fail-sentinel")
      const failRun = spawnSync(process.execPath, ["test", failProbe], {
        cwd: coreRoot,
        env: {
          ...process.env,
          WOPAL_HOME: failSentinel,
        },
        encoding: "utf8",
      })

      expect(failRun.status).not.toBe(0)
      expect(existsSync(failSentinel)).toBe(false)
      const combinedFailOut = (failRun.stdout ?? "") + "\n" + (failRun.stderr ?? "")
      const failHomeLine = combinedFailOut.split(/\r?\n/).find((l) => l.startsWith("ISOLATED_HOME="))
      expect(failHomeLine).toBeDefined()
      const failIsolatedHome = failHomeLine!.slice("ISOLATED_HOME=".length).trim()
      expect(failIsolatedHome).not.toBe(failSentinel)
      expect(existsSync(failIsolatedHome)).toBe(false)
    } finally {
      rmSync(passProbe, { force: true })
      rmSync(failProbe, { force: true })
      rmSync(workTmp, { recursive: true, force: true })
    }
  })

  test("a defective preload that evaluates Global.Path before assigning WOPAL_HOME fails runtime isolation", () => {
    const workTmp = path.join(os.tmpdir(), `ellamaka-core-late-preload-${process.pid}-${Date.now()}`)
    mkdirSync(workTmp, { recursive: true })
    const coreGlobalPath = path.resolve(coreRoot, "src/global.ts")
    try {
      const sentinel = path.join(workTmp, "caller-sentinel-home")
      const lateIsolated = path.join(workTmp, "late-isolated-home")
      const latePreload = path.join(workTmp, "late-preload.ts")
      const sampleTest = path.join(workTmp, "sample.test.ts")

      writeFileSync(
        latePreload,
        [
          `import { Global } from ${JSON.stringify(coreGlobalPath)}`,
          `void Global.Path.wopalHome`,
          `process.env.WOPAL_HOME = ${JSON.stringify(lateIsolated)}`,
        ].join("\n"),
      )
      writeFileSync(
        sampleTest,
        [
          'import { expect, test } from "bun:test"',
          `import { Global } from ${JSON.stringify(coreGlobalPath)}`,
          'test("late preload fails to redirect Global.Path before evaluation", () => {',
          '  console.log("LATE_PROBE_HOME=" + Global.Path.wopalHome)',
          `  expect(Global.Path.wopalHome).not.toBe(${JSON.stringify(sentinel)})`,
          "})",
        ].join("\n"),
      )

      const proc = spawnSync(
        process.execPath,
        ["test", "--config", "/dev/null", "--preload", latePreload, sampleTest],
        {
          cwd: workTmp,
          env: {
            ...process.env,
            WOPAL_HOME: sentinel,
          },
          encoding: "utf8",
        },
      )
      expect(proc.status).toBe(1)
      const combined = (proc.stdout ?? "") + "\n" + (proc.stderr ?? "")
      const probeLine = combined.split(/\r?\n/).find((l) => l.startsWith("LATE_PROBE_HOME="))
      expect(probeLine).toBe(`LATE_PROBE_HOME=${sentinel}`)
      expect(combined).toContain("late preload fails to redirect Global.Path before evaluation")
    } finally {
      rmSync(workTmp, { recursive: true, force: true })
    }
  })

  test("opencode real bun test runner redirects WOPAL_HOME before Global.Path evaluation, ignores caller sentinel, and cleans up its per-PID Home", () => {
    const opencodeRoot = path.resolve(coreRoot, "../opencode")
    const workTmp = path.join(os.tmpdir(), `opencode-base-verify-${process.pid}-${Date.now()}`)
    mkdirSync(workTmp, { recursive: true })
    const probeDir = path.join(opencodeRoot, ".tmp")
    mkdirSync(probeDir, { recursive: true })
    const passProbe = path.join(probeDir, `opencode-home-base-pass-${process.pid}.test.ts`)

    try {
      writeFileSync(
        passProbe,
        [
          'import { expect, test } from "bun:test"',
          'import { existsSync } from "node:fs"',
          'import { Global } from "@wopal/ellamaka-core/global"',
          'test("opencode pass probe records isolated home", () => {',
          "  expect(existsSync(Global.Path.wopalHome)).toBe(true)",
          '  console.log("OPENCODE_ISOLATED_HOME=" + Global.Path.wopalHome)',
          "})",
        ].join("\n"),
      )

      const sentinel = path.join(workTmp, "nonexistent-opencode-sentinel")
      const run = spawnSync(process.execPath, ["test", passProbe], {
        cwd: opencodeRoot,
        env: {
          ...process.env,
          WOPAL_HOME: sentinel,
        },
        encoding: "utf8",
        timeout: 60_000,
      })

      expect(run.status).toBe(0)
      expect(existsSync(sentinel)).toBe(false)
      const combinedOut = (run.stdout ?? "") + "\n" + (run.stderr ?? "")
      const homeLine = combinedOut.split(/\r?\n/).find((l) => l.startsWith("OPENCODE_ISOLATED_HOME="))
      expect(homeLine).toBeDefined()
      const isolatedHome = homeLine!.slice("OPENCODE_ISOLATED_HOME=".length).trim()
      expect(isolatedHome).not.toBe(sentinel)
      expect(isolatedHome.startsWith(path.join(os.tmpdir(), "opencode-test-data-"))).toBe(true)
      expect(existsSync(isolatedHome)).toBe(false)
    } finally {
      rmSync(passProbe, { force: true })
      rmSync(workTmp, { recursive: true, force: true })
    }
  })

  test("every discovered package with homeBindings (>0) passes runtime Home preload isolation and cleanup in a fresh bun test process", async () => {
    const fs = await loadRepositoryFiles(repoRoot)
    const { packages } = scanRepository(fs, repoRoot)
    const homeBoundPkgs = packages.filter((p) => p.homeBindings.length > 0)
    expect(homeBoundPkgs.length).toBeGreaterThanOrEqual(2)

    const workTmp = path.join(os.tmpdir(), `all-home-pkgs-verify-${process.pid}-${Date.now()}`)
    mkdirSync(workTmp, { recursive: true })

    try {
      for (const pkg of homeBoundPkgs) {
        expect(pkg.preloadValid).toBe(true)
        const pkgAbs = path.join(repoRoot, pkg.packageDir)
        const probeDir = path.join(pkgAbs, ".tmp")
        mkdirSync(probeDir, { recursive: true })
        const probeFile = path.join(probeDir, `pkg-home-probe-${process.pid}.test.ts`)
        const sentinel = path.join(workTmp, `sentinel-${pkg.packageDir.replace(/\//g, "_")}`)

        try {
          writeFileSync(
            probeFile,
            [
              'import { expect, test } from "bun:test"',
              'import { existsSync } from "node:fs"',
              'import { Global } from "@wopal/ellamaka-core/global"',
              'test("pkg home probe", () => {',
              "  expect(existsSync(Global.Path.wopalHome)).toBe(true)",
              '  console.log("PKG_ISOLATED_HOME=" + Global.Path.wopalHome)',
              "})",
            ].join("\n"),
          )

          const run = spawnSync(process.execPath, ["test", probeFile], {
            cwd: pkgAbs,
            env: {
              ...process.env,
              WOPAL_HOME: sentinel,
            },
            encoding: "utf8",
            timeout: 60_000,
          })

          expect(run.status, pkg.packageDir).toBe(0)
          expect(existsSync(sentinel), pkg.packageDir).toBe(false)
          const combined = (run.stdout ?? "") + "\n" + (run.stderr ?? "")
          const line = combined.split(/\r?\n/).find((l) => l.startsWith("PKG_ISOLATED_HOME="))
          expect(line, pkg.packageDir).toBeDefined()
          const isolatedHome = line!.slice("PKG_ISOLATED_HOME=".length).trim()
          expect(isolatedHome, pkg.packageDir).not.toBe(sentinel)
          expect(isolatedHome.startsWith(os.tmpdir()), pkg.packageDir).toBe(true)
          expect(existsSync(isolatedHome), pkg.packageDir).toBe(false)
        } finally {
          rmSync(probeFile, { force: true })
        }
      }
    } finally {
      rmSync(workTmp, { recursive: true, force: true })
    }
  })
})
