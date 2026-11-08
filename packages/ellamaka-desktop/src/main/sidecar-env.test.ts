import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { app } from "electron"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { scopedEnv } from "../../test/fixture/process-env"
import {
  createSidecarEnv,
  createSidecarOutputForwarder,
  createSidecarSpawner,
  type DesktopHostEnvironment,
  type SidecarFork,
} from "./server"
import { resolveDesktopHostEnvironment } from "./shell-env"
import {
  clearSidecarCredentials,
  isSidecarOnlyOpencodeKey,
  listenThenClearCredentials,
  SIDECAR_ONLY_OPENCODE_KEYS,
  stripSidecarOpencodeEnv,
} from "./sidecar-credentials"

/** A resolved Host Environment snapshot, exactly what startup hands to the sidecar. */
function host(env: Record<string, string>, home = join("/", "tmp", "wopal-home")): DesktopHostEnvironment {
  return { home, env: { ...env, WOPAL_HOME: home } }
}

describe("createSidecarEnv", () => {
  test("builds the sidecar env from the explicit Host Environment", () => {
    const env = createSidecarEnv(
      "secret",
      host({ PATH: "/opt/homebrew/bin:/usr/bin:/bin", SOME_DESKTOP_VAR: "keep-me", DEBUG: "opencode*" }),
    )

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
    expect(env.SOME_DESKTOP_VAR).toBe("keep-me")
    expect(env.DEBUG).toBeUndefined()
    expect(env.ELLAMAKA_SERVER_USERNAME).toBe("ellamaka")
    expect(env.ELLAMAKA_SERVER_PASSWORD).toBe("secret")
    expect(env.OPENCODE_CLIENT).toBe("ellamaka-desktop")
    expect(env.OPENCODE_DISABLE_EMBEDDED_WEB_UI).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe("true")
  })

  test("does not copy anything the Host Environment does not carry", () => {
    // Regression for the pre-#263 shape: the sidecar env must come from the
    // resolved snapshot, never from whatever happens to sit in Main's process.
    using _scope = scopedEnv({ MAIN_ONLY_VAR: "must-not-leak" })

    const env = createSidecarEnv("secret", host({ PATH: "/usr/bin:/bin" }))

    expect(env.MAIN_ONLY_VAR).toBeUndefined()
  })

  test("pins WOPAL_HOME and an absolute DSH_HOME to the resolved product root", () => {
    const home = join("/", "tmp", "isolated-wopal")
    const env = createSidecarEnv("secret", host({}, home))

    expect(env.WOPAL_HOME).toBe(home)
    expect(env.DSH_HOME).toBe(join(home, "dsh", "home"))
    expect(isAbsolute(env.DSH_HOME)).toBe(true)
  })

  test("keeps Desktop-owned values over shell-provided sidecar switches", () => {
    const env = createSidecarEnv(
      "secret",
      host({
        ELLAMAKA_SERVER_PASSWORD: "shell-secret",
        ELLAMAKA_SERVER_USERNAME: "shell-user",
        OPENCODE_CLIENT: "shell-value",
        OPENCODE_DISABLE_EMBEDDED_WEB_UI: "false",
      }),
    )

    expect(env.ELLAMAKA_SERVER_PASSWORD).toBe("secret")
    expect(env.ELLAMAKA_SERVER_USERNAME).toBe("ellamaka")
    expect(env.OPENCODE_CLIENT).toBe("ellamaka-desktop")
    expect(env.OPENCODE_DISABLE_EMBEDDED_WEB_UI).toBe("true")
  })

  test("forwards user-configured experimental switches over the desktop defaults", () => {
    // Regression for B-02: user experimental switches present in the Host
    // Environment must reach the sidecar child env even though they are
    // sidecar-only. User intent wins over the desktop defaults.
    const env = createSidecarEnv(
      "secret",
      host({
        OPENCODE_EXPERIMENTAL_LSP_TY: "true",
        OPENCODE_EXPERIMENTAL_NATIVE_LLM: "true",
        OPENCODE_EXPERIMENTAL: "true",
      }),
    )

    expect(env.OPENCODE_EXPERIMENTAL_LSP_TY).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe("true")
  })

  test("lets a user-configured value override a desktop default switch", () => {
    const env = createSidecarEnv("secret", host({ OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "false" }))

    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("false")
  })

  test("does not mutate the Host Environment snapshot", () => {
    const snapshot = host({ PATH: "/usr/bin:/bin", OPENCODE_CLIENT: "shell-value" })
    const before = { ...snapshot.env }

    createSidecarEnv("secret", snapshot)

    expect(snapshot.env).toEqual(before)
  })
})

describe("sidecar diagnostic routing", () => {
  test("suppresses Node's raw warning printer after the structured logger is installed", () => {
    const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8")
    const sidecar = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")

    expect(server).toContain('"--no-warnings"')
    expect(sidecar).toContain("await Log.init({\n      print: false,")
    expect(sidecar).not.toContain("console.warn(")
    expect(sidecar).toContain("logger: dshPluginLogger(")
  })

  test("bounds repetitive sidecar stdout or stderr relays with an explicit summary", () => {
    const output: string[] = []
    let now = 0
    const forward = createSidecarOutputForwarder((message) => output.push(message), {
      windowMs: 1_000,
      maxPerWindow: 2,
      now: () => now,
    })

    forward.write("first\n")
    forward.write("first\n")
    forward.write("second\n")
    forward.write("third\n")
    now = 1_001
    forward.write("after-window\n")

    expect(output).toEqual(["first", "second", "sidecar output suppressed 2 records in 1000ms", "after-window"])
  })
})

describe("Desktop startup wiring", () => {
  test("resolves the Host Environment exactly once and passes it to the sidecar and IPC", () => {
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

    // One resolution per launch (AC#5): restarts reuse the captured snapshot.
    expect(index.match(/resolveDesktopHostEnvironment\(/g)).toHaveLength(1)
    // The second WOPAL_HOME shell probe is gone.
    expect(index).not.toContain("probeWopalHomeFromShell")
    // The root is bound through the owning Home API (rebases Global.Path);
    // assigning process.env alone would leave the initialized view stale.
    expect(index).toContain("bindDesktopProductRoot(host.home)")
    expect(index).not.toContain("process.env.WOPAL_HOME = host.home")
    expect(index.indexOf("bindDesktopProductRoot(host.home)")).toBeLessThan(index.indexOf("yield* startWorkbench("))
    expect(index).toContain("createSidecarSpawner(needsMigration, opts.host)")
    expect(index).toContain("homePath: opts.host.home")
  })

  test("never rebuilds the sidecar env from the Main process environment", () => {
    const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8")

    expect(server).not.toContain("preferAppEnv")
    expect(server).not.toContain("process.env.WOPAL_HOME")
  })
})

describe("sidecar credentials cleanup", () => {
  test("clearSidecarCredentials deletes both credential keys from process.env", () => {
    using _scope = scopedEnv({ ELLAMAKA_SERVER_PASSWORD: "secret", ELLAMAKA_SERVER_USERNAME: "ellamaka" })

    clearSidecarCredentials()

    expect(process.env.ELLAMAKA_SERVER_PASSWORD).toBeUndefined()
    expect(process.env.ELLAMAKA_SERVER_USERNAME).toBeUndefined()
  })

  test("stripSidecarOpencodeEnv removes every sidecar-only OPENCODE key", () => {
    const env = {
      PATH: "/usr/bin:/bin",
      OPENCODE_CLIENT: "x",
      ELLAMAKA_SERVER_USERNAME: "ellamaka",
      ELLAMAKA_SERVER_PASSWORD: "secret",
      OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
      OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
      OPENCODE_EXPERIMENTAL_NATIVE_LLM: "true",
      OPENCODE_EXPERIMENTAL: "true",
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    }

    const clean = stripSidecarOpencodeEnv(env)

    expect(clean.PATH).toBe("/usr/bin:/bin")
    for (const key of SIDECAR_ONLY_OPENCODE_KEYS) expect(clean[key]).toBeUndefined()
    expect(clean.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBeUndefined()
    expect(clean.OPENCODE_EXPERIMENTAL).toBeUndefined()
  })

  test("SIDECAR_ONLY_OPENCODE_KEYS covers exact credentials and switches", () => {
    // Experimental flags are matched by prefix (isSidecarOnlyOpencodeKey), not
    // enumerated here; only the exact keys are expected.
    expect(SIDECAR_ONLY_OPENCODE_KEYS).toEqual([
      "ELLAMAKA_SERVER_USERNAME",
      "ELLAMAKA_SERVER_PASSWORD",
      "OPENCODE_CLIENT",
      "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
    ])
  })

  test("isSidecarOnlyOpencodeKey matches experimental prefix and root switch", () => {
    expect(isSidecarOnlyOpencodeKey("ELLAMAKA_SERVER_USERNAME")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("ELLAMAKA_SERVER_PASSWORD")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("OPENCODE_CLIENT")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("OPENCODE_DISABLE_EMBEDDED_WEB_UI")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("OPENCODE_EXPERIMENTAL_NATIVE_LLM")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("OPENCODE_EXPERIMENTAL_LSP_TY")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("OPENCODE_EXPERIMENTAL_SOME_FUTURE_FLAG")).toBe(true)
    // B-01: the root toggle OPENCODE_EXPERIMENTAL (no trailing underscore) is
    // also sidecar-only.
    expect(isSidecarOnlyOpencodeKey("OPENCODE_EXPERIMENTAL")).toBe(true)
    expect(isSidecarOnlyOpencodeKey("PATH")).toBe(false)
    expect(isSidecarOnlyOpencodeKey("HOME")).toBe(false)
  })

  test("listenThenClearCredentials keeps credentials while listen is pending, clears after it resolves", async () => {
    // Regression for W-01: the mock listener must stay pending until we release
    // it, so a future buggy change that clears credentials before awaiting the
    // listen promise would be caught.
    using _scope = scopedEnv({ ELLAMAKA_SERVER_PASSWORD: "secret", ELLAMAKA_SERVER_USERNAME: "ellamaka" })

    let releaseListen!: () => void
    const pending = new Promise<void>((resolve) => {
      releaseListen = resolve
    })
    const listen = async () => {
      // Block until the test releases it — emulates a long-running Server.listen.
      await pending
      return { listener: "ok" }
    }

    const started = listenThenClearCredentials(listen)

    // While listen is still pending, the credentials must be present so
    // ServerAuth (ConfigProvider.fromEnv()) can capture them during listen.
    expect(process.env.ELLAMAKA_SERVER_PASSWORD).toBe("secret")
    expect(process.env.ELLAMAKA_SERVER_USERNAME).toBe("ellamaka")

    releaseListen()
    const result = await started

    expect(result).toEqual({ listener: "ok" })
    // Only after listen resolved were the credentials cleared.
    expect(process.env.ELLAMAKA_SERVER_PASSWORD).toBeUndefined()
    expect(process.env.ELLAMAKA_SERVER_USERNAME).toBeUndefined()
  })

  test("listenThenClearCredentials clears even when listen rejects", async () => {
    using _scope = scopedEnv({ ELLAMAKA_SERVER_PASSWORD: "secret" })

    await expect(listenThenClearCredentials(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(process.env.ELLAMAKA_SERVER_PASSWORD).toBeUndefined()
  })
})

type ForkCall = {
  modulePath: string
  args: string[]
  options: { env: Record<string, string | undefined>; cwd: string; serviceName: string }
}

type StartMessage = {
  type: string
  hostname?: string
  port?: number
  wopalHome?: string
  pluginLogDir?: string
  runtimeLogFile?: string
}

function isCommand(value: unknown, type: string): value is StartMessage {
  return typeof value === "object" && value !== null && "type" in value && value.type === type
}

/**
 * Minimal Electron utility process double. `postMessage({type:"start"})`
 * answers with `ready` on the next microtask (the sidecar protocol) and
 * `{type:"stop"}` exits, so the supervisor's stop path settles immediately.
 */
function createFakeFork() {
  const calls: ForkCall[] = []
  const startMessages: StartMessage[] = []

  const fork: SidecarFork = (modulePath, args, options) => {
    calls.push({
      modulePath,
      args: args ?? [],
      options: { env: options?.env ?? {}, cwd: options?.cwd ?? "", serviceName: options?.serviceName ?? "" },
    })
    const process = new EventEmitter()
    const child = Object.assign(process, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {},
      postMessage: (message: unknown) => {
        if (isCommand(message, "start")) {
          startMessages.push(message)
          queueMicrotask(() => process.emit("message", { type: "ready" }))
        }
        if (isCommand(message, "stop")) queueMicrotask(() => process.emit("exit", 0))
      },
    })
    // UtilityProcess cannot be constructed outside Electron; the fake implements
    // exactly the members the spawn path uses.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return child as ReturnType<SidecarFork>
  }

  return { fork, calls, startMessages }
}

describe("spawnLocalServer fork contract", () => {
  test("GUI-minimal inherited env becomes the sidecar env, start message and restart snapshot", async () => {
    // The Electron mock does not implement EventEmitter.off, which the spawn
    // path uses once the child exits; supply it instead of skipping the exit.
    if (!Reflect.has(app, "off")) Reflect.set(app, "off", () => {})

    const dir = mkdtempSync(join(tmpdir(), "sidecar-spawn-"))
    try {
      const root = join(dir, "inherited-root")
      const failShell = join(dir, "failing-shell")
      const okShell = join(dir, "dumping-shell")
      writeFileSync(failShell, "#!/bin/sh\nexit 1\n")
      writeFileSync(
        okShell,
        "#!/bin/sh\nprintf '\\000__WOPAL_ENV_START__\\000PATH=/opt/homebrew/bin:/usr/bin:/bin\\000CUSTOM_A=from-shell\\000SECRET_SHELL_ONLY=not-imported\\000__WOPAL_ENV_END__\\000'\n",
      )
      chmodSync(failShell, 0o755)
      chmodSync(okShell, 0o755)
      mkdirSync(join(root, "config"), { recursive: true })
      writeFileSync(
        join(root, "config", "settings.jsonc"),
        JSON.stringify({ wopal: { execution: { shellEnv: { mode: "allowlist", list: ["PATH", "CUSTOM_*"] } } } }),
      )

      let probes = 0
      const host = await resolveDesktopHostEnvironment({
        inherited: { PATH: "/usr/bin:/bin", WOPAL_HOME: root },
        candidates: [failShell, okShell],
        homeDir: dir,
        log: { warn: () => {} },
        onSpawn: () => {
          probes++
        },
      })

      // First candidate fails, second supplies the Shell Environment, and the
      // allowlist keeps PATH/CUSTOM_* while dropping the unlisted variable.
      expect(probes).toBe(2)
      expect(host.home).toBe(root)
      expect(host.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
      expect(host.env.CUSTOM_A).toBe("from-shell")
      expect(host.env.SECRET_SHELL_ONLY).toBeUndefined()

      const fake = createFakeFork()
      const spawner = createSidecarSpawner(false, host, fake.fork)

      const first = await spawner("127.0.0.1", 1, "pw", {})
      // The fake never becomes HTTP-healthy; settle the background wait on stop.
      void first.health.wait.catch(() => {})
      await first.listener.stop()

      const second = await spawner("127.0.0.1", 1, "pw", {})
      void second.health.wait.catch(() => {})
      await second.listener.stop()

      // The real spawn path forked twice and never re-resolved the environment.
      expect(fake.calls).toHaveLength(2)
      expect(probes).toBe(2)

      for (const call of fake.calls) {
        expect(call.modulePath.endsWith("sidecar.js")).toBe(true)
        expect(call.options.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
        expect(call.options.env.WOPAL_HOME).toBe(root)
        expect(call.options.env.DSH_HOME).toBe(join(root, "dsh", "home"))
        expect(isAbsolute(call.options.env.DSH_HOME ?? "")).toBe(true)
      }
      // Restart reuses the same snapshot byte for byte.
      expect(fake.calls[1].options.env).toEqual(fake.calls[0].options.env)

      expect(fake.startMessages).toHaveLength(2)
      for (const message of fake.startMessages) {
        expect(message.type).toBe("start")
        expect(message.wopalHome).toBe(root)
        expect(message.pluginLogDir).toBe(join(root, "logs"))
        expect(message.runtimeLogFile).toBe(join(root, "logs", "dsh-runtime.log"))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
