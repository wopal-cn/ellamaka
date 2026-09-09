import { describe, expect } from "bun:test"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Pty } from "../../src/pty"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { testEffect, pollWithTimeout } from "../lib/effect"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import * as ptyNode from "../../src/pty/pty.node"

const it = testEffect(
  Pty.layer.pipe(
    Layer.provideMerge(Bus.layer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Plugin.defaultLayer),
    Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
  ),
)

const ptyTest = process.platform === "win32" ? it.live.skip : it.live

// A child that ignores SIGHUP. `trap '' HUP` sets SIG_IGN, which persists across
// exec, so the resulting `sleep` ignores SIGHUP. The default kill signal (SIGHUP
// to a single pid) cannot kill it; only a process-group SIGKILL can. This makes
// the test distinguish force-kill from the baseline signal semantics.
const HUP_IMMUNE = ["-c", "trap '' HUP; exec sleep 300"]

// Wait until the given pid no longer exists (process.kill(pid, 0) throws ESRCH).
const waitDead = (pid: number) =>
  pollWithTimeout(
    Effect.sync(() => {
      try {
        process.kill(pid, 0)
        return undefined
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ESRCH" ? (true as const) : undefined
      }
    }),
    "child process still alive after dispose",
  )

describe("pty dispose kill", () => {
  ptyTest(
    "kills a HUP-immune child with SIGKILL when the instance is disposed (bun adapter)",
    () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const pty = yield* Pty.Service
          const info = yield* pty.create({ command: "sh", args: HUP_IMMUNE })

          // Windows ConPTY assigns the pid asynchronously; on other platforms it
          // is already non-zero at create time. Poll until it is assigned.
          const pid = yield* pollWithTimeout(
            Effect.sync(() => (info.pid > 0 ? info.pid : undefined)),
            "pty pid never assigned",
          )

          // Trigger the InstanceState finalizer (disposeAllInstances) which must
          // SIGKILL the running child process group.
          yield* Effect.promise(() => disposeAllInstances())

          yield* waitDead(pid)
        }),
      ),
  )

  ptyTest(
    "kills a HUP-immune child with SIGKILL via the node adapter kill()",
    () =>
      Effect.gen(function* () {
        const proc = ptyNode.spawn("sh", HUP_IMMUNE, { name: "xterm-256color" })
        const pid = proc.pid
        expect(pid).toBeGreaterThan(0)

        proc.kill("SIGKILL")

        yield* waitDead(pid)
      }),
  )
})
