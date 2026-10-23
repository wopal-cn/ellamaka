import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const OPENCODE_ROOT = join(import.meta.dir, "..", "..")
const CONTRACT = "./src/server/routes/instance/httpapi/public.ts"
const GENERATOR = "./script/generate-openapi.ts"

function importContract(home: string) {
  const script = [
    `const { PublicApi } = await import(${JSON.stringify(CONTRACT)})`,
    `const { OpenApi } = await import("effect/unstable/httpapi")`,
    `const spec = OpenApi.fromApi(PublicApi)`,
    `console.log("PATHCOUNT:" + Object.keys(spec.paths).length)`,
  ].join("\n")

  return Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: OPENCODE_ROOT,
    env: {
      ...process.env,
      WOPAL_HOME: join(home, "wophome"),
      OPENCODE_TEST_HOME: join(home, "testhome"),
      XDG_CONFIG_HOME: join(home, "xdg"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("public contract export is side-effect free", () => {
  test("importing the contract does not create the WOPAL_HOME tree", () => {
    const home = mkdtempSync(join(tmpdir(), "ellamaka-contract-"))
    try {
      const proc = importContract(home)
      expect(proc.exitCode).toBe(0)
      expect(proc.stdout.toString()).toContain("PATHCOUNT:")
      expect(existsSync(join(home, "wophome"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  test("generating OpenAPI does not create the WOPAL_HOME tree", () => {
    const home = mkdtempSync(join(tmpdir(), "ellamaka-openapi-"))
    try {
      const proc = Bun.spawnSync({
        cmd: [process.execPath, GENERATOR],
        cwd: OPENCODE_ROOT,
        env: {
          ...process.env,
          WOPAL_HOME: join(home, "wophome"),
          OPENCODE_TEST_HOME: join(home, "testhome"),
          XDG_CONFIG_HOME: join(home, "xdg"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(proc.exitCode).toBe(0)
      const spec = JSON.parse(proc.stdout.toString())
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0)
      const schemas = spec.components?.schemas ?? {}
      for (const name of [
        "EventInstallationUpdated",
        "EventInstallationUpdateAvailable",
        "EventMessageUpdated",
        "EventMessageRemoved",
        "EventMessagePartUpdated",
        "EventMessagePartRemoved",
        "EventSessionCreated",
        "EventSessionUpdated",
        "EventSessionDeleted",
      ]) {
        expect(schemas).toHaveProperty(name)
      }
      expect(existsSync(join(home, "wophome"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  test("CLI generate compatibility path stays side-effect free", () => {
    const home = mkdtempSync(join(tmpdir(), "ellamaka-cli-openapi-"))
    try {
      const proc = Bun.spawnSync({
        cmd: [process.execPath, "run", "--conditions=browser", "./src/index.ts", "generate"],
        cwd: OPENCODE_ROOT,
        env: {
          ...process.env,
          WOPAL_HOME: join(home, "wophome"),
          OPENCODE_TEST_HOME: join(home, "testhome"),
          XDG_CONFIG_HOME: join(home, "xdg"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(proc.exitCode).toBe(0)
      const spec = JSON.parse(proc.stdout.toString())
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0)
      expect(existsSync(join(home, "wophome"))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
