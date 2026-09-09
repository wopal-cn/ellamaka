import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Global } from "@wopal/ellamaka-core/global"
import { ConfigPaths } from "@/config/paths"
import { wopalSpaceDirectories } from "@/config/wopal-space-settings"
import path from "path"
import fs from "fs/promises"
import os from "os"

const infraLayer = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const run = <A, E>(effect: Effect.Effect<A, E, AppFileSystem.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(infraLayer, AppFileSystem.defaultLayer))))

const originalWopalSpace = process.env.WOPAL_SPACE
const originalDisableProjectConfig = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
const originalWopalHome = Global.Path.wopalHome
const originalConfig = Global.Path.config

afterEach(() => {
  if (originalWopalSpace === undefined) delete process.env.WOPAL_SPACE
  else process.env.WOPAL_SPACE = originalWopalSpace
  if (originalDisableProjectConfig === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = originalDisableProjectConfig
  if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
  Global.Path.wopalHome = originalWopalHome
  Global.Path.config = originalConfig
})

beforeEach(() => {
  // Normal mode: clear WOPAL_SPACE and disable project config scanning
  delete process.env.WOPAL_SPACE
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
  delete process.env.OPENCODE_CONFIG_DIR
})

describe("ConfigPaths.directories", () => {
  test("normal mode includes wopalHome at the end (override)", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "paths-test-"))
    try {
      const wopalHome = path.join(tmpBase, "wopal-home")
      const configDir = path.join(wopalHome, "config")
      const projectDir = path.join(tmpBase, "project")
      await fs.mkdir(wopalHome, { recursive: true })
      await fs.mkdir(configDir, { recursive: true })
      await fs.mkdir(projectDir, { recursive: true })

      Global.Path.wopalHome = wopalHome
      Global.Path.config = configDir

      const dirs = await run(ConfigPaths.directories(projectDir))

      // wopalHome must be present and at the end (last = highest priority override)
      expect(dirs).toContain(wopalHome)
      expect(dirs[dirs.length - 1]).toBe(wopalHome)
      // config dir is also present but not at the end
      expect(dirs).toContain(configDir)
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  })

  test("normal mode does not add wopalHome when it equals config dir", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "paths-test-"))
    try {
      const sameDir = path.join(tmpBase, "shared")
      await fs.mkdir(sameDir, { recursive: true })

      // Edge case: wopalHome == config (no separate capability root)
      Global.Path.wopalHome = sameDir
      Global.Path.config = sameDir

      const dirs = await run(ConfigPaths.directories(tmpBase))

      // Should not duplicate; wopalHome excluded since it equals config
      expect(dirs.filter((d) => d === sameDir)).toHaveLength(1)
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  })

  test("normal mode does not add wopalHome when directory does not exist", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "paths-test-"))
    try {
      const nonexistent = path.join(tmpBase, "does-not-exist")
      const configDir = path.join(tmpBase, "config")
      await fs.mkdir(configDir, { recursive: true })

      Global.Path.wopalHome = nonexistent
      Global.Path.config = configDir

      const dirs = await run(ConfigPaths.directories(tmpBase))

      expect(dirs).not.toContain(nonexistent)
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  })

  test("includes wopalHome for a normal-mode instance when the server process enables WOPAL_SPACE", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "paths-test-"))
    try {
      const wopalHome = path.join(tmpBase, "wopal-home")
      const configDir = path.join(wopalHome, "config")
      const projectDir = path.join(tmpBase, "project")
      await fs.mkdir(wopalHome, { recursive: true })
      await fs.mkdir(configDir, { recursive: true })
      await fs.mkdir(projectDir, { recursive: true })

      process.env.WOPAL_SPACE = "1"
      Global.Path.wopalHome = wopalHome
      Global.Path.config = configDir

      const dirs = await run(ConfigPaths.directories(projectDir))

      // Per-directory mode detection happens before ConfigPaths.directories.
      // A process-level flag must not hide global plugins from General sessions.
      expect(dirs).toContain(wopalHome)
      expect(dirs[dirs.length - 1]).toBe(wopalHome)
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  })
})

describe("wopalSpaceDirectories", () => {
  test("uses Global.Path.wopalHome instead of hardcoded ~/.wopal", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "wopal-space-dirs-test-"))
    try {
      const customWopalHome = path.join(tmpBase, "custom-wopal-home")
      await fs.mkdir(customWopalHome, { recursive: true })

      const saved = Global.Path.wopalHome
      Global.Path.wopalHome = customWopalHome
      try {
        const result = wopalSpaceDirectories([])
        // customWopalHome must appear (proving it reads Global.Path.wopalHome, not hardcoded ~/.wopal)
        expect(result).toContain(customWopalHome)
      } finally {
        Global.Path.wopalHome = saved
      }
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  })

  test("does not add wopalHome when it does not exist on disk", () => {
    const tmpBase = path.join(os.tmpdir(), "nonexistent-wopal-home-" + process.pid)
    const saved = Global.Path.wopalHome
    Global.Path.wopalHome = tmpBase
    try {
      const result = wopalSpaceDirectories([])
      expect(result).not.toContain(tmpBase)
    } finally {
      Global.Path.wopalHome = saved
    }
  })

  test("deduplicates config, wopalHome, and localWopalDirs", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "wopal-space-dirs-test-"))
    try {
      const wopalHome = path.join(tmpBase, "wopal-home")
      const configDir = path.join(wopalHome, "config")
      await fs.mkdir(wopalHome, { recursive: true })
      await fs.mkdir(configDir, { recursive: true })

      const savedWopal = Global.Path.wopalHome
      const savedConfig = Global.Path.config
      Global.Path.wopalHome = wopalHome
      Global.Path.config = configDir
      try {
        // localWopalDirs duplicates wopalHome — must be deduped
        const result = wopalSpaceDirectories([wopalHome])
        expect(result.filter((d) => d === wopalHome)).toHaveLength(1)
        expect(result.filter((d) => d === configDir)).toHaveLength(1)
      } finally {
        Global.Path.wopalHome = savedWopal
        Global.Path.config = savedConfig
      }
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true })
    }
  })
})
