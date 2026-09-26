// Entry-behavior probes for log directory routing.
//
// These spawn the REAL CLI entry inside a throwaway WopalSpace to pin the
// contract that in-process unit tests cannot: the entry must not rewrite the
// dev log directory, the tui role follows the space, and the serve role stays
// in the global log domain.
//
// The `dir()` routing matrix below runs `Log.init` directly against real
// directories and process env — filesystem-live behavior, so it lives in this
// integration directory per the package test-layer contract
// (`packages/opencode/AGENTS.md` "Testing").
import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Global } from "@wopal/ellamaka-core/global"
import * as Log from "@wopal/ellamaka-core/util/log"
import { cleanupProbes, makeProbe, probeEnv, runCli, startServe } from "../lib/log-probe"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

afterAll(cleanupProbes)

/**
 * The `dir()` routing matrix (DESIGN-logging.md "角色分域"): machine roles
 * (serve/sidecar) always write the global domain `$WOPAL_HOME/logs`; the
 * interactive role (tui, including the role-less default) follows the space
 * when one is set. The dev-only `WOPAL_DEBUG_LOG_DIR` override wins for every
 * role in the dev channel and is ignored in release.
 */
const routingEnv = () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    const spaceRoot = process.env.WOPAL_SPACE_ROOT
    const debugLogDir = process.env.WOPAL_DEBUG_LOG_DIR
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Global.Path.log = log
        if (spaceRoot === undefined) delete process.env.WOPAL_SPACE_ROOT
        else process.env.WOPAL_SPACE_ROOT = spaceRoot
        if (debugLogDir === undefined) delete process.env.WOPAL_DEBUG_LOG_DIR
        else process.env.WOPAL_DEBUG_LOG_DIR = debugLogDir
      }),
    )
  })

test("tui-side entry keeps space logs in the space and honors an explicit dev directory", async () => {
  // Scenario 1: no override — a non-server command inside a space logs to the
  // space's `.wopal-space/logs/ellamaka-dev-tui.log`.
  {
    const { root, home } = makeProbe()
    const result = runCli(["debug", "config", "--log-level", "INFO"], {
      cwd: root,
      env: probeEnv(home),
    })
    expect(result.exitCode).toBe(0)
    const logFile = join(root, ".wopal-space", "logs", "ellamaka-dev-tui.log")
    expect(existsSync(logFile)).toBe(true)
    expect(readFileSync(logFile, "utf8").length).toBeGreaterThan(0)
  }

  // Scenario 2: an explicit `WOPAL_DEBUG_LOG_DIR` is honored as-is — the
  // entry must not rewrite it back to the space directory.
  {
    const { root, home } = makeProbe()
    const override = join(root, "override-logs")
    const result = runCli(["debug", "config", "--log-level", "INFO"], {
      cwd: root,
      env: probeEnv(home, { WOPAL_DEBUG_LOG_DIR: override }),
    })
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(override, "ellamaka-dev-tui.log"))).toBe(true)
    const spaceLogs = join(root, ".wopal-space", "logs")
    const spaceEntries = existsSync(spaceLogs) ? readdirSync(spaceLogs) : []
    expect(spaceEntries).not.toContain("ellamaka-dev-tui.log")
  }
}, 120_000)

test("serve-side entry stays in the global log domain with a role-derived dev file", async () => {
  const { root, home } = makeProbe()
  const { proc, url } = await startServe(root, probeEnv(home))
  try {
    // Trigger an instance request so the serve process writes instance records.
    const response = await fetch(new URL("/config", url))
    expect(response.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 500))
  } finally {
    proc.kill()
    await proc.exited
  }

  // The serve record lands in the global domain under its role-derived dev
  // name; the space's log directory must not receive it.
  const globalLog = join(home, "logs", "ellamaka-dev-serve.log")
  expect(existsSync(globalLog)).toBe(true)
  expect(readFileSync(globalLog, "utf8").length).toBeGreaterThan(0)

  const spaceLogs = join(root, ".wopal-space", "logs")
  const spaceEntries = existsSync(spaceLogs) ? readdirSync(spaceLogs) : []
  expect(spaceEntries).not.toContain("ellamaka-dev-serve.log")
  expect(spaceEntries).not.toContain("ellamaka-dev-tui.log")
}, 120_000)

// --- dir() routing matrix (filesystem-live; see the file header) ---

import { Effect } from "effect"

it.live("role routing: machine roles stay in the global log dir inside a space", () =>
  Effect.gen(function* () {
    yield* routingEnv()
    const fallback = yield* tmpdirScoped()
    const space = yield* tmpdirScoped()
    Global.Path.log = fallback
    process.env.WOPAL_SPACE_ROOT = space
    delete process.env.WOPAL_DEBUG_LOG_DIR

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "serve" }))
    expect(join(Log.file(), "..")).toBe(fallback)

    yield* Effect.promise(() => Log.init({ print: false, dev: true, role: "sidecar" }))
    expect(join(Log.file(), "..")).toBe(fallback)
  }),
)

it.live("role routing: tui follows the space in release and in dev", () =>
  Effect.gen(function* () {
    yield* routingEnv()
    const fallback = yield* tmpdirScoped()
    const space = yield* tmpdirScoped()
    Global.Path.log = fallback
    process.env.WOPAL_SPACE_ROOT = space
    delete process.env.WOPAL_DEBUG_LOG_DIR

    const expected = join(space, ".wopal-space", "logs")

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "tui" }))
    expect(join(Log.file(), "..")).toBe(expected)

    yield* Effect.promise(() => Log.init({ print: false, dev: true, role: "tui" }))
    expect(join(Log.file(), "..")).toBe(expected)

    // The role-less default behaves as the interactive role.
    yield* Effect.promise(() => Log.init({ print: false, dev: false }))
    expect(join(Log.file(), "..")).toBe(expected)
  }),
)

it.live("role routing: tui without a space falls back to the global log dir", () =>
  Effect.gen(function* () {
    yield* routingEnv()
    const fallback = yield* tmpdirScoped()
    Global.Path.log = fallback
    delete process.env.WOPAL_SPACE_ROOT
    delete process.env.WOPAL_DEBUG_LOG_DIR

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "tui" }))
    expect(join(Log.file(), "..")).toBe(fallback)
  }),
)

it.live("dev override: wins for every role in dev and is ignored in release", () =>
  Effect.gen(function* () {
    yield* routingEnv()
    const fallback = yield* tmpdirScoped()
    const space = yield* tmpdirScoped()
    const override = yield* tmpdirScoped()
    Global.Path.log = fallback
    process.env.WOPAL_SPACE_ROOT = space
    process.env.WOPAL_DEBUG_LOG_DIR = override

    // Dev channel: the explicit directory wins, including for machine roles.
    yield* Effect.promise(() => Log.init({ print: false, dev: true, role: "serve" }))
    expect(join(Log.file(), "..")).toBe(override)

    yield* Effect.promise(() => Log.init({ print: false, dev: true, role: "tui" }))
    expect(join(Log.file(), "..")).toBe(override)

    // Release channel: the override is ignored; role rules decide.
    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "tui" }))
    expect(join(Log.file(), "..")).toBe(join(space, ".wopal-space", "logs"))

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "serve" }))
    expect(join(Log.file(), "..")).toBe(fallback)
  }),
)

it.live("dev naming: the default dev file derives from the role", () =>
  Effect.gen(function* () {
    yield* routingEnv()
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir
    delete process.env.WOPAL_SPACE_ROOT
    delete process.env.WOPAL_DEBUG_LOG_DIR

    for (const role of ["serve", "tui", "sidecar"] as const) {
      yield* Effect.promise(() => Log.init({ print: false, dev: true, role }))
      expect(Log.file().split("/").pop()).toBe(`ellamaka-dev-${role}.log`)
    }

    // An explicit devFile stays authoritative over the role-derived default.
    yield* Effect.promise(() => Log.init({ print: false, dev: true, role: "tui", devFile: "custom-dev.log" }))
    expect(Log.file().split("/").pop()).toBe("custom-dev.log")
  }),
)
