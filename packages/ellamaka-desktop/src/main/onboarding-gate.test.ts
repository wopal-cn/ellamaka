import { describe, expect, test } from "bun:test"
import { isAbsolute, join } from "node:path"
import { Path, bindWopalHome } from "@wopal/ellamaka-core/global"
import { scopedEnv } from "../../test/fixture/process-env"
import { bindDesktopProductRoot, resolveDesktopProductPaths } from "./onboarding-gate"

describe("resolveDesktopProductPaths", () => {
  test("derives every Desktop product path from the resolved root", () => {
    const home = join("/", "opt", "wopal-home")
    const paths = resolveDesktopProductPaths(home)

    expect(paths.home).toBe(home)
    expect(paths.dshHome).toBe(join(home, "dsh", "home"))
    expect(paths.dshLogDir).toBe(join(home, "logs"))
    expect(paths.dshRuntimeLogFile).toBe(join(home, "logs", "dsh-runtime.log"))
    expect(isAbsolute(paths.dshHome)).toBe(true)
    expect(isAbsolute(paths.dshLogDir)).toBe(true)
  })

  test("keeps a non-default root verbatim instead of falling back to ~/.wopal", () => {
    const home = join("/", "tmp", "isolated-wopal")
    expect(resolveDesktopProductPaths(home).home).toBe(home)
  })
})

describe("bindDesktopProductRoot", () => {
  test("rebases the already-initialized Global.Path view onto the resolved root", () => {
    // Global.Path is computed once at module load, so the Desktop startup must
    // rebind it; assigning process.env.WOPAL_HOME alone leaves this view stale.
    const previous = Path.wopalHome
    const home = join("/", "tmp", "wopal-bound-root")
    using _env = scopedEnv({ WOPAL_HOME: undefined })

    try {
      const paths = bindDesktopProductRoot(home)

      expect(process.env.WOPAL_HOME).toBe(home)
      expect(Path.wopalHome).toBe(home)
      expect(Path.data).toBe(join(home, "ellamaka", "data"))
      expect(Path.state).toBe(join(home, "ellamaka", "state"))
      expect(Path.log).toBe(join(home, "logs"))
      expect(Path.bin).toBe(join(home, "ellamaka", "cache", "bin"))
      expect(Path.repos).toBe(join(home, "ellamaka", "data", "repos"))
      expect(paths).toEqual(resolveDesktopProductPaths(home))
    } finally {
      // The binding is process-global; restore it so later test files see the
      // value their own module load produced.
      bindWopalHome(previous)
    }
  })

  test("moves the view off a previously bound root", () => {
    const previous = Path.wopalHome
    const first = join("/", "tmp", "wopal-root-a")
    const second = join("/", "tmp", "wopal-root-b")
    using _env = scopedEnv({ WOPAL_HOME: first })

    try {
      bindDesktopProductRoot(first)
      expect(Path.wopalHome).toBe(first)

      bindDesktopProductRoot(second)
      expect(Path.wopalHome).toBe(second)
      expect(Path.log).toBe(join(second, "logs"))
      expect(process.env.WOPAL_HOME).toBe(second)
    } finally {
      bindWopalHome(previous)
    }
  })
})
