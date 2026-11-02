import type { Listener } from "../../server/server"
import type { DshEngineHandle } from "./dsh-mount"
import { Global } from "@wopal/ellamaka-core/global"
import { readSetupState } from "@wopal/wopalspace"
import * as Log from "@wopal/ellamaka-core/util/log"

/**
 * Whether this host already finished application Setup.
 *
 * A Setup that is absent, corrupt, or records `completed !== true` means the
 * user has not been through Onboarding yet. In that state the DSH runtime has
 * no consumer: there is no Workbench to serve. Mounting it early would spend
 * the closure download behind a page the user cannot see, and — worse — would
 * seed profiles from an Ontology that has not been installed yet.
 *
 * Reading the state file is a pure local read; it must never start a server or
 * touch the Ontology.
 */
export function setupCompleted(wopalHome: string = Global.Path.wopalHome): boolean {
  const state = readSetupState(wopalHome)
  if (state.status !== "ok") return false
  return state.state.completed
}

export interface DshMountController {
  /**
   * Mount the DSH engine if it is not mounted yet, and report whether the
   * runtime is (now) mounted.
   *
   * Idempotent by construction: concurrent callers join the in-flight mount
   * instead of racing `mountDshEngine` twice. A failed mount is not cached —
   * the next caller retries, so a transient closure download failure does not
   * permanently disable the runtime for this process.
   */
  ensure(): Promise<boolean>
  /** The handle of a successful mount, for shutdown. */
  current(): DshEngineHandle | undefined
  dispose(): Promise<void>
}

/**
 * Own the single DSH mount of one serve process.
 *
 * The serve command defers the mount when Setup is unfinished
 * (DESIGN-onboarding.md `## Core Preparation Timing`): Onboarding prepares the
 * runtime in a visible step, then the user opts into Workbench, and only then
 * does this controller mount. Every entry that needs DSH calls `ensure()`
 * first, which is the same "prepare on use" fallback the design requires —
 * not a second code path.
 */
export function createDshMountController(input: {
  server: Listener
  cors?: readonly string[]
  wopalHome?: string
  /** Test seam for proving that mount resolves Home at use time, not construction time. */
  resolveWopalHome?: () => string
  mountEngine?: (wopalHome: string) => Promise<DshEngineHandle | undefined>
}): DshMountController {
  const resolveWopalHome = input.resolveWopalHome ?? (() => input.wopalHome ?? Global.Path.wopalHome)
  let handle: DshEngineHandle | undefined
  let inflight: Promise<boolean> | undefined
  let disposed = false

  const mount = async (): Promise<boolean> => {
    if (handle) return true
    if (disposed) return false
    const wopalHome = resolveWopalHome()
    const mounted = input.mountEngine
      ? await input.mountEngine(wopalHome)
      : await import("./dsh-mount").then(({ mountDshEngine }) =>
          mountDshEngine(input.server, { ...(input.cors === undefined ? {} : { cors: input.cors }), wopalHome }),
        )
    if (!mounted) return false
    if (disposed) {
      await mounted.dispose()
      return false
    }
    handle = mounted
    return true
  }

  return {
    async ensure() {
      if (handle) return true
      if (disposed) return false
      if (inflight) return inflight
      inflight = mount()
        .catch((error) => {
          Log.Default.error("dsh mount failed", {
            error: error instanceof Error ? error.message : String(error),
          })
          return false
        })
        .finally(() => {
          inflight = undefined
        })
      return inflight
    },
    current() {
      return handle
    },
    async dispose() {
      disposed = true
      await inflight
      const active = handle
      handle = undefined
      await active?.dispose()
    },
  }
}
