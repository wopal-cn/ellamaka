import { join } from "node:path"
import { bindWopalHome } from "@wopal/ellamaka-core/global"

/**
 * Absolute product paths for one Desktop run.
 *
 * Desktop resolves the effective product root exactly once per launch (the
 * Host Environment snapshot) and every consumer derives its location from that
 * root: the sidecar env, the DSH log paths the sidecar is told about, and the
 * IPC state directory. No consumer re-probes a login shell for WOPAL_HOME.
 */
export interface DesktopProductPaths {
  /** Effective WOPAL_HOME for this run. */
  home: string
  /** Official DSH Home (`$WOPAL_HOME/dsh/home`). */
  dshHome: string
  /** Directory holding DSH profile runtime logs. */
  dshLogDir: string
  /** Unified DSH runtime log file. */
  dshRuntimeLogFile: string
}

export function resolveDesktopProductPaths(home: string): DesktopProductPaths {
  const dshLogDir = join(home, "logs")
  return {
    home,
    dshHome: join(home, "dsh", "home"),
    dshLogDir,
    dshRuntimeLogFile: join(dshLogDir, "dsh-runtime.log"),
  }
}

/**
 * Bind the resolved product root into the process-local product path view
 * before anything reads it.
 *
 * `@wopal/ellamaka-core/global` computes `Global.Path` once at module load, so
 * setting `process.env.WOPAL_HOME` after that point would leave the initialized
 * view (and the Flock state root) on the pre-resolution value. `bindWopalHome`
 * is the owning Home-binding API: it expands/normalizes the root, writes it to
 * `process.env.WOPAL_HOME`, and rebases `Global.Path`. Call this before the
 * sidecar spawn, IPC registration, and log roots are consumed.
 */
export function bindDesktopProductRoot(home: string): DesktopProductPaths {
  return resolveDesktopProductPaths(bindWopalHome(home))
}
