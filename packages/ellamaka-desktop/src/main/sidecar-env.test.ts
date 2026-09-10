import { describe, expect, mock, test } from "bun:test"

// server.ts transitively imports electron-store (via ./store), which is not
// installed in the bun test environment. Provide a minimal in-memory store so
// the module can be imported for its pure env helpers.
mock.module("electron-store", () => {
  class MockStore {
    private data = new Map<string, unknown>()
    get(key: string) {
      return this.data.get(key)
    }
    set(key: string, value: unknown) {
      this.data.set(key, value)
    }
    delete(key: string) {
      this.data.delete(key)
    }
  }
  return { default: MockStore }
})

// Control the shell-env probe from the test. getUserShell/loadShellEnv are the
// only side-effecting pieces preferAppEnv relies on; mergeShellEnv and
// resolveShellPath are kept as their real behaviors so PATH resolution stays
// covered without re-duplicating logic in tests.
let shell: Record<string, string> | null = null

mock.module("./shell-env", () => ({
  getUserShell: () => "/bin/zsh",
  loadShellEnv: () => shell,
  mergeShellEnv: (shellEnv: Record<string, string> | null, env: Record<string, string>) => ({
    ...shellEnv,
    ...env,
  }),
  resolveShellPath: (shellEnv: Record<string, string> | null, appPath: string | undefined) =>
    shellEnv?.PATH ?? appPath,
}))

const { createSidecarEnv, preferAppEnv } = await import("./server")
const {
  captureSidecarExperimentalConfig,
  clearSidecarCredentials,
  getCapturedSidecarExperimentalConfig,
  isSidecarOnlyOpencodeKey,
  listenThenClearCredentials,
  SIDECAR_ONLY_OPENCODE_KEYS,
  stripSidecarOpencodeEnv,
} = await import("./sidecar-credentials")

const OPENCODE_SWITCHES = [
  "OPENCODE_CLIENT",
  "OPENCODE_EXPERIMENTAL_ICON_DISCOVERY",
  "OPENCODE_EXPERIMENTAL_FILEWATCHER",
  "OPENCODE_DISABLE_EMBEDDED_WEB_UI",
] as const

const OPENCODE_KEYS = [...OPENCODE_SWITCHES, "ELLAMAKA_SERVER_USERNAME", "ELLAMAKA_SERVER_PASSWORD"] as const

function snapshotKeys(keys: readonly string[]): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>()
  for (const key of keys) saved.set(key, process.env[key])
  return saved
}

function restoreKeys(saved: Map<string, string | undefined>) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// The dev/CI environment may already carry OPENCODE_* values (dev.sh injects
// them). Clear them before exercising the functions so assertions observe only
// what the function itself writes.
function clearOpencodeEnv() {
  for (const key of OPENCODE_KEYS) delete process.env[key]
}

// Reset the module-level captured experimental config so tests are isolated
// from any prior capture by preferAppEnv.
function resetCapturedExperimentalConfig() {
  captureSidecarExperimentalConfig({})
}

describe("createSidecarEnv", () => {
  test("explicitly sets credentials, client identity, and switches", () => {
    resetCapturedExperimentalConfig()
    clearOpencodeEnv()

    const env = createSidecarEnv("secret")

    expect(env.ELLAMAKA_SERVER_USERNAME).toBe("ellamaka")
    expect(env.ELLAMAKA_SERVER_PASSWORD).toBe("secret")
    expect(env.OPENCODE_CLIENT).toBe("ellamaka-desktop")
    expect(env.OPENCODE_DISABLE_EMBEDDED_WEB_UI).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe("true")
  })

  test("inherits the rest of process.env but drops DEBUG", () => {
    process.env.SOME_DESKTOP_VAR = "keep-me"
    process.env.DEBUG = "opencode*"

    try {
      const env = createSidecarEnv("secret")

      expect(env.SOME_DESKTOP_VAR).toBe("keep-me")
      expect(env.DEBUG).toBeUndefined()
    } finally {
      delete process.env.SOME_DESKTOP_VAR
      delete process.env.DEBUG
    }
  })

  test("does not mutate process.env with credentials or switches", () => {
    const saved = snapshotKeys(OPENCODE_KEYS)
    clearOpencodeEnv()

    try {
      createSidecarEnv("secret")

      expect(process.env.ELLAMAKA_SERVER_USERNAME).toBeUndefined()
      expect(process.env.ELLAMAKA_SERVER_PASSWORD).toBeUndefined()
      for (const key of OPENCODE_SWITCHES) expect(process.env[key]).toBeUndefined()
    } finally {
      restoreKeys(saved)
    }
  })

  test("forwards user-configured experimental switches over the desktop defaults", () => {
    // Regression for B-02: user experimental switches captured by preferAppEnv
    // must reach the sidecar child env even though they are stripped from the
    // main process. User intent wins over the desktop defaults.
    resetCapturedExperimentalConfig()
    captureSidecarExperimentalConfig({
      OPENCODE_EXPERIMENTAL_LSP_TY: "true",
      OPENCODE_EXPERIMENTAL_NATIVE_LLM: "true",
      OPENCODE_EXPERIMENTAL: "true",
    })

    const env = createSidecarEnv("secret")

    // User-configured flags are forwarded...
    expect(env.OPENCODE_EXPERIMENTAL_LSP_TY).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL).toBe("true")
    // ...and the desktop defaults still apply for the two Workbench switches.
    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("true")
    expect(env.OPENCODE_EXPERIMENTAL_FILEWATCHER).toBe("true")
  })

  test("user-configured value overrides a desktop default switch", () => {
    resetCapturedExperimentalConfig()
    captureSidecarExperimentalConfig({
      OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "false",
    })

    const env = createSidecarEnv("secret")

    expect(env.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY).toBe("false")
  })
})

describe("preferAppEnv", () => {
  test("updates PATH from shell env without writing OPENCODE_* switches back to process.env", () => {
    shell = { PATH: "/opt/homebrew/bin:/usr/bin:/bin" }
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH"])
    clearOpencodeEnv()

    try {
      preferAppEnv()

      expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
      for (const key of OPENCODE_SWITCHES) expect(process.env[key]).toBeUndefined()
    } finally {
      shell = null
      restoreKeys(saved)
    }
  })

  test("keeps process.env free of OPENCODE_* switches when shell env is unavailable", () => {
    shell = null
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH"])
    clearOpencodeEnv()

    try {
      preferAppEnv()

      for (const key of OPENCODE_SWITCHES) expect(process.env[key]).toBeUndefined()
    } finally {
      restoreKeys(saved)
    }
  })

  test("strips sidecar-only OPENCODE_* values carried by the login shell", () => {
    // Regression for B-01: a developer shell rc may export sidecar-only
    // OPENCODE_* variables. preferAppEnv must never write them back into the
    // main process, even when they come through the shell env.
    shell = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      OPENCODE_CLIENT: "shell-value",
      OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
      OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
      ELLAMAKA_SERVER_USERNAME: "ellamaka",
      ELLAMAKA_SERVER_PASSWORD: "shell-secret",
    }
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH"])
    clearOpencodeEnv()

    try {
      preferAppEnv()

      expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
      for (const key of OPENCODE_KEYS) expect(process.env[key]).toBeUndefined()
    } finally {
      shell = null
      restoreKeys(saved)
    }
  })

  test("removes sidecar-only OPENCODE_* keys already present in process.env", () => {
    // Even if the main process was started with sidecar-only keys injected by
    // an outer environment (e.g. dev.sh), preferAppEnv must clear them.
    shell = { PATH: "/opt/homebrew/bin:/usr/bin:/bin" }
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH"])
    clearOpencodeEnv()
    process.env.OPENCODE_CLIENT = "pre-existing"
    process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"
    process.env.ELLAMAKA_SERVER_PASSWORD = "pre-existing"

    try {
      preferAppEnv()

      for (const key of OPENCODE_KEYS) expect(process.env[key]).toBeUndefined()
    } finally {
      shell = null
      restoreKeys(saved)
    }
  })

  test("strips an unlisted OPENCODE_EXPERIMENTAL_* flag carried by the login shell", () => {
    // Regression for B-01: the engine consumes many OPENCODE_EXPERIMENTAL_*
    // flags beyond the two the desktop explicitly injects. Any of them leaking
    // from the login shell into the main process env must be stripped by prefix.
    shell = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      OPENCODE_EXPERIMENTAL_NATIVE_LLM: "true",
      OPENCODE_EXPERIMENTAL_PARALLEL: "true",
    }
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH", "OPENCODE_EXPERIMENTAL_NATIVE_LLM", "OPENCODE_EXPERIMENTAL_PARALLEL"])
    clearOpencodeEnv()

    try {
      preferAppEnv()

      expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
      expect(process.env.OPENCODE_EXPERIMENTAL_NATIVE_LLM).toBeUndefined()
      expect(process.env.OPENCODE_EXPERIMENTAL_PARALLEL).toBeUndefined()
    } finally {
      shell = null
      restoreKeys(saved)
    }
  })

  test("removes a pre-existing unlisted OPENCODE_EXPERIMENTAL_* flag from process.env", () => {
    shell = { PATH: "/opt/homebrew/bin:/usr/bin:/bin" }
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH", "OPENCODE_EXPERIMENTAL_LSP_TY"])
    clearOpencodeEnv()
    process.env.OPENCODE_EXPERIMENTAL_LSP_TY = "true"

    try {
      preferAppEnv()

      expect(process.env.OPENCODE_EXPERIMENTAL_LSP_TY).toBeUndefined()
    } finally {
      shell = null
      restoreKeys(saved)
    }
  })

  test("strips the root OPENCODE_EXPERIMENTAL switch carried by the login shell", () => {
    // Regression for B-01: the engine also consumes the root toggle
    // OPENCODE_EXPERIMENTAL (no trailing underscore). It must not leak from the
    // login shell into the main process env.
    shell = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      OPENCODE_EXPERIMENTAL: "true",
    }
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH", "OPENCODE_EXPERIMENTAL"])
    clearOpencodeEnv()

    try {
      preferAppEnv()

      expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
      expect(process.env.OPENCODE_EXPERIMENTAL).toBeUndefined()
    } finally {
      shell = null
      restoreKeys(saved)
    }
  })

  test("removes a pre-existing root OPENCODE_EXPERIMENTAL switch from process.env", () => {
    shell = { PATH: "/opt/homebrew/bin:/usr/bin:/bin" }
    const saved = snapshotKeys([...OPENCODE_KEYS, "PATH", "OPENCODE_EXPERIMENTAL"])
    clearOpencodeEnv()
    process.env.OPENCODE_EXPERIMENTAL = "true"

    try {
      preferAppEnv()

      expect(process.env.OPENCODE_EXPERIMENTAL).toBeUndefined()
    } finally {
      shell = null
      restoreKeys(saved)
    }
  })
})

describe("sidecar credentials cleanup", () => {
  test("clearSidecarCredentials deletes both credential keys from process.env", () => {
    process.env.ELLAMAKA_SERVER_PASSWORD = "secret"
    process.env.ELLAMAKA_SERVER_USERNAME = "ellamaka"

    try {
      clearSidecarCredentials()

      expect(process.env.ELLAMAKA_SERVER_PASSWORD).toBeUndefined()
      expect(process.env.ELLAMAKA_SERVER_USERNAME).toBeUndefined()
    } finally {
      delete process.env.ELLAMAKA_SERVER_PASSWORD
      delete process.env.ELLAMAKA_SERVER_USERNAME
    }
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
    process.env.ELLAMAKA_SERVER_PASSWORD = "secret"
    process.env.ELLAMAKA_SERVER_USERNAME = "ellamaka"

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
    process.env.ELLAMAKA_SERVER_PASSWORD = "secret"

    try {
      await expect(listenThenClearCredentials(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
      expect(process.env.ELLAMAKA_SERVER_PASSWORD).toBeUndefined()
    } finally {
      delete process.env.ELLAMAKA_SERVER_PASSWORD
    }
  })
})
