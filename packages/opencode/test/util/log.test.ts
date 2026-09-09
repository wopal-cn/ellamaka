import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Global } from "@wopal/ellamaka-core/global"
import * as Log from "@wopal/ellamaka-core/util/log"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

function files(dir: string) {
  return Effect.gen(function* () {
    let last = ""
    let same = 0

    for (let i = 0; i < 50; i++) {
      const list = yield* Effect.promise(() => fs.readdir(dir).then((files) => files.sort()))
      const next = JSON.stringify(list)
      same = next === last ? same + 1 : 0
      if (same >= 2 && list.length === 11) return list
      last = next
      yield* Effect.sleep("10 millis")
    }

    return yield* Effect.promise(() => fs.readdir(dir).then((files) => files.sort()))
  })
}

it.live("init cleanup keeps the newest timestamped logs", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)

    yield* Effect.all(list.map((file) => Effect.promise(() => fs.writeFile(path.join(dir, file), file))))

    yield* Effect.promise(() => Log.init({ print: false, dev: false }))
    // The log file is created lazily on first write; a write also triggers cleanup.
    Log.Default.info("trigger lazy init")

    const next = yield* files(dir)

    expect(next).not.toContain(list[0]!)
    expect(next).toContain(list.at(-1)!)
  }),
)

it.live("local dev log uses the WopalSpace log directory", () =>
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

    const fallback = yield* tmpdirScoped()
    const space = yield* tmpdirScoped()
    Global.Path.log = fallback
    process.env.WOPAL_SPACE_ROOT = space
    delete process.env.WOPAL_DEBUG_LOG_DIR

    yield* Effect.promise(() => Log.init({ print: false, dev: true, devFile: "ellamaka-dev-tui.log" }))

    expect(Log.file()).toBe(path.join(space, ".wopal-space", "logs", "ellamaka-dev-tui.log"))
  }),
)

it.live("configured local dev log is not truncated twice for the same run", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    const runID = process.env.OPENCODE_RUN_ID
    const initialized = process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
    const debugLogDir = process.env.WOPAL_DEBUG_LOG_DIR
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Global.Path.log = log
        if (runID === undefined) delete process.env.OPENCODE_RUN_ID
        else process.env.OPENCODE_RUN_ID = runID
        if (initialized === undefined) delete process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
        else process.env.OPENCODE_LOG_INITIALIZED_RUN_ID = initialized
        if (debugLogDir === undefined) delete process.env.WOPAL_DEBUG_LOG_DIR
        else process.env.WOPAL_DEBUG_LOG_DIR = debugLogDir
      }),
    )

    const dir = yield* tmpdirScoped()
    Global.Path.log = dir
    process.env.WOPAL_DEBUG_LOG_DIR = dir
    process.env.OPENCODE_RUN_ID = "run-1"
    delete process.env.OPENCODE_LOG_INITIALIZED_RUN_ID

    yield* Effect.promise(() => Log.init({ print: false, dev: true, devFile: "ellamaka-dev-tui.log" }))
    yield* Effect.promise(() => fs.writeFile(path.join(dir, "ellamaka-dev-tui.log"), "main startup\n"))
    yield* Effect.promise(() => Log.init({ print: false, dev: true, devFile: "ellamaka-dev-tui.log" }))

    expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "ellamaka-dev-tui.log"), "utf8"))).toContain(
      "main startup",
    )
  }),
)

it.live("non-dev init with role produces role-prefixed filename", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "serve" }))

    const file = Log.file()
    expect(file).toMatch(/serve-\d{4}-\d{2}-\d{2}T\d{6}\.log$/)
  }),
)

it.live("non-dev init without role produces local timestamp filename", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    yield* Effect.promise(() => Log.init({ print: false, dev: false }))

    const file = Log.file()
    expect(file).toMatch(/\d{4}-\d{2}-\d{2}T\d{6}\.log$/)
  }),
)

it.live("cleanup matches role-prefixed files", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    const list = Array.from(
      { length: 12 },
      (_, i) => `serve-2000-01-${String(i + 1).padStart(2, "0")}T000000.log`,
    )

    yield* Effect.all(list.map((file) => Effect.promise(() => fs.writeFile(path.join(dir, file), file))))

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "serve" }))
    // A write triggers lazy file creation and cleanup.
    Log.Default.info("trigger lazy init")

    const next = yield* files(dir)

    expect(next).not.toContain(list[0]!)
    expect(next).toContain(list.at(-1)!)
  }),
)

it.live("init without any log write does not create a log file", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "tui" }))

    const file = Log.file()
    expect(file).toMatch(/tui-\d{4}-\d{2}-\d{2}T\d{6}\.log$/)
    const exists = yield* Effect.promise(() =>
      fs.access(file).then(() => true).catch(() => false),
    )
    expect(exists).toBe(false)
  }),
)

it.live("first log write creates the file and cleanup runs once", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)
    yield* Effect.all(list.map((file) => Effect.promise(() => fs.writeFile(path.join(dir, file), file))))

    yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "tui" }))
    Log.Default.info("first line")

    const next = yield* files(dir)
    // Cleanup keeps the newest 10 timestamped files, plus the new tui file.
    expect(next.length).toBe(11)
    expect(next).toContain(list.at(-1)!)
    expect(next).not.toContain(list[0]!)
    expect(next).not.toContain(list[1]!)

    const logFile = next.find((f) => f.startsWith("tui-"))
    expect(logFile).toBeDefined()
    const content = yield* Effect.promise(() => fs.readFile(path.join(dir, logFile!), "utf8"))
    expect(content).toContain("first line")
  }),
)
