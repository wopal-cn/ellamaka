import { createRequire, syncBuiltinESMExports } from "node:module"

interface DiagnosticUtil {
  getSystemErrorName(code: number): string
  getSystemErrorMessage?(code: number): string
}

/** Initialize the standard diagnostic API before any official providers import it. */
export function initializeNodeDiagnostics(
  util: DiagnosticUtil = createRequire(import.meta.url)("node:util"),
  sync: () => void = syncBuiltinESMExports,
): void {
  if (typeof util.getSystemErrorMessage === "function") return
  util.getSystemErrorMessage = (code) => util.getSystemErrorName(code)
  sync()
}
