import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "../src/global"
import { scopedEnv } from "./fixture/process-env"

function scopedGlobalHome(): Disposable {
  const previous = Global.Path.wopalHome
  return { [Symbol.dispose]: () => Global.bindWopalHome(previous) }
}

describe("Global.bindWopalHome", () => {
  test("rebases every derived path and existing Global service views without creating the Home", () => {
    using _environment = scopedEnv({ WOPAL_HOME: process.env.WOPAL_HOME })
    using _home = scopedGlobalHome()
    const target = path.join(os.tmpdir(), `ellamaka-global-home-${process.pid}-${Date.now()}`)
    const service = Global.make()

    expect(fs.existsSync(target)).toBe(false)
    Global.bindWopalHome(target)

    expect(Global.Path.wopalHome).toBe(target)
    expect(Global.Path.data).toBe(path.join(target, "ellamaka", "data"))
    expect(Global.Path.cache).toBe(path.join(target, "ellamaka", "cache"))
    expect(Global.Path.config).toBe(path.join(target, "config"))
    expect(Global.Path.state).toBe(path.join(target, "ellamaka", "state"))
    expect(Global.Path.log).toBe(path.join(target, "logs"))
    expect(Global.Path.bin).toBe(path.join(target, "ellamaka", "cache", "bin"))
    expect(Global.Path.repos).toBe(path.join(target, "ellamaka", "data", "repos"))
    expect(service.wopalHome).toBe(target)
    expect(service.data).toBe(Global.Path.data)
    expect(process.env.WOPAL_HOME).toBe(target)
    expect(fs.existsSync(target)).toBe(false)
  })
})
