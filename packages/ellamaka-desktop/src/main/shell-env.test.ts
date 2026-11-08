import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scopedEnv } from "../../test/fixture/process-env"

import { loadShellEnv, parseShellEnv, persistWopalHomeEnv, resolveUserShell } from "./shell-env"

describe("shell env", () => {
  test("parseShellEnv supports null-delimited pairs", () => {
    const env = parseShellEnv(Buffer.from("PATH=/usr/bin:/bin\0FOO=bar=baz\0\0"))

    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.FOO).toBe("bar=baz")
  })

  test("parseShellEnv ignores invalid entries", () => {
    const env = parseShellEnv(Buffer.from("INVALID\0=empty\0OK=1\0"))

    expect(Object.keys(env).length).toBe(1)
    expect(env.OK).toBe("1")
  })

  test("resolveUserShell falls back to the login shell before /bin/sh", () => {
    expect(resolveUserShell("/custom/env-shell", "/bin/zsh")).toBe("/custom/env-shell")
    expect(resolveUserShell(undefined, "/bin/zsh")).toBe("/bin/zsh")
    expect(resolveUserShell(undefined, "unknown")).toBe("/bin/sh")
    expect(resolveUserShell(undefined, undefined)).toBe("/bin/sh")
  })
})

describe("loadShellEnv", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wopal-shell-probe-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function shell(name: string, body: string) {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  function probePath() {
    return [join(dir, "cache-bin"), "/usr/bin", "/bin"].join(":")
  }

  test("continues after a failing candidate and parses a banner-framed snapshot", async () => {
    const failing = shell("failing-shell", "exit 7")
    const working = shell(
      "working-shell",
      `printf 'rc banner\\n'
printf '\\0%s\\0' '__WOPAL_ENV_START__'
printf 'PATH=%s\\0FOO=bar=baz\\0' '${probePath()}'
printf '\\0%s\\0' '__WOPAL_ENV_END__'`,
    )
    const logs: Array<[string, unknown[]]> = []

    const env = await loadShellEnv(working, {
      candidates: [failing, working],
      platform: "linux",
      inherited: { PATH: "/usr/bin:/bin" },
      log: { warn: (...args) => logs.push(["warn", args]), info: (...args) => logs.push(["info", args]) },
    })

    expect(env).toEqual({ PATH: probePath(), FOO: "bar=baz" })
    expect(logs).toEqual([
      [
        "warn",
        [
          "desktop.shell_env.probe_failed",
          {
            platform: "posix",
            candidate: "custom",
            attempt: 1,
            reason: "exit",
            status: 7,
          },
        ],
      ],
    ])
  })

  test("times out a hanging candidate and terminates its whole process group", async () => {
    const pidFile = join(dir, "child.pid")
    const hanging = shell(
      "hanging-shell",
      `sleep 30 &
echo $! > '${pidFile}'
wait`,
    )
    const working = shell(
      "after-timeout",
      `printf '\\0%s\\0' '__WOPAL_ENV_START__'
printf 'PATH=%s\\0' '${probePath()}'
printf '\\0%s\\0' '__WOPAL_ENV_END__'`,
    )
    const logs: Array<[string, unknown[]]> = []

    const env = await loadShellEnv(working, {
      candidates: [hanging, working],
      platform: "linux",
      inherited: { PATH: "/usr/bin:/bin" },
      timeoutMs: 2000,
      log: { warn: (...args) => logs.push(["warn", args]), info: (...args) => logs.push(["info", args]) },
    })

    expect(env).toEqual({ PATH: probePath() })
    expect(logs[0]).toEqual([
      "warn",
      [
        "desktop.shell_env.probe_failed",
        {
          platform: "posix",
          candidate: "custom",
          attempt: 1,
          reason: "timeout",
          durationMs: expect.any(Number),
        },
      ],
    ])
    const childPid = Number(readFileSync(pidFile, "utf8"))
    expect(() => process.kill(childPid, 0)).toThrow()
  })

  test("an explicit abort ends resolution without trying another candidate", async () => {
    const hanging = shell("aborting-shell", "sleep 30")
    const working = shell(
      "unreached-shell",
      `printf '\\0%s\\0' '__WOPAL_ENV_START__'
printf 'PATH=%s\\0' '${probePath()}'
printf '\\0%s\\0' '__WOPAL_ENV_END__'`,
    )
    const controller = new AbortController()
    const logs: Array<[string, unknown[]]> = []
    const pending = loadShellEnv(working, {
      candidates: [hanging, working],
      platform: "linux",
      inherited: { PATH: "/usr/bin:/bin" },
      signal: controller.signal,
      onSpawn: () => controller.abort(),
      log: { warn: (...args) => logs.push(["warn", args]), info: (...args) => logs.push(["info", args]) },
    })
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(logs.map((entry) => entry[1][0])).toEqual(["desktop.shell_env.probe_failed"])
    expect(logs[0]?.[1][1]).toMatchObject({ candidate: "custom", attempt: 1, reason: "aborted" })
  })

  test("keeps POSIX probe diagnostics free of environment and filesystem paths", async () => {
    const failing = shell("private-shell", "echo PRIVATE_STDOUT_AND_PATH >&2\nexit 1")
    const logs: Array<[string, unknown[]]> = []

    await loadShellEnv(failing, {
      candidates: [failing],
      platform: "linux",
      inherited: { PATH: "/usr/bin:/bin" },
      log: { warn: (...args) => logs.push(["warn", args]), info: (...args) => logs.push(["info", args]) },
    })

    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain(failing)
    expect(serialized).not.toContain("PRIVATE_STDOUT_AND_PATH")
    expect(serialized).not.toContain("PATH=")
    expect(logs.at(-1)).toEqual([
      "warn",
      [
        "desktop.shell_env.degraded",
        {
          platform: "posix",
          candidates: 1,
          source: "inherited",
          degraded: true,
        },
      ],
    ])
  })

  test("executes the actual probe command with a real POSIX shell", async () => {
    const value = await loadShellEnv("", {
      candidates: ["/bin/sh"],
      homeDir: dir,
      inherited: { HOME: dir, PATH: "/usr/bin:/bin", HOST_ENV_SENTINEL: "isolated" },
    })
    expect(value?.HOST_ENV_SENTINEL).toBe("isolated")
    expect(value?.DISABLE_AUTO_UPDATE).toBeUndefined()
  })

  test("Windows skips the POSIX resolver and returns the inherited environment", async () => {
    const logs: Array<[string, unknown[]]> = []
    const env = await loadShellEnv("unused", {
      candidates: [join(dir, "never-executed")],
      platform: "win32",
      inherited: { PATH: "C:\\Windows\\System32", WOPAL_HOME: "C:\\Users\\me\\.wopal" },
      log: { warn: (...args) => logs.push(["warn", args]), info: (...args) => logs.push(["info", args]) },
    })

    expect(env).toEqual({ PATH: "C:\\Windows\\System32", WOPAL_HOME: "C:\\Users\\me\\.wopal" })
    expect(logs).toEqual([])
  })
})

describe("persistWopalHomeEnv", () => {
  let home: string
  let profilePath: string
  let envScope: Disposable

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wopal-shell-env-"))
    profilePath = join(home, ".zshrc")
    envScope = scopedEnv({ SHELL: "/bin/zsh", WOPAL_DEV: undefined, WOPAL_HOME: undefined })
  })

  afterEach(() => {
    envScope[Symbol.dispose]()
    rmSync(home, { recursive: true, force: true })
  })

  test("skips shell profile update when WOPAL_DEV=1", () => {
    using _env = scopedEnv({ WOPAL_DEV: "1" })

    const result = persistWopalHomeEnv(join(home, "dev-home"))

    expect(result.success).toBe(true)
    expect(result.message).toContain("dev")
    expect(existsSync(profilePath)).toBe(false)
  })

  test("still sets WOPAL_HOME in dev mode", () => {
    using _env = scopedEnv({ WOPAL_DEV: "1" })
    const target = join(home, "dev-home")

    persistWopalHomeEnv(target)

    expect(process.env.WOPAL_HOME).toBe(target)
  })

  test("writes shell profile when not in dev mode", () => {
    const result = persistWopalHomeEnv(join(home, "prod-home"), {
      homeDir: () => home,
      platform: "darwin",
    })

    expect(result.success).toBe(true)
    expect(existsSync(profilePath)).toBe(true)
    expect(readFileSync(profilePath, "utf-8")).toContain("WOPAL_HOME")
  })
})
