import { initializeNodeDiagnostics } from "./node-diagnostics.js"

// Bun's ESM builtin namespace is established on its first import. Install the
// public diagnostic fallback before any host/UI preload imports node:util.
initializeNodeDiagnostics()

// A runtime plugin is process-local. The source-Bun subprocess bootstrap is
// a fresh process too, so install its compatibility before runner.js imports
// the official provider. Parent-only installation cannot cross exec/spawn.
if (process.versions.bun !== undefined) {
  const { installBunSubprocessCompatibility } = await import("./bun-subprocess.js")
  installBunSubprocessCompatibility()
}
