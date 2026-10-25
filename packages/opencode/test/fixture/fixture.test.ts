import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@wopal/ellamaka-core/global"
import { tmpdir, writeGlobalTestConfig, removeGlobalTestConfig } from "./fixture"

const settings = path.join(Global.Path.config, "settings.jsonc")

describe("global test config ownership", () => {
  test("uses one complete config and restores the previous owner", async () => {
    const first = await writeGlobalTestConfig({ username: "first", model: "first/model" })
    const second = await writeGlobalTestConfig({ username: "second" })
    try {
      expect(await Bun.file(settings).json()).toEqual({
        $schema: "https://opencode.ai/config.json",
        username: "second",
      })
      await removeGlobalTestConfig(second)
      expect((await Bun.file(settings).json()).model).toBe("first/model")
    } finally {
      await removeGlobalTestConfig(second)
      await removeGlobalTestConfig(first)
    }
  })

  test("releasing an older owner cannot erase an active config", async () => {
    const first = await writeGlobalTestConfig({ username: "first" })
    const second = await writeGlobalTestConfig({ username: "second" })
    try {
      await removeGlobalTestConfig(first)
      expect((await Bun.file(settings).json()).username).toBe("second")
      await removeGlobalTestConfig(second)
      expect(await Bun.file(settings).exists()).toBe(false)
    } finally {
      await removeGlobalTestConfig(first)
      await removeGlobalTestConfig(second)
    }
  })

  test("serializes overlapping writes and cleanup without corrupting the file", async () => {
    const owners = await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeGlobalTestConfig({ username: String(index) })),
    )
    try {
      expect((await Bun.file(settings).json()).username).toBe("11")
      await Promise.all(owners.slice(0, -1).map(removeGlobalTestConfig))
      expect((await Bun.file(settings).json()).username).toBe("11")
    } finally {
      await Promise.all(owners.map(removeGlobalTestConfig))
    }
    expect(await Bun.file(settings).exists()).toBe(false)
  })

  test("rolls back an owner when its file write fails", async () => {
    const first = await writeGlobalTestConfig({ username: "first" })
    await fs.rm(settings, { force: true })
    // A directory at the file path makes writeFile fail deterministically.
    await fs.mkdir(settings)
    try {
      await writeGlobalTestConfig({ username: "ghost" }).then(
        () => expect.unreachable("expected the blocked settings path to reject"),
        (error) => expect(error).toBeInstanceOf(Error),
      )
    } finally {
      await fs.rm(settings, { recursive: true, force: true })
    }
    await removeGlobalTestConfig(first)
    // If the failed acquire had left an owner behind, releasing `first` would
    // write the ghost config back instead of removing the file.
    expect(await Bun.file(settings).exists()).toBe(false)
  })
})

describe("tmpdir", () => {
  test("disables fsmonitor for git fixtures", async () => {
    await using tmp = await tmpdir({ git: true })

    const value = (await $`git config core.fsmonitor`.cwd(tmp.path).quiet().text()).trim()
    expect(value).toBe("false")
  })

  test("removes directories on dispose", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path

    await tmp[Symbol.asyncDispose]()

    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })
})
