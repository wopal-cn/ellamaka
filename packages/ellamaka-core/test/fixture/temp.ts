import { existsSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** Allocate test-owned files outside the repository and clean them in the caller's finally block. */
export function temporaryDirectory(prefix: string) {
  let current = path.resolve(import.meta.dir, "../../../..")
  for (;;) {
    const spaceTmp = path.join(current, ".wopal-space", ".tmp")
    if (existsSync(spaceTmp)) return mkdtempSync(path.join(spaceTmp, prefix))
    const parent = path.dirname(current)
    if (parent === current) {
      const userTmp = path.join(os.homedir(), "tmp")
      return mkdtempSync(path.join(existsSync(userTmp) ? userTmp : os.tmpdir(), prefix))
    }
    current = parent
  }
}
